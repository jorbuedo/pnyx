// Submission hardening for the FIFO transaction queue.
//
// Two consecutive contract calls can race on the sponsor wallet's fee coins: the
// node/indexer confirm tx N before the wallet's own sync has ingested the spend, so
// tx N+1 can balance itself against a coin state the chain does not vouch for and the
// node rejects it at submission with the `RpcError: 1010: Invalid Transaction` family
// (custom codes decoded from midnight-node: 196 DustDoubleSpend, 117 NotNormalized, …).
// Note: the 2026-07-05 on-device `Custom error: 117` turned out to be the zero-fee
// empty-DustActions wallet-sdk bug (see balancing.ts), not a coin race — but the race is
// real on any fee-bearing chain, and these countermeasures guard it. Both live here so
// they are unit-testable without a network:
// - after every successful submission, block the queue until the wallet has observed its
//   own spend on-chain (dust `pendingDust` drained) before the next tx builds;
// - if a submission is still rejected 1010-style, resync the wallet and rebuild/resubmit
//   with bounded exponential backoff (the rebuild happens naturally: the submit closure
//   re-balances against the freshly synced coin set).

/**
 * Wallet coin-observation signal, injected so tests can fake the wallet.
 *
 * The real signal is the dust wallet's `pendingDust` ledger: every locally-built spend
 * parks the consumed coin there and only the wallet's indexer sync — ingesting the
 * on-chain event for that spend — clears it. A transaction built while `pendingDust` is
 * non-empty spends a locally-derived successor coin the chain does not vouch for yet.
 * Sync-progress indexes are NOT a usable signal: dust generation advances them every
 * block whether or not our spend was observed (verified live 2026-07-05).
 */
export type CoinSync = {
  /** Resolves once the wallet has observed all of its own pending fee-coin spends on-chain. */
  waitForOwnSpends(timeoutMs: number): Promise<void>
  /** Full resync: wallet sync sections caught up AND no pending own spends. */
  resync(timeoutMs: number): Promise<void>
}

export type SubmitRetryOptions = {
  /** Retries after a coin-contention rejection (default 3, so up to 4 submissions). */
  readonly maxRetries?: number
  /** Base backoff before a retry, doubled per attempt (default 2000 ms). */
  readonly backoffMs?: number
  /** How long to wait for the wallet to observe its own spends (default 120 s). */
  readonly coinSyncTimeoutMs?: number
}

type SubmitterDeps = SubmitRetryOptions & {
  readonly log?: (message: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}

const messageChainMatches = (error: unknown, predicate: (message: string) => boolean): boolean => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = current instanceof Error ? current.message : String(current)
    if (predicate(message)) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/**
 * True for node-submission rejections caused by stale coin selection — the
 * `1010: Invalid Transaction` RPC family (custom 196 = dust double spend, custom 117 =
 * non-normalized). Walks the `cause` chain since midnight-js wraps the RPC error.
 */
export const isCoinContentionError = (error: unknown): boolean =>
  messageChainMatches(error, (message) => /\b1010\b/.test(message) && /invalid transaction/i.test(message))

/**
 * True for transient wallet-side build failures: the ledger WASM occasionally panics
 * inside `feesWithMargin` ("Unreachable code should not be executed") in the window right
 * after a landed transaction while the dynamic fee price transitions (observed live
 * 2026-07-05 on the standalone chain). A later rebuild succeeds.
 */
export const isTransientWalletPanic = (error: unknown): boolean =>
  messageChainMatches(error, (message) => message.includes('Unreachable code should not be executed'))

/** Everything the submitter retries with resync + rebuild. */
export const isRetryableSubmissionError = (error: unknown): boolean =>
  isCoinContentionError(error) || isTransientWalletPanic(error)

export type TxSubmitter = <T>(label: string, submit: () => Promise<T>) => Promise<T>

/**
 * Wraps a build+submit closure with the two countermeasures above. Intended to guard each
 * individual transaction inside a FIFO-queued op (a vote is two guarded submissions).
 */
export const createTxSubmitter = (coinSync: CoinSync, deps?: SubmitterDeps): TxSubmitter => {
  const maxRetries = deps?.maxRetries ?? 3
  const backoffMs = deps?.backoffMs ?? 2_000
  const coinSyncTimeoutMs = deps?.coinSyncTimeoutMs ?? 120_000
  const log = deps?.log ?? (() => {})
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return async <T>(label: string, submit: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await submit()
        // Hold the queue until the wallet has seen its own spend; otherwise the next
        // transaction funds itself with a coin state the chain does not vouch for yet.
        try {
          await coinSync.waitForOwnSpends(coinSyncTimeoutMs)
        } catch (syncError) {
          log(
            `${label}: coin sync after submission did not settle (${
              syncError instanceof Error ? syncError.message : String(syncError)
            }) — continuing, the retry guard covers the next transaction`,
          )
        }
        return result
      } catch (error) {
        if (!isRetryableSubmissionError(error) || attempt >= maxRetries) {
          throw error
        }
        const delay = backoffMs * 2 ** attempt
        log(
          `${label}: ${
            isCoinContentionError(error) ? 'submission rejected on stale coins' : 'transient wallet build failure'
          } (attempt ${attempt + 1}/${maxRetries + 1}), resyncing wallet and retrying in ${delay}ms`,
        )
        await sleep(delay)
        try {
          await coinSync.resync(coinSyncTimeoutMs)
        } catch (resyncError) {
          log(
            `${label}: wallet resync did not settle (${
              resyncError instanceof Error ? resyncError.message : String(resyncError)
            }) — retrying the submission anyway`,
          )
        }
      }
    }
  }
}
