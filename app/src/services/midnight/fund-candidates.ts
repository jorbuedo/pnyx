/**
 * Which UTxOs to offer the native funder, and when to say the wallet cannot cover a deficit.
 *
 * Its own module because it is pure. `./fund-transaction.ts` opens the vault and reaches the native
 * bridge, which drags `expo-modules-core` into any test that imports it — and this is the half worth
 * testing: offering the wrong candidates, or reporting "not enough funds" when the money is merely
 * spread thin, both mislead in ways nothing downstream corrects.
 *
 * **The native side chooses; this side offers.** It recomputes the shortfall from the ledger itself and
 * spends the fewest candidates that cover it, so the job here is only to bound the offer — largest
 * first, at most {@link MAX_UNSHIELDED_INPUTS} per token — and to distinguish the two ways it can fail.
 *
 * @module
 */

import type {TxDeficit} from '@pnyx/midnight-native'
import {MAX_UNSHIELDED_INPUTS} from './input-selection'
import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'

/** Why a deficit cannot be funded from this UTxO set. Mirrors `UnshieldedSelectionFailure`. */
export type FundingShortfall = {
  readonly tokenType: string
  readonly owed: bigint
  /**
   * `insufficient` — the wallet does not hold this much of the token.
   *
   * `too-many-inputs` — it holds enough, but not within the inputs one transaction may carry. A
   * different problem with a different remedy (consolidation), so telling someone their funds are
   * missing would send them looking for money they already have.
   */
  readonly reason: 'insufficient' | 'too-many-inputs'
  /** What the wallet actually holds of that token, so a message can state both figures. */
  readonly held: bigint
}

export type FundingCandidates =
  | {readonly ok: true; readonly candidates: readonly UnshieldedUtxo[]}
  | {readonly ok: false; readonly shortfall: FundingShortfall}

const sum = (utxos: readonly UnshieldedUtxo[]): bigint => utxos.reduce((total, u) => total + u.value, 0n)

/**
 * The UTxOs to offer for a set of deficits.
 *
 * One deficit token can appear in several segments and each is funded separately, so the amount to
 * cover for a token is the **sum across its legs** — offering enough for the largest leg alone would
 * hand the native side a set it then refuses, after the user had approved.
 *
 * Only unshielded deficits are considered. A shielded or DUST deficit is refused natively, naming
 * which; filtering it out here as if it were fundable would hide that refusal until after approval.
 */
export const fundingCandidatesFor = (
  utxos: readonly UnshieldedUtxo[],
  deficits: readonly TxDeficit[],
): FundingCandidates => {
  const owedByToken = new Map<string, bigint>()
  for (const deficit of deficits) {
    if (deficit.kind !== 'unshielded' || deficit.tokenType === null) continue
    owedByToken.set(deficit.tokenType, (owedByToken.get(deficit.tokenType) ?? 0n) + deficit.owed)
  }

  const candidates: UnshieldedUtxo[] = []
  for (const [tokenType, owed] of owedByToken) {
    const ofToken = utxos.filter((u) => u.tokenType === tokenType)
    const largestFirst = [...ofToken].sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1))
    const offered = largestFirst.slice(0, MAX_UNSHIELDED_INPUTS)
    if (sum(offered) < owed) {
      const held = sum(ofToken)
      return {
        ok: false,
        shortfall: {
          tokenType,
          owed,
          reason: held >= owed ? 'too-many-inputs' : 'insufficient',
          held,
        },
      }
    }
    candidates.push(...offered)
  }
  return {ok: true, candidates}
}
