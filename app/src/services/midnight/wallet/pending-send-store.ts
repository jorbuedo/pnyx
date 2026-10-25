/**
 * Where sends handed to the sponsor but not yet seen on chain are kept.
 *
 * Separate key from the UTxO cache on purpose: that one is a **cache** and discarding it costs a
 * replay, while this is the only record that a send happened at all. The sponsor reports acceptance of
 * the bytes and nothing after ([[transfer-outcome-never-reaches-sender]]), so if this blob is lost the
 * send becomes invisible — not stale, invisible. It is therefore versioned and read defensively, but
 * never silently dropped as a whole when one row is unreadable.
 *
 * The resolution rule lives in `pending-send.ts`; this module is only storage.
 *
 * Profile-scoped through `storage`, like every other wallet key: the decoy profile keeps its own.
 *
 * @module
 */

import {logger} from '../../../logger'
import {storage} from '../../../platform/storage'
import {notifyStoreChange, onStoreChange} from '../../store-change'
import type {PendingSend} from './pending-send'

const ORIGIN = 'midnight-pending-send-store'

/**
 * Observe writes, so a list **already on screen** picks up a send submitted after it mounted.
 *
 * Without this the overlay only appeared where the reading hook happened to re-run. Cardano's
 * `pending-activity.ts` carries the same mechanism and the same warning, learned the same way: the
 * recent-activity widget on the wallet home mounts before the submit and does not poll, so it showed
 * nothing while a freshly-opened Activity screen showed the row. Reproduced here on the device before
 * this existed — and the balance stores had the same hole, which is why the mechanism now lives in
 * `services/store-change.ts` rather than here.
 */
export const onPendingSendsChange = (listener: () => void): (() => void) =>
  onStoreChange('midnight-pending-sends', listener)

const notify = (): void => notifyStoreChange('midnight-pending-sends')

/** `@pnyx/midnight/pending-sends/<groupId>/<accountIndex>`. */
export const pendingSendKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/pending-sends/${groupId}/${accountIndex}`

type StoredSend = {
  identifiers: readonly string[]
  rail: string
  direction: string
  tokenType: string
  /** Decimal string — JSON has no bigint, and a rounded amount is worse than none. */
  amount: string
  recipient: string
  submittedAt: string
}

/**
 * ⚠️ **An older blob is discarded, not upgraded.** v1 rows carry no `direction`, and it cannot be
 * recovered from one: a self-send is only recognisable against the wallet's own addresses, which this
 * module does not hold. Defaulting to `'sent'` is exactly the bug the field exists to fix — the row
 * read "Sent" for its whole pending window and then relabelled itself "Internal" on landing. Discarding
 * costs at most one in-flight send its pending row; the send itself is unaffected and still resolves.
 */
type StoredBlob = {
  version: 2
  sends: readonly StoredSend[]
}

const isRail = (value: unknown): value is PendingSend['rail'] => value === 'unshielded' || value === 'shielded'

const isDirection = (value: unknown): value is PendingSend['direction'] => value === 'sent' || value === 'self'

/**
 * Read one stored send, or `undefined` when it cannot be trusted.
 *
 * Every rejection is logged with what was wrong. A send is the record of money leaving; dropping one
 * quietly would remove the only evidence it was ever attempted.
 */
const readSend = (raw: unknown): PendingSend | undefined => {
  const s = raw as Partial<StoredSend> | null
  if (s === null || typeof s !== 'object') {
    logger.warn('dropping a pending send that is not an object', {origin: ORIGIN})
    return undefined
  }
  if (!Array.isArray(s.identifiers) || s.identifiers.length === 0 || s.identifiers.some((i) => typeof i !== 'string')) {
    // An empty identifier list matches nothing, so such a row would sit here for ever.
    logger.warn('dropping a pending send with no usable identifiers', {origin: ORIGIN})
    return undefined
  }
  if (typeof s.amount !== 'string' || !/^\d+$/.test(s.amount)) {
    logger.warn('dropping a pending send whose amount is not digits', {origin: ORIGIN, amount: String(s.amount)})
    return undefined
  }
  if (!isRail(s.rail) || typeof s.tokenType !== 'string' || typeof s.recipient !== 'string') {
    logger.warn('dropping a pending send with a missing field', {origin: ORIGIN, rail: String(s.rail)})
    return undefined
  }
  if (!isDirection(s.direction)) {
    // Never defaulted to `'sent'`: that is the mislabelling this field was added to remove.
    logger.warn('dropping a pending send with no readable direction', {
      origin: ORIGIN,
      direction: String(s.direction),
    })
    return undefined
  }
  if (typeof s.submittedAt !== 'string') {
    logger.warn('dropping a pending send with no submission time', {origin: ORIGIN})
    return undefined
  }
  return {
    identifiers: s.identifiers,
    rail: s.rail,
    direction: s.direction,
    tokenType: s.tokenType,
    amount: BigInt(s.amount),
    recipient: s.recipient,
    submittedAt: s.submittedAt,
  }
}

/**
 * Decode a stored blob. Empty for absent *or* unreadable, with the reason logged either way — "nothing
 * pending" and "we could not read what was pending" are different facts even when both render as no
 * rows, and only one of them is a bug.
 *
 * Pure, so the rejection rules are testable without a device (the storage layer needs an Expo global no
 * test runner has).
 */
export const parsePendingSends = (raw: string | null): readonly PendingSend[] => {
  if (raw === null || raw === '') {
    logger.debug('no pending sends stored', {origin: ORIGIN})
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn('pending sends blob is not JSON; treating as none', {origin: ORIGIN, error: String(error)})
    return []
  }
  const blob = parsed as Partial<StoredBlob> | null
  if (blob === null || typeof blob !== 'object' || blob.version !== 2 || !Array.isArray(blob.sends)) {
    logger.warn('pending sends blob has an unexpected shape; treating as none', {
      origin: ORIGIN,
      version: String(blob?.version),
    })
    return []
  }
  return blob.sends.flatMap((row) => {
    const send = readSend(row)
    return send === undefined ? [] : [send]
  })
}

/**
 * Serialises the read-modify-writes on one key.
 *
 * ⚠️ **Both writers here are load-then-save, and they now run concurrently.** Settling used to happen
 * only when something called a one-shot sync; the live feed settles on every transaction that lands.
 * So `recordPendingSend` and the settle can interleave, and the loser's read is stale: a send submitted
 * at the moment another one settles would vanish — invisible on screen, its unshielded locks held to
 * their one-hour TTL, its pending DUST spend never promoted.
 *
 * A promise chain rather than a semaphore because this module is still Promise-based; both callers go
 * through it, which is the property that matters.
 */
const keyLocks = new Map<string, Promise<unknown>>()

const underKeyLock = <A>(key: string, run: () => Promise<A>): Promise<A> => {
  const prior = keyLocks.get(key) ?? Promise.resolve()
  // `then(run, run)` so a rejected predecessor does not wedge the chain for every later writer.
  const next = prior.then(run, run)
  // The queue's copy must always settle, or one failed writer wedges every later one. The rejection
  // itself is not swallowed — it is delivered to this caller through `next` below — but a queued write
  // failing is worth a line either way, because the next writer proceeds as though nothing happened.
  keyLocks.set(
    key,
    next.catch((error: unknown) => {
      logger.debug('a queued pending-send write failed; the queue continues', {origin: ORIGIN, error: String(error)})
    }),
  )
  return next
}

/** Every send still recorded as pending. Empty when there are none *or* when the blob is unreadable. */
/**
 * How long a send may claim to be pending before it stops being believable.
 *
 * ⚠️ **Not a guess about block times — a bound on a claim we cannot verify.** `removePendingSends`
 * only fires when the chain accounts for the identifiers, so a transaction that never lands has no
 * other way out of this list. One that died at the sponsor showed "Pending" on the wallets screen
 * indefinitely, long after its input lock (one hour, `unshielded-pending-store.ts`) had lapsed and
 * given the balance back — a row insisting something is in flight while the money it supposedly
 * moved is spendable again.
 *
 * Two hours, twice the lock's TTL: a transaction still unaccounted for by then is not slow, and the
 * lock has already released its inputs, so nothing is protected by continuing to claim it.
 */
export const PENDING_SEND_TTL_MS = 2 * 60 * 60_000

/** The sends still worth showing at `nowMs`. Pure, so the rule is testable without storage. */
export const livePendingSends = (
  sends: readonly PendingSend[],
  nowMs: number,
): {readonly live: readonly PendingSend[]; readonly expired: readonly PendingSend[]} => {
  const live: PendingSend[] = []
  const expired: PendingSend[] = []
  for (const send of sends) {
    const at = Date.parse(send.submittedAt)
    // An unparseable timestamp is kept: dropping a send because its clock string is odd would lose
    // the record of money leaving, which is the one thing this store exists not to do.
    if (Number.isFinite(at) && nowMs - at >= PENDING_SEND_TTL_MS) expired.push(send)
    else live.push(send)
  }
  return {live, expired}
}

/**
 * The pending sends still standing, with lapsed ones swept from disk.
 *
 * Swept on read rather than on a timer, like the input locks: the only moment a stale row matters is
 * when something is about to render or reconcile it, and that is exactly when this is called.
 */
export const loadPendingSends = async (groupId: string, accountIndex: number): Promise<readonly PendingSend[]> => {
  const stored = parsePendingSends(await storage.get(pendingSendKey(groupId, accountIndex)))
  const {live, expired} = livePendingSends(stored, Date.now())
  if (expired.length === 0) return stored
  // ⚠️ Logged, never silent. A row leaving this list means a send we announced was never accounted
  // for by the chain, which is a fact about money and the only place it is now recorded.
  logger.warn('a pending send outlived its window with the chain never accounting for it', {
    origin: ORIGIN,
    groupId,
    accountIndex,
    dropped: expired.length,
    identifiers: expired.flatMap((s) => s.identifiers),
  })
  await savePendingSends(groupId, accountIndex, live)
  return live
}

export const savePendingSends = async (
  groupId: string,
  accountIndex: number,
  sends: readonly PendingSend[],
): Promise<void> => {
  const blob: StoredBlob = {
    version: 2,
    sends: sends.map((s) => ({
      identifiers: [...s.identifiers],
      rail: s.rail,
      direction: s.direction,
      tokenType: s.tokenType,
      amount: s.amount.toString(),
      recipient: s.recipient,
      submittedAt: s.submittedAt,
    })),
  }
  await storage.set(pendingSendKey(groupId, accountIndex), JSON.stringify(blob))
  logger.debug('pending sends written', {origin: ORIGIN, groupId, count: sends.length})
  // After the write, so a listener that re-reads sees what was just stored rather than the old blob.
  notify()
}

/**
 * Record a send that has just been accepted for submission.
 *
 * Refuses a send with no identifiers rather than storing one that can never resolve — the caller is
 * expected to have logged why it had none.
 */
export const recordPendingSend = async (groupId: string, accountIndex: number, send: PendingSend): Promise<void> => {
  if (send.identifiers.length === 0) {
    logger.warn('refusing to record a pending send with no identifiers', {origin: ORIGIN, groupId})
    return
  }
  await underKeyLock(pendingSendKey(groupId, accountIndex), async () => {
    const existing = await loadPendingSends(groupId, accountIndex)
    await savePendingSends(groupId, accountIndex, [...existing, send])
  })
  logger.info('send recorded as pending', {
    origin: ORIGIN,
    groupId,
    rail: send.rail,
    direction: send.direction,
    identifiers: send.identifiers,
  })
}

/**
 * Drop the sends whose identifiers the chain has now accounted for.
 *
 * ⚠️ **Removes what it names, rather than replacing the list.** A settle that wrote back "the ones
 * still pending" would silently drop a send recorded after it read — and that read happens on every
 * transaction the feed sees, so the window is open continuously rather than once per manual sync.
 * Matched by containment, the rule identifiers use everywhere: a device-built transaction has no hash,
 * and a sponsored one lands carrying the sponsor's identifiers alongside ours.
 */
export const removePendingSends = async (
  groupId: string,
  accountIndex: number,
  settled: readonly (readonly string[])[],
): Promise<void> => {
  if (settled.length === 0) return
  await underKeyLock(pendingSendKey(groupId, accountIndex), async () => {
    const existing = await loadPendingSends(groupId, accountIndex)
    const kept = existing.filter(
      (send) =>
        send.identifiers.length === 0 || !settled.some((landed) => send.identifiers.every((id) => landed.includes(id))),
    )
    if (kept.length === existing.length) return
    await savePendingSends(groupId, accountIndex, kept)
  })
}
