/**
 * Waiting for a transaction to reach a given DEPTH, not merely to appear.
 *
 * Cardano's finality is probabilistic, so "it is on chain" and "it is three blocks deep"
 * are different facts, and a flow that must not act twice on the same funds needs the
 * second. Evolution's `awaitTx` answers presence and `getTxConfirmations` answers depth;
 * this is the polling convention on top, which is ours rather than a backend capability.
 *
 * ⚠️ A backend that cannot report depth serves depth 1 from presence and REFUSES anything
 * deeper, rather than answering a request for depth 3 with a presence fact. That would be
 * the dangerous kind of wrong: the caller asked for depth precisely because presence was
 * not enough.
 *
 * @module
 */

import {Provider, type TransactionHash} from '@evolution-sdk/evolution'
import {Duration, Effect} from 'effect'

/** 40 tries at 15s is ten minutes, about thirty Cardano blocks. */
export const AWAIT_TRIES = 40
export const AWAIT_INTERVAL_MS = 15_000

export type AwaitOptions = {
  readonly tries?: number
  readonly intervalMs?: number
  /** Blocks deep, counting the transaction's own block as the first. Defaults to 1. */
  readonly confirmations?: number
}

/**
 * Poll until `txHash` is `confirmations` deep, or the attempts run out.
 *
 * `false` means the depth was not reached within the attempts, which is not an error:
 * a caller may retry, widen the window, or tell the user it is still settling.
 */
export const awaitConfirmations = (
  provider: Pick<Provider.ProviderEffect, 'awaitTx' | 'getTxConfirmations'>,
  txHash: TransactionHash.TransactionHash,
  options: AwaitOptions = {},
): Effect.Effect<boolean, Provider.ProviderError> => {
  const wanted = options.confirmations ?? 1
  const depth = provider.getTxConfirmations
  if (depth === undefined) {
    return wanted > 1
      ? Effect.fail(
          new Provider.ProviderError({
            message: `awaitConfirmations: this backend reports presence, not depth; ${wanted} confirmations cannot be attested`,
          }),
        )
      : provider.awaitTx(txHash)
  }
  const attempts = options.tries ?? AWAIT_TRIES
  const pause = options.intervalMs ?? AWAIT_INTERVAL_MS
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      // `null` is "not seen yet", the normal answer for most of this loop.
      const reached = yield* depth(txHash)
      if (reached !== null && reached >= wanted) return true
      // No sleep after the last attempt: it would delay the answer by a whole interval
      // to report what is already known.
      if (attempt < attempts - 1) yield* Effect.sleep(Duration.millis(pause))
    }
    return false
  })
}
