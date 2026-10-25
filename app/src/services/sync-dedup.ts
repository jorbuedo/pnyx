/**
 * Which in-flight sync, if any, already covers a new request.
 *
 * Two callers ask for the same wallet within a millisecond of each other on
 * every launch: the group-selection effect asks for `recent`, and the adaptive
 * chain-sync scheduler's first tick asks for `all`. Keyed strictly by mode, the
 * two never coalesced, so a fresh start ran two full pipelines over one wallet —
 * `filterUsed`, `utxoForAddresses`, account state, the lot — against the same
 * endpoints.
 *
 * ⚠️ **The rule is deliberately asymmetric.** `all` fetches full history and
 * `recent` only checks the tip, so:
 *
 * - a `recent` request **joins** an in-flight `all` — the superset is already
 *   fetching everything it wanted;
 * - an `all` request **never** joins an in-flight `recent`, or full history would
 *   never run and the activity screen would sit on the recent page forever. That
 *   was a real bug, and it is why the key carries the mode at all.
 *
 * Pure, so the rule is testable without standing up the service that applies it.
 *
 * @module
 */

import {TX_FETCH_MODE, type TxFetchMode} from '@pnyx/wallet'

/** The dedup key for one wallet, chain and fetch mode. */
export const syncDedupKey = (groupId: string, chainId: string, mode: TxFetchMode): string =>
  `${groupId}:${chainId}:${mode}`

/**
 * The key of an in-flight sync this request can join, or `null` to start one.
 *
 * `inFlight` is only asked whether a key is present, so callers can pass their
 * own map without copying it.
 */
export const coveringSyncKey = (
  params: {readonly groupId: string; readonly chainId: string; readonly mode: TxFetchMode},
  inFlight: {readonly has: (key: string) => boolean},
): string | null => {
  const own = syncDedupKey(params.groupId, params.chainId, params.mode)
  if (inFlight.has(own)) return own
  if (params.mode !== TX_FETCH_MODE.RECENT) return null
  const full = syncDedupKey(params.groupId, params.chainId, TX_FETCH_MODE.ALL)
  return inFlight.has(full) ? full : null
}
