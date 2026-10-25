/**
 * Local persistence for DM state: MLS group state, unspent KeyPackage private halves, and per-
 * conversation poll cursors.
 *
 * **Everything here except the cursor is secret material.** `encodeDmState` carries the ratchet's
 * private path and the signature private key, and a `PrivateKeyPackage` is the other half of a
 * published package. So none of it may sit in plain MMKV.
 *
 * It also cannot sit behind the biometric enclave vault: group state advances on *every* send and
 * receive, so a vault read per message would mean a biometric prompt per message. The resolution is
 * to encrypt at rest under a key derived from `forumRoot` — already cached for the session at
 * sign-in, already the root the DM identity derives from — and keep the ciphertext in MMKV. That
 * adds no secret at rest beyond the existing vault and keeps `forumRoot` the single backup unit,
 * which is what `docs/DIRECT_MESSAGES_PLAN.md` promises.
 *
 * The store is deliberately explicit about *why* each record exists, because two of them are easy
 * to get wrong in ways that only show up later:
 *
 * - **Private KeyPackage halves must be keyed by the id the server uses** (the SHA-256 of the
 *   public package). A peer claims our *public* package; the Welcome that comes back is only
 *   openable with that exact private half. Lose the mapping and we are in a group we can never
 *   join — with no error until the Welcome arrives.
 * - **Group state must be persisted after every operation that advances it**, including receiving a
 *   handshake message that yields no plaintext. Dropping it desynchronises the ratchet, and MLS
 *   surfaces that later as an undecryptable message rather than as the write that was missed.
 *
 * @module
 */

import {hkdfSha256, sha256, xchacha20poly1305Decrypt, xchacha20poly1305Encrypt} from '@pnyx/crypto'
import {Data, Effect} from 'effect'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import type {CirclePeer} from './circle-peer-index'
import type {DmConversation} from './dm-conversation-index'
import {type DmPermitBook, EMPTY_PERMIT_BOOK} from './dm-permit-book'
import * as syncedStore from './synced-recovery-store'

/** Reading or writing local DM state failed. */
export class DmSessionError extends Data.TaggedError('DmSessionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * A stored record that cannot be opened, ever.
 *
 * Its own type because the recovery differs: a read that *failed* should be retried, a record that
 * cannot be decrypted should be forgotten. Everything that lands here is permanent for this record —
 * a wrong key, a truncated blob, a non-base64 value — and no amount of retrying changes it.
 *
 * ⚠️ **This is reachable in the field.** `STORE_KEY_INFO` dropped its `:<network>` suffix on
 * 2026-08-29 (`d2a3c501`), so every record written before that is sealed under a key the app will
 * never derive again. That commit called the store "re-wrappable", which is true in principle and was
 * not done — the old records were orphaned, and the invite drain retried seven of them on every pass.
 */
export class DmRecordUnreadableError extends Data.TaggedError('DmRecordUnreadableError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Storage keys. Documented in `docs/STORAGE_KEYS.md`. */
const stateKey = (convId: string): string => `@pnyx/dm/state/${convId}`
/** The group we were in before the current one. See {@link archiveGroupState}. */
const priorStateKey = (convId: string): string => `@pnyx/dm/state-prior/${convId}`
/** Set while a repair we initiated has not yet been confirmed. See {@link markRepairPending}. */
const repairKey = (convId: string): string => `@pnyx/dm/repair/${convId}`
const cursorKey = (convId: string): string => `@pnyx/dm/cursor/${convId}`
const privateHalfKey = (packageId: string): string => `@pnyx/dm/kp/${packageId}`
const threadKey = (convId: string): string => `@pnyx/dm/thread/${convId}`
/**
 * The conversation index.
 *
 * ⚠️ **Sealed, unlike the cursor and the read marker.** Those are timestamps the server already
 * knows; this is the list of who this device talks to — the social graph the DM push payload
 * deliberately refuses to carry so FCM cannot learn it. Writing it in the clear would hand the same
 * graph to anything that can read app storage.
 */
const CONVERSATION_INDEX_KEY = '@pnyx/dm/conversations'
// Sealed under the same key as the conversation index and for the same reason: it is a list of people
// this identity has been near, which is the graph the whole DM design keeps off the server.
const CIRCLE_PEERS_KEY = '@pnyx/dm/circle-peers'

/** The permit book — see `dm-permit-book.ts` for what is in it and why. */
const PERMIT_BOOK_KEY = '@pnyx/dm/permits'
/**
 * Index of live KeyPackage ids.
 *
 * Needed because the platform store exposes get/set/remove and no prefix scan, and an arriving
 * Welcome has to be matched against *every* package we still hold to find the one that opens it.
 * Kept in the clear: it is a list of content hashes of data we already published.
 */
const PRIVATE_HALF_INDEX_KEY = '@pnyx/dm/kp-index'

/**
 * The at-rest encryption key: `HKDF-SHA256(forumRoot, "pnyx:dm:store:v1")`.
 *
 * A distinct info string from the MLS signature key and the phase-1 X25519 key, so a compromise of
 * one derivation cannot be replayed against another.
 *
 * **Not network-scoped**, unlike the rest of this file's history. It used to be, which meant the
 * preprod→mainnet switch left every local conversation encrypted under a key the app would never
 * derive again — the MLS identity could survive the migration and the message history still would
 * not. The `v1` stays because this one *can* be spent: the store is local, readable, and re-wrappable
 * under a new key, which is the version-bump path an on-chain derivation does not have.
 */
const STORE_KEY_INFO: Uint8Array = utf8('pnyx:dm:store:v1')

export type DmStoreKey = {readonly key: Uint8Array}

export const deriveDmStoreKey = (forumRoot: Uint8Array): Effect.Effect<DmStoreKey, DmSessionError> =>
  Effect.gen(function* () {
    const key = yield* hkdfSha256(forumRoot, STORE_KEY_INFO, 32).pipe(
      Effect.mapError((cause) => new DmSessionError({message: 'deriveDmStoreKey: HKDF failed', cause})),
    )
    return {key}
  })

/**
 * `nonce ‖ ciphertext`, base64. The nonce is derived from the storage key and a counter-free
 * digest of the plaintext rather than drawn at random, because a record is rewritten on every
 * message and a 24-byte random nonce per write is fine — but a *reused* nonce under the same key
 * would be catastrophic, so it is bound to the record's identity and content.
 */
const NONCE_BYTES = 24

const recordNonce = (recordKey: string, plaintext: Uint8Array): Uint8Array =>
  sha256(new Uint8Array([...utf8(`pnyx:dm:nonce:v1:${recordKey}`), ...plaintext])).slice(0, NONCE_BYTES)

const sealRecord = (
  storeKey: DmStoreKey,
  recordKey: string,
  plaintext: Uint8Array,
): Effect.Effect<string, DmSessionError> =>
  Effect.gen(function* () {
    const nonce = recordNonce(recordKey, plaintext)
    const ciphertext = yield* xchacha20poly1305Encrypt(storeKey.key, nonce, plaintext, utf8(recordKey)).pipe(
      Effect.mapError((cause) => new DmSessionError({message: 'sealRecord: encryption failed', cause})),
    )
    let binary = ''
    for (const byte of [...nonce, ...ciphertext]) binary += String.fromCharCode(byte)
    return btoa(binary)
  })

const openRecord = (
  storeKey: DmStoreKey,
  recordKey: string,
  encoded: string,
): Effect.Effect<Uint8Array, DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => {
        const binary = atob(encoded)
        const out = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
        return out
      },
      catch: (cause) => new DmRecordUnreadableError({message: 'openRecord: not base64', cause}),
    })
    if (raw.length <= NONCE_BYTES) {
      return yield* Effect.fail(new DmRecordUnreadableError({message: 'openRecord: record too short'}))
    }
    // The record key is the AAD, so a record moved to a different key fails to open rather than
    // silently decrypting as some other conversation's state.
    return yield* xchacha20poly1305Decrypt(
      storeKey.key,
      raw.slice(0, NONCE_BYTES),
      raw.slice(NONCE_BYTES),
      utf8(recordKey),
    ).pipe(Effect.mapError((cause) => new DmRecordUnreadableError({message: 'openRecord: decryption failed', cause})))
  })

// ── Group state ──

export const saveGroupState = (
  storeKey: DmStoreKey,
  convId: string,
  encodedState: Uint8Array,
): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    const key = stateKey(convId)
    const sealed = yield* sealRecord(storeKey, key, encodedState)
    yield* Effect.tryPromise({
      try: () => storage.set(key, sealed),
      catch: (cause) => new DmSessionError({message: `saveGroupState: write failed for ${convId}`, cause}),
    })
  })

/**
 * Load a conversation's group state, or `undefined` when there is none.
 *
 * `undefined` means "no group yet" — a real state the caller must handle by creating or joining
 * one. A decryption *failure* is different and is raised: it means the record exists but the key or
 * the record is wrong, and treating that as "no group" would silently discard a live conversation.
 */
export const loadGroupState = (
  storeKey: DmStoreKey,
  convId: string,
): Effect.Effect<Uint8Array | undefined, DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const key = stateKey(convId)
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(key),
      catch: (cause) => new DmSessionError({message: `loadGroupState: read failed for ${convId}`, cause}),
    })
    if (stored === null || stored.length === 0) return undefined
    return yield* openRecord(storeKey, key, stored)
  })

// ── KeyPackage private halves ──

/**
 * The id a private half is filed under: SHA-256 of the **public** package, hex.
 *
 * This must match what the service computes (`routes.ts` → `sha256Hex`), because the Welcome we
 * eventually receive is identified by the public package a peer claimed. Deriving it from the same
 * bytes on both sides is what keeps the two in step without a protocol field.
 */
export const keyPackageId = (publicPackage: Uint8Array): string => {
  const digest = sha256(publicPackage)
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Every KeyPackage id we still hold a private half for. */
export const listPrivateHalfIds = (): Effect.Effect<readonly string[], DmSessionError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(PRIVATE_HALF_INDEX_KEY),
      catch: (cause) => new DmSessionError({message: 'listPrivateHalfIds: read failed', cause}),
    })
    if (stored === null || stored.length === 0) return []
    return stored.split(',').filter((id) => id.length > 0)
  })

const writePrivateHalfIndex = (ids: readonly string[]): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.set(PRIVATE_HALF_INDEX_KEY, ids.join(',')),
    catch: (cause) => new DmSessionError({message: 'writePrivateHalfIndex: write failed', cause}),
  })

export const savePrivateHalf = (
  storeKey: DmStoreKey,
  packageId: string,
  encodedPrivate: Uint8Array,
): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    const key = privateHalfKey(packageId)
    const sealed = yield* sealRecord(storeKey, key, encodedPrivate)
    yield* Effect.tryPromise({
      try: () => storage.set(key, sealed),
      catch: (cause) => new DmSessionError({message: `savePrivateHalf: write failed for ${packageId}`, cause}),
    })
    // Index after the record, so a crash between the two leaves an unindexed record (harmless, it is
    // simply never matched) rather than an index entry pointing at nothing.
    const ids = yield* listPrivateHalfIds()
    if (!ids.includes(packageId)) yield* writePrivateHalfIndex([...ids, packageId])
  })

export const loadPrivateHalf = (
  storeKey: DmStoreKey,
  packageId: string,
): Effect.Effect<Uint8Array | undefined, DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const key = privateHalfKey(packageId)
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(key),
      catch: (cause) => new DmSessionError({message: `loadPrivateHalf: read failed for ${packageId}`, cause}),
    })
    if (stored === null || stored.length === 0) return undefined
    return yield* openRecord(storeKey, key, stored)
  })

/**
 * Drop a private half once its group has been joined.
 *
 * Deliberately separate from joining: the half must survive until the group state is durably
 * written, or a crash between the two leaves an unjoinable group. Call this only after
 * {@link saveGroupState} has resolved.
 */
export const forgetPrivateHalf = (packageId: string): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => storage.remove(privateHalfKey(packageId)),
      catch: (cause) => new DmSessionError({message: `forgetPrivateHalf: delete failed for ${packageId}`, cause}),
    })
    const ids = yield* listPrivateHalfIds()
    yield* writePrivateHalfIndex(ids.filter((id) => id !== packageId))
  })

// ── Conversation index ──

/**
 * Every conversation this device knows about.
 *
 * Returns `[]` for an absent index, which is the honest reading for a fresh install. A *corrupt* one
 * is a different fact and is not swallowed here: it propagates as {@link DmRecordUnreadableError} so
 * a caller can decide, rather than silently presenting an empty inbox to someone who has conversations.
 */
export const loadConversationIndex = (
  storeKey: DmStoreKey,
): Effect.Effect<readonly DmConversation[], DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(CONVERSATION_INDEX_KEY),
      catch: (cause) => new DmSessionError({message: 'loadConversationIndex: read failed', cause}),
    })
    if (stored === null || stored.length === 0) return []
    const plaintext = yield* openRecord(storeKey, CONVERSATION_INDEX_KEY, stored)
    return JSON.parse(new TextDecoder().decode(plaintext)) as DmConversation[]
  })

export const saveConversationIndex = (
  storeKey: DmStoreKey,
  list: readonly DmConversation[],
): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    const sealed = yield* sealRecord(storeKey, CONVERSATION_INDEX_KEY, utf8(JSON.stringify(list)))
    yield* Effect.tryPromise({
      try: () => storage.set(CONVERSATION_INDEX_KEY, sealed),
      catch: (cause) => new DmSessionError({message: 'saveConversationIndex: write failed', cause}),
    })
  })

/**
 * Mirror the sealed conversation list into the user's own synced store, and read it back.
 *
 * ⚠️ **The ciphertext is mirrored, never the list.** The record is already sealed under
 * {@link deriveDmStoreKey}, which derives from `forumRoot` and therefore from the mnemonic — so the
 * synced copy is readable only by someone who has restored the seed, which is the same bar as the
 * conversations themselves. No new key material, no second format, and no plaintext leaves the
 * device.
 *
 * ⚠️ **Why this is needed at all.** After a restore the local index is gone, and the inbox is
 * rebuilt only from what the *service* still holds undelivered. A conversation with nothing queued
 * is therefore invisible until the other person happens to speak — you are talking to people you
 * cannot see. The synced copy is what makes "restore my wallet" restore the conversation list too.
 *
 * Custody is the user's own provider (iCloud Keychain / Google Block Store), the same place the
 * recovery blob lives; no Pnyx service is involved. Best effort in both directions: a device with
 * sync off keeps working exactly as before.
 */
export const mirrorConversationIndex = (): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    if (!syncedStore.isAvailable()) return
    try {
      const sealed = await storage.get(CONVERSATION_INDEX_KEY)
      if (sealed === null || sealed.length === 0) return
      await syncedStore.setItem(CONVERSATION_INDEX_KEY, sealed)
    } catch (error) {
      // Bookkeeping, like the index write itself: it must never take a conversation down with it.
      logger.warn('dm conversation index could not be mirrored to the synced store', {
        origin: 'dm-session',
        error: String(error),
      })
    }
  })

/**
 * Adopt the synced conversation list when this device has none.
 *
 * Returns whether anything was adopted. Deliberately only when local is empty: a device with its own
 * index is authoritative for itself, and overwriting it with a copy that may be older would lose
 * conversations rather than restore them.
 */
export const adoptSyncedConversationIndex = (): Effect.Effect<boolean, never> =>
  Effect.promise(async () => {
    if (!syncedStore.isAvailable()) return false
    try {
      const local = await storage.get(CONVERSATION_INDEX_KEY)
      if (local !== null && local.length > 0) return false
      const synced = await syncedStore.getItem(CONVERSATION_INDEX_KEY)
      if (synced === null || synced.length === 0) return false
      await storage.set(CONVERSATION_INDEX_KEY, synced)
      logger.info('dm conversation index adopted from the synced store', {origin: 'dm-session'})
      return true
    } catch (error) {
      logger.warn('dm conversation index could not be read from the synced store', {
        origin: 'dm-session',
        error: String(error),
      })
      return false
    }
  })

// ── Permits ──
// Who may reach us and who we may reach: see `dm-permit-book.ts` for the shape and the reasoning.

/**
 * The permit book, or an empty one for a device that has never held a permit.
 *
 * Sealed for the same reason as the conversation list: `granted` is keyed by conversation and `held`
 * by peer, so between them they describe who this person talks to — the social graph the DM push
 * payload deliberately refuses to carry.
 *
 * A *corrupt* record propagates rather than reading as empty. Returning `{}` would silently drop
 * every permit we hold, which under a peer's `permit` policy means quietly becoming unable to write
 * to them with no way to tell that from never having been granted one.
 */
export const loadPermitBook = (
  storeKey: DmStoreKey,
): Effect.Effect<DmPermitBook, DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(PERMIT_BOOK_KEY),
      catch: (cause) => new DmSessionError({message: 'loadPermitBook: read failed', cause}),
    })
    if (stored === null || stored.length === 0) return EMPTY_PERMIT_BOOK
    const plaintext = yield* openRecord(storeKey, PERMIT_BOOK_KEY, stored)
    return JSON.parse(new TextDecoder().decode(plaintext)) as DmPermitBook
  })

export const savePermitBook = (storeKey: DmStoreKey, book: DmPermitBook): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    const sealed = yield* sealRecord(storeKey, PERMIT_BOOK_KEY, utf8(JSON.stringify(book)))
    yield* Effect.tryPromise({
      try: () => storage.set(PERMIT_BOOK_KEY, sealed),
      catch: (cause) => new DmSessionError({message: 'savePermitBook: write failed', cause}),
    })
  })

// ── People seen in circles ──
// A shortcut for starting a conversation, not a cache of anything: see `circle-peer-index.ts`.

/**
 * Everyone this device has seen posting in a circle.
 *
 * Absent reads as `[]` — nobody has been seen yet, which is true of a fresh install. A *corrupt*
 * record propagates like the conversation index's does, so a caller can tell "no suggestions" apart
 * from "the suggestions could not be opened".
 */
export const loadCirclePeers = (
  storeKey: DmStoreKey,
): Effect.Effect<readonly CirclePeer[], DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(CIRCLE_PEERS_KEY),
      catch: (cause) => new DmSessionError({message: 'loadCirclePeers: read failed', cause}),
    })
    if (stored === null || stored.length === 0) return []
    const plaintext = yield* openRecord(storeKey, CIRCLE_PEERS_KEY, stored)
    return JSON.parse(new TextDecoder().decode(plaintext)) as CirclePeer[]
  })

export const saveCirclePeers = (
  storeKey: DmStoreKey,
  peers: readonly CirclePeer[],
): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    const sealed = yield* sealRecord(storeKey, CIRCLE_PEERS_KEY, utf8(JSON.stringify(peers)))
    yield* Effect.tryPromise({
      try: () => storage.set(CIRCLE_PEERS_KEY, sealed),
      catch: (cause) => new DmSessionError({message: 'saveCirclePeers: write failed', cause}),
    })
  })

// ── Poll cursor ──
// Not secret — it is a timestamp the server already knows — so it is stored in the clear. Keeping
// it unencrypted also means a corrupt cursor degrades to re-fetching, never to a decrypt failure.

export const saveCursor = (convId: string, cursor: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.set(cursorKey(convId), cursor),
    catch: (cause) => new DmSessionError({message: `saveCursor: write failed for ${convId}`, cause}),
  })

export const loadCursor = (convId: string): Effect.Effect<string | undefined, DmSessionError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(cursorKey(convId)),
      catch: (cause) => new DmSessionError({message: `loadCursor: read failed for ${convId}`, cause}),
    })
    return stored === null || stored.length === 0 ? undefined : stored
  })

// ── Thread history ──

/**
 * One message as the thread renders it. `text` is `undefined` for a message that arrived but could
 * not be opened — kept as a gap marker rather than dropped, so the thread does not silently omit
 * something the peer believes they sent.
 */
export type DmThreadEntry = {
  readonly id: string
  readonly mine: boolean
  readonly text: string | undefined
  readonly createdAt: string
  /**
   * `break` marks where a session was replaced, and is not a message anyone sent.
   *
   * ⚠️ **Distinct from `text: undefined`, which means "one message we could not open".** A
   * re-established conversation cannot open *anything* from the epoch before it — rendering that as
   * one undecryptable row per message turns a single fact into a screenful of identical red, and
   * buries the one thing worth saying under the noise of saying it many times.
   */
  readonly kind?: 'break'
  /** How many messages the break covers. Only meaningful with `kind: 'break'`. */
  readonly count?: number
}

/**
 * Locally stored plaintext for a conversation.
 *
 * **Why this has to exist.** Nothing else persists a message. The ratchet state, the KeyPackage
 * halves and the cursor were all saved, but the plaintext lived only in the thread screen's React
 * state — so leaving the screen destroyed the history, and it could not be rebuilt from the server:
 *
 * - **Our own messages** can never be re-derived. MLS gives a sender no way to open its own
 *   application message (sealing consumed that generation), which is why `drain` skips them. The
 *   plaintext exists exactly once, at `send`.
 * - **Received messages** cannot be re-opened either. Opening advances the ratchet, so the stored
 *   ciphertext on the server becomes undecryptable to us the moment we have read it once.
 *
 * The server keeps the ciphertext indefinitely (`dm_messages` is never pruned), so this is not a
 * cache of something fetchable — it is the only copy of the plaintext that will ever exist.
 *
 * Sealed with the same {@link DmStoreKey} as the group state: the *content* of a private message
 * deserves at least the protection its ratchet state gets.
 *
 * Whole-thread blob rather than a row per message, matching what the platform store offers
 * (get/set/remove, no prefix scan). Fine at DM scale; a conversation long enough to make this
 * expensive would need a real table, not a bigger blob.
 */
export const loadThread = (
  storeKey: DmStoreKey,
  convId: string,
): Effect.Effect<readonly DmThreadEntry[], DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const key = threadKey(convId)
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(key),
      catch: (cause) => new DmSessionError({message: `loadThread: read failed for ${convId}`, cause}),
    })
    if (stored === null || stored.length === 0) return []
    const plain = yield* openRecord(storeKey, key, stored)
    return yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(plain)) as readonly DmThreadEntry[],
      catch: (cause) => new DmSessionError({message: `loadThread: corrupt record for ${convId}`, cause}),
    })
  })

/**
 * Add messages to a conversation's history, de-duplicated by id.
 *
 * **Dedupe by id is load-bearing, not tidiness.** There is no transaction across the message write,
 * the group-state write and the cursor write, so the writes are ordered by which failure is
 * survivable: the message goes first, because a duplicate can be collapsed here while a lost
 * plaintext is permanent. Appending after the ratchet advanced would invert that.
 *
 * Sorted by `createdAt` so a re-fetch that interleaves with a live poll still renders in order.
 */
/**
 * Drop this conversation's stored plaintext.
 *
 * ⚠️ **Irreversible, and not a cache eviction.** This store is the only copy that will ever exist:
 * our own messages cannot be re-derived (MLS gives a sender no way to open its own application
 * message) and received ones cannot be re-opened (opening advanced the ratchet). Nothing refetches.
 *
 * The group state is deliberately left alone — clearing history must not end the session, or
 * "clear messages" would silently become "leave the conversation".
 */
export const clearThread = (convId: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.remove(threadKey(convId)),
    catch: (cause) => new DmSessionError({message: `clearThread: delete failed for ${convId}`, cause}),
  })

export const appendThread = (
  storeKey: DmStoreKey,
  convId: string,
  additions: readonly DmThreadEntry[],
): Effect.Effect<readonly DmThreadEntry[], DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    if (additions.length === 0) return yield* loadThread(storeKey, convId)
    const existing = yield* loadThread(storeKey, convId)
    const byId = new Map(existing.map((entry) => [entry.id, entry]))
    for (const entry of additions) {
      // First write wins: a re-delivered message must not overwrite a plaintext we already opened
      // with a later gap marker.
      if (!byId.has(entry.id)) byId.set(entry.id, entry)
    }
    const merged = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const key = threadKey(convId)
    const sealed = yield* sealRecord(storeKey, key, utf8(JSON.stringify(merged)))
    yield* Effect.tryPromise({
      try: () => storage.set(key, sealed),
      catch: (cause) => new DmSessionError({message: `appendThread: write failed for ${convId}`, cause}),
    })
    return merged
  })

/**
 * Remove individual messages from a conversation's local history.
 *
 * **Local only, and that is the whole story for a note to self** — nothing was
 * ever sent, so removing it is a delete. For a real conversation it is not: MLS
 * gives no unsend, the peer keeps their copy, and the caller has to say so in the
 * copy rather than implying a reach this does not have.
 *
 * Returns what is left, so a caller can render the result rather than re-reading.
 */
export const deleteFromThread = (
  storeKey: DmStoreKey,
  convId: string,
  ids: readonly string[],
): Effect.Effect<readonly DmThreadEntry[], DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    if (ids.length === 0) return yield* loadThread(storeKey, convId)
    const existing = yield* loadThread(storeKey, convId)
    const drop = new Set(ids)
    const kept = existing.filter((entry) => !drop.has(entry.id))
    // Nothing matched: leave the stored record untouched rather than rewriting it
    // (a rewrite re-seals under a fresh nonce for no gain).
    if (kept.length === existing.length) return existing
    const key = threadKey(convId)
    const sealed = yield* sealRecord(storeKey, key, utf8(JSON.stringify(kept)))
    yield* Effect.tryPromise({
      try: () => storage.set(key, sealed),
      catch: (cause) => new DmSessionError({message: `deleteFromThread: write failed for ${convId}`, cause}),
    })
    return kept
  })

/**
 * Drop a conversation's MLS group state, ending the session on this device.
 *
 * ⚠️ **Irreversible and one-sided.** The group is a ratchet: once this device's copy is gone there
 * is nothing to re-derive it from, and the peer keeps their half until they delete too. That is the
 * point — it is the only way out of a conversation whose two sides have ended up in *different*
 * groups under the same id, which is otherwise permanent and silent. Distinct from
 * {@link clearThread}, which drops plaintext and deliberately leaves the session running.
 */
export const forgetGroupState = (convId: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.remove(stateKey(convId)),
    catch: (cause) => new DmSessionError({message: `forgetGroupState: remove failed for ${convId}`, cause}),
  })

/**
 * Keep the group we are leaving, so a message still in flight from it can be opened.
 *
 * ⚠️ **Replacing a group is not instantaneous for the other side.** When a conversation is repaired
 * the peer keeps sending in the old group until their Welcome arrives, and those messages are
 * perfectly valid — they are simply addressed to a group we have just stopped being in. Without a
 * copy they become permanent gaps at exactly the moment the user is being told the problem is
 * fixed. One generation is kept, not a history: the point is to cover the changeover, not to make
 * old ciphertext readable for ever, which is the property forward secrecy is for.
 */
export const archiveGroupState = (
  storeKey: DmStoreKey,
  convId: string,
  encodedState: Uint8Array,
): Effect.Effect<void, DmSessionError> =>
  Effect.gen(function* () {
    // Sealed exactly like the live state: it is the same ratchet material, and a copy kept in the
    // clear would undo at rest what the live record is careful about.
    const key = priorStateKey(convId)
    const sealed = yield* sealRecord(storeKey, key, encodedState)
    yield* Effect.tryPromise({
      try: () => storage.set(key, sealed),
      catch: (cause) => new DmSessionError({message: `archiveGroupState: write failed for ${convId}`, cause}),
    })
  })

/** The group we were in before the current one, if one was kept. */
export const loadPriorGroupState = (
  storeKey: DmStoreKey,
  convId: string,
): Effect.Effect<Uint8Array | undefined, DmSessionError | DmRecordUnreadableError> =>
  Effect.gen(function* () {
    const key = priorStateKey(convId)
    const stored = yield* Effect.tryPromise({
      try: () => storage.get(key),
      catch: (cause) => new DmSessionError({message: `loadPriorGroupState: read failed for ${convId}`, cause}),
    })
    if (stored === null || stored.length === 0) return undefined
    return yield* openRecord(storeKey, key, stored)
  })

/** Drop the archived group — on delete, and once the changeover is long past. */
export const forgetPriorGroupState = (convId: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.remove(priorStateKey(convId)),
    catch: (cause) => new DmSessionError({message: `forgetPriorGroupState: remove failed for ${convId}`, cause}),
  })

/**
 * Note that *we* rebuilt this conversation and are waiting for the peer to join.
 *
 * ⚠️ **This is the tie-break, and without it two simultaneous repairs re-create the divergence they
 * were fixing.** An incoming Welcome for a different group is normally adopted — that is how a
 * one-sided repair heals. But if both sides detected the break and rebuilt at once, both adopt and
 * they simply swap groups, still apart. While this marker is set, the lower group id wins instead,
 * which both sides compute identically and therefore converge on.
 */
export const markRepairPending = (convId: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.set(repairKey(convId), '1'),
    catch: (cause) => new DmSessionError({message: `markRepairPending: write failed for ${convId}`, cause}),
  })

export const repairIsPending = (convId: string): Effect.Effect<boolean, DmSessionError> =>
  Effect.tryPromise({
    try: async () => (await storage.get(repairKey(convId))) !== null,
    catch: (cause) => new DmSessionError({message: `repairIsPending: read failed for ${convId}`, cause}),
  })

export const clearRepairPending = (convId: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.remove(repairKey(convId)),
    catch: (cause) => new DmSessionError({message: `clearRepairPending: remove failed for ${convId}`, cause}),
  })

/** Drop a conversation's local history. For a deleted conversation, and for tests. */
export const forgetThread = (convId: string): Effect.Effect<void, DmSessionError> =>
  Effect.tryPromise({
    try: () => storage.remove(threadKey(convId)),
    catch: (cause) => new DmSessionError({message: `forgetThread: remove failed for ${convId}`, cause}),
  })
