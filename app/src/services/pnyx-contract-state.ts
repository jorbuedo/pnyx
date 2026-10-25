/**
 * The Pnyx contract's state, read from an indexer rather than from our own service.
 *
 * Extracted from `identity-row.ts` when the proving rail needed the same read. Two callers with the
 * same requirement — the current ledger blob, cheaply, without telling a service what is being
 * looked at — is exactly the case for one reader instead of two.
 *
 * **Why not `GET /chain/state`.** The service can serve this (it holds a synced wallet), but doing so
 * makes every proof and every lookup a request our backend sees, and it puts a read on the critical
 * path of a host that otherwise only needs to *write*. The app already reads arbitrary contract state
 * from an indexer for identity rows; the Pnyx contract is no different, and
 * the indexer learns only that someone fetched a public ledger — not which key they wanted.
 *
 * **Freshness.** Both sources are eventually-consistent views of the same chain, so neither can
 * promise the state a transaction will be replayed against. That is fine here because the circuits
 * make staleness *fail* rather than corrupt: a moved counter, a spent nullifier or a changed Merkle
 * root is rejected at the node instead of silently taking someone else's slot. A retry against a
 * re-read state is the recovery.
 *
 * @module
 */

import {logger} from '../logger'
import {fetchContractMarker, fetchContractStateByAddress, fetchTransactionHeight} from './midnight/contract-state'

const ORIGIN = 'pnyx-contract-state'

/**
 * State reused across reads while a contract has not moved, keyed by address.
 *
 * Without this, resolving a chat list of N peers downloads the whole ledger N times — the state is
 * ~20 kB hex today and grows with every registration, so the per-read cost is the one real price of
 * reading directly. The marker query is ~277 bytes and answers "has it moved", so a second read
 * normally pays that instead of the blob. Process-lifetime only; no persistence, because a stale row
 * read as current is worse than a slow one.
 *
 * ⚠️ **Keyed by address, not a single slot.** It was one slot, from when there was one forum contract.
 * There is now one identity contract *per identity* and one handle contract *per name*, so a single
 * slot never hit twice in a row on any real screen — a chat list of N peers reads N addresses, and
 * each read evicted the last. Worse, {@link contractStateGenerationAt}'s predecessor answered with
 * whatever height was in that slot, so a cache keyed on it was keyed on an unrelated contract.
 */
const cached = new Map<string, {readonly height: number; readonly state: Uint8Array}>()

/**
 * How many contracts' states to hold.
 *
 * Each is ~20 kB, so this is ~320 kB at worst. Chosen to cover a screenful of peers plus the handle
 * contracts their names live in; eviction is not a correctness question, only a cost one, because
 * every derived cache treats an evicted entry as unknown rather than as unchanged.
 */
const MAX_CACHED_CONTRACTS = 16

/**
 * The read in flight per address, so concurrent callers share one round trip instead of each making
 * their own.
 *
 * Without this, resolving a chat list of N peers fires N *marker* queries for the same contract in
 * parallel — the blob cache cannot help, because none of them has returned yet when the others start.
 * Every caller wants the same answer to the same question at the same moment, which is exactly a
 * shared promise.
 */
const inflight = new Map<string, Promise<Uint8Array | null>>()

/**
 * The height `address`'s cached state is at, or `undefined` when we hold none.
 *
 * Exported so a derived cache can key on it: an entry computed from this state stays valid exactly
 * as long as the state does, which makes "has this contract moved" the invalidation rule rather than
 * a TTL somebody has to guess ({@link module:./peer-label}).
 *
 * ⚠️ `undefined` means "we hold nothing for it", which is **not** "it has not moved". A caller must
 * treat it as unknown and re-read; treating it as unchanged would let an entry outlive every signal
 * that could retire it.
 */
export const contractStateGenerationAt = (address: string): number | undefined => cached.get(address)?.height

/**
 * Drop every cached state — for tests, and for a network switch, which changes the contracts entirely.
 */
export const resetPnyxContractStateCache = (): void => {
  cached.clear()
  inflight.clear()
}

/**
 * The contract's current state, or `null` when it could not be read.
 *
 * `null` is "we could not look", never "there is nothing there" — callers that conflate the two turn
 * an indexer outage into a definite negative answer about somebody's identity.
 */
export const readPnyxContractState = async (address: string): Promise<Uint8Array | null> => {
  const shared = inflight.get(address)
  if (shared !== undefined) return shared
  const promise = readFreshState(address)
  inflight.set(address, promise)
  try {
    return await promise
  } finally {
    // Only clear our own entry: a later call may already have replaced it after this one settled.
    if (inflight.get(address) === promise) inflight.delete(address)
  }
}

const readFreshState = async (address: string): Promise<Uint8Array | null> => {
  const marker = await fetchContractMarker(address)
  const held = cached.get(address)
  if (marker !== null && held !== undefined && held.height === marker.height) return held.state
  const snapshot = await fetchContractStateByAddress(address)
  if (snapshot === null) return null
  remember(address, snapshot.height, snapshot.state)
  return snapshot.state
}

/** Store a state, evicting the least recently stored once {@link MAX_CACHED_CONTRACTS} is reached. */
const remember = (address: string, height: number, state: Uint8Array): void => {
  // Delete first so a re-read moves the entry to the end of the insertion order, which is what makes
  // the eviction below least-recently-*stored* rather than first-ever-seen.
  cached.delete(address)
  cached.set(address, {height, state})
  if (cached.size <= MAX_CACHED_CONTRACTS) return
  const oldest = cached.keys().next()
  if (!oldest.done) cached.delete(oldest.value)
}

/**
 * The state of a *named* contract, for callers that already know which one they mean.
 *
 * With one contract per circle there is no single forum contract to resolve: a join, proposal or vote
 * proves against that circle's own address, so the caller supplies it.
 */
export const requireContractStateAt = async (address: string): Promise<Uint8Array> => {
  const state = await readPnyxContractState(address)
  if (state === null) {
    logger.warn('contract state unreadable', {origin: ORIGIN, address})
    throw new Error('Pnyx contract state is unavailable (indexer unreachable or unset)')
  }
  return state
}

/**
 * The state `address` held at `height`, for a caller that needs a *past* tree rather than the live one.
 *
 * ⚠️ **Deliberately not cached.** {@link cached} holds one entry per address and answers "the latest
 * state we saw", which is the opposite question — serving a historic read from it, or writing a
 * historic read into it, would hand every other caller a tree from the past. Historic state is
 * immutable, so a cache keyed by `(address, height)` would be sound; there is no caller yet that
 * reads the same past height twice, so it does not exist.
 *
 * Throws rather than returning `null`: the one caller is a vote, which cannot proceed without it, and
 * an unreadable tree must not degrade into proving against whatever else is to hand.
 */
export const requireContractStateAtHeight = async (address: string, height: number): Promise<Uint8Array> => {
  const snapshot = await fetchContractStateByAddress(address, undefined, {height})
  if (snapshot === null) {
    logger.warn('historic contract state unreadable', {origin: ORIGIN, address, height})
    throw new Error(`Pnyx contract state at height ${String(height)} is unavailable (indexer unreachable or unset)`)
  }
  return snapshot.state
}

/**
 * The block a transaction landed in. Throws when it cannot be resolved, for the same reason as above:
 * the height is what selects the tree a vote proves against, and guessing it proves nothing.
 */
export const requireTransactionHeight = async (txHash: string): Promise<number> => {
  const height = await fetchTransactionHeight(txHash)
  if (height === null) {
    logger.warn('transaction height unresolvable', {origin: ORIGIN, txHash})
    throw new Error('the transaction this state is pinned to could not be found on chain')
  }
  return height
}
