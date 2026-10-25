/**
 * Which unshielded UTxOs a transfer spends.
 *
 * Its own module because it is pure: `./send.ts` reaches the native bridge and the service, which
 * drags `expo-modules-core` into any test that imports it, and this is the half worth testing —
 * picking the wrong output costs money in a way nothing downstream can correct.
 *
 * @module
 */

import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'

/**
 * How many inputs one unshielded transfer may spend.
 *
 * **Sixty-four**, and the binding constraint is no longer the one that caused the original failure.
 *
 * A NIGHT input costs an unamortized depth-32 Merkle insert (~2.4 ms of synthetic cost) for the
 * ledger's dust-generation bookkeeping. That lands in the transaction's *guaranteed* segment cost —
 * and `time_to_dismiss` counts `application_cost(..).0`, the guaranteed half, against
 * `max(2 µs × size, 15 ms)`. With the offer in the guaranteed slot only **four** inputs fit, which is
 * how a 46-input transfer was rejected on preprod as `Custom error: 168`
 * (`MalformedError::FeeCalculation`). Upstream hit the same wall and says the same thing:
 * midnight-wallet's `swap.undeployed.test.ts` is skipped over this error, noting the fix is to put
 * payments in the fallible section.
 *
 * The offer is in the fallible segment now (`@pnyx/midnight-native`), so that per-input cost is not
 * charged to dismissal at all. Measured with the ledger's own `Transaction::fees(params, true)`:
 * guaranteed cost is **flat at 1.205 ms** from 1 input to 48, and dismissal only creeps from 1.311 ms
 * to 1.415 ms — the growth being signature verification at 59 µs / parallelism 4. The floor is 15 ms,
 * so dismissal stops being the limit.
 *
 * 64 is therefore a *size* bound rather than a cost one: ~12 KB of wire, against a per-block broadcast
 * budget of 200,000 bytes, with dismissal near 2.3 ms of the 15 ms floor. It is a politeness ceiling
 * chosen with headroom, not a ledger rule — unlike the 4 it replaces.
 */
export const MAX_UNSHIELDED_INPUTS = 64

/** Why a transfer cannot be built from this UTxO set. */
export type UnshieldedSelectionFailure =
  /** The wallet does not hold this much of the token. */
  | 'insufficient'
  /**
   * It holds enough, but not in few enough outputs: covering the amount needs more inputs than one
   * transfer may carry. The remedy is consolidation, not a smaller wallet — which is why this is its
   * own answer rather than `insufficient`, a message that would send someone looking for money they
   * already have.
   */
  | 'too-many-inputs'

export type UnshieldedSelection =
  | {readonly ok: true; readonly inputs: readonly UnshieldedUtxo[]}
  | {readonly ok: false; readonly reason: UnshieldedSelectionFailure}

/**
 * Choose inputs for an unshielded transfer: largest first until the amount is covered.
 *
 * Largest-first is what keeps the count under {@link MAX_UNSHIELDED_INPUTS} whenever that is possible
 * at all — any other order needs at least as many inputs for the same amount.
 */
export const selectUnshieldedInputs = (
  utxos: readonly UnshieldedUtxo[],
  tokenType: string,
  amount: bigint,
): UnshieldedSelection => {
  if (amount <= 0n) return {ok: false, reason: 'insufficient'}
  const ofToken = utxos.filter((u) => u.tokenType === tokenType)
  const largestFirst = [...ofToken].sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1))
  const chosen: UnshieldedUtxo[] = []
  let total = 0n
  for (const utxo of largestFirst) {
    if (chosen.length === MAX_UNSHIELDED_INPUTS) {
      // The largest four could not cover it, so nothing can. Whether the wallet holds enough overall
      // decides which of the two failures this is — and they are not the same problem.
      const held = ofToken.reduce((sum, u) => sum + u.value, 0n)
      return {ok: false, reason: held >= amount ? 'too-many-inputs' : 'insufficient'}
    }
    chosen.push(utxo)
    total += utxo.value
    if (total >= amount) return {ok: true, inputs: chosen}
  }
  return {ok: false, reason: 'insufficient'}
}
