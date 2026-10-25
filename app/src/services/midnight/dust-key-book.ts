/**
 * The persisted book of DUST sync keys — one keychain slot holding every wallet's DUST role key.
 *
 * ### Why it exists
 *
 * A DUST role key comes from a wallet's seed, so a scheduled sync could only ever use a key some
 * *user-initiated* prompt happened to be holding. After any restart nothing held one, the scheduler
 * declined every tick, and DUST rotted: measured at fifteen transactions stale on a wallet with a valid
 * block time, which made `decideFeePayer` fall back to the sponsor and the review read "Paid for you".
 * The fee decision was right; the sync never running was the defect.
 *
 * So the keys live in one slot, read once at unlock and held until lock. That turns "a prompt per sync,
 * per wallet" into "one read at a moment the user is already authenticating".
 *
 * ### Why writing is free and reading is not
 *
 * The keychain's `BIOMETRY_ANY_OR_DEVICE_PASSCODE` access control gates **retrieval**, not storage — so
 * appending a key costs no prompt, and only the unlock-time read does. `services/profile/lock-gate.ts`
 * relies on the same asymmetry and states it: *"the prompt belongs on the change, not on the setup step
 * the user is already standing in."*
 *
 * That is what makes an append cheap: it is **not** read-modify-write. While unlocked the in-memory
 * cache already *is* the book, so appending mutates it and writes the whole thing back.
 *
 * ⚠️ **The one case that must never write.** An empty cache means two different things — "the book was
 * read and holds nothing" and "the book was never read". Only the first may be written back; the second
 * would replace every other wallet's key with nothing. `isSyncKeyBookRestored` is the difference, and
 * the read genuinely can fail (unreachable keystore, cancelled prompt) with a wallet creation right
 * behind it. So an append with no restore refuses rather than clobbers.
 *
 * ### Scope
 *
 * ⚠️ **DUST keys only.** A Zswap key spends coins, and there is no viewing-only shielded sync to be had
 * from this ledger API — `State::insert_coin` indexes by a nullifier derived from `coin_secret_key`, so
 * the shielded index is spend-derived by construction (see `./sync-keys.ts`). Persisting that is a
 * materially larger grant than persisting fee-money keys, so the shielded rail stays prompt-driven and
 * would get its **own** slot and its own decision, never a ride along with this one.
 *
 * @module
 */

import {Effect} from 'effect'

import {logger} from '../../logger'
import {createEnclaveMnemonicVault} from '../credential-vault'
import {
  allSyncKeys,
  forgetSyncKeys,
  forgetSyncKeysForGroup,
  isSyncKeyBookRestored,
  type MidnightSyncKeys,
  markSyncKeyBookRestored,
  putSyncKeys,
} from './sync-keys-store'

const ORIGIN = 'midnight-dust-key-book'

/**
 * The keychain slot. Not a wallet group and not an identity — the same shape of dedicated slot
 * `lock-gate.ts` uses, so `getAllGenericPasswordServices` never mistakes it for a wallet.
 */
export const DUST_KEY_BOOK_SLOT = 'pnyx-dust-keys'

/**
 * One account's entry, **per network**.
 *
 * The address and network ride along because a scheduled sync would otherwise need the vault to work
 * out *what* to read, which is exactly the prompt this book removes.
 *
 * ⚠️ One account contributes one entry per network it has a key for, so `(groupId, accountIndex)` is
 * not unique here and never was — the stored format already carried `network`, and only the in-memory
 * cache key collapsed them. That is why widening the key needs no migration: an old book is a valid
 * new book with one network populated.
 */
export type DustKeyBookEntry = {
  readonly groupId: string
  readonly accountIndex: number
  /** The DUST role key, hex. */
  readonly dust: string
  /** The wallet's `mn_dust…` address. */
  readonly dustAddress: string
  readonly network: string
}

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const fromHex = (value: string): Uint8Array | undefined => {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Parse a stored book. A malformed entry is **dropped**, never defaulted.
 *
 * A key that decoded to the wrong bytes would derive a state the chain does not have, and the node
 * reports that as a bad proof rather than as a bad key — so a substituted value would be far harder to
 * diagnose than an absent one, which merely asks for a prompt.
 */
export const parseDustKeyBook = (raw: string): readonly DustKeyBookEntry[] => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed.flatMap((one) => {
      const row = one as Record<string, unknown>
      if (typeof row?.groupId !== 'string' || row.groupId === '') return []
      if (typeof row?.accountIndex !== 'number' || !Number.isSafeInteger(row.accountIndex)) return []
      if (typeof row?.dust !== 'string' || fromHex(row.dust) === undefined) return []
      if (typeof row?.dustAddress !== 'string' || row.dustAddress === '') return []
      if (typeof row?.network !== 'string' || row.network === '') return []
      return [
        {
          groupId: row.groupId,
          accountIndex: row.accountIndex,
          dust: row.dust,
          dustAddress: row.dustAddress,
          network: row.network,
        },
      ]
    })
  } catch (error) {
    // Losing the book costs prompts, never correctness — every key is re-derivable from its seed.
    logger.warn('the stored dust key book is unreadable; falling back to prompting', {
      origin: ORIGIN,
      error: String(error),
    })
    return []
  }
}

export const serializeDustKeyBook = (entries: readonly DustKeyBookEntry[]): string => JSON.stringify(entries)

/**
 * The held cache as book entries, in a stable order so an unchanged book serialises identically.
 *
 * ⚠️ The identity comes off the entry, never off the cache key. Parsing it back out of the key was
 * correct only while the key was exactly two components, and it is now three.
 */
export const bookFromHeldKeys = (): readonly DustKeyBookEntry[] =>
  allSyncKeys()
    .map((held) => ({
      groupId: held.groupId,
      accountIndex: held.accountIndex,
      dust: toHex(held.keys.dust),
      dustAddress: held.keys.dustAddress,
      network: held.keys.network,
    }))
    .sort(
      (a, b) =>
        a.groupId.localeCompare(b.groupId) || a.accountIndex - b.accountIndex || a.network.localeCompare(b.network),
    )

/** Write the held keys as the whole book. No prompt — storage is not gated, retrieval is. */
const writeBook = (entries: readonly DustKeyBookEntry[]): Effect.Effect<void, never> =>
  createEnclaveMnemonicVault()
    .store(DUST_KEY_BOOK_SLOT, serializeDustKeyBook(entries))
    .pipe(
      Effect.tap(() =>
        Effect.sync(() => logger.debug('wrote the dust key book', {origin: ORIGIN, accounts: entries.length})),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          // ⚠️ Loud, and never swallowed into a silent success: a book that failed to write means this
          // wallet stops syncing DUST after the next lock, with nothing on screen to say why.
          logger.error('could not write the dust key book, so these keys will not survive lock', {
            origin: ORIGIN,
            accounts: entries.length,
            error: String(error),
          })
        }),
      ),
    )

/**
 * Read the book and hold every entry until lock. Fires the one biometric prompt.
 *
 * Never rejects: a failed read leaves DUST exactly as stale as it is today, and unlock must not be
 * blocked by a sync convenience. `restored` is only marked when the state is actually **known** —
 * including "known absent" — because that flag is what an append is allowed to trust.
 *
 * ⚠️ **Once per unlock, not once per caller.** The keys and `isSyncKeyBookRestored` live in a module
 * cache that outlives any React tree, and only lock clears it (`forgetAllSyncKeys`). A caller that
 * remounts — the provider tree is keyed on the funds network, so a network switch remounts all of it —
 * would otherwise re-read a keychain slot whose contents cannot have changed, costing a second OS
 * prompt for nothing. Returns how many accounts are in hand either way, which is the fact the caller
 * logs.
 */
export const restoreDustKeyBook = (authPrompt?: string): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    if (isSyncKeyBookRestored()) {
      const held = allSyncKeys().length
      logger.debug('the dust key book is already held this session, so it is not re-read', {
        origin: ORIGIN,
        accounts: held,
      })
      return held
    }
    const vault = createEnclaveMnemonicVault()
    // ⚠️ **Three states, not two.** "There is no book" and "the probe failed" must not collapse: the
    // first is *known* and lets an append write the first book, while the second knows nothing — and
    // marking it known would let the next append replace a real book with one entry. That is the same
    // clobber `isSyncKeyBookRestored` exists to prevent, so it must not arrive through a swallowed
    // probe. Caught by `silent-catch.test.ts` before it shipped.
    const exists = yield* vault.has(DUST_KEY_BOOK_SLOT).pipe(Effect.either)
    if (exists._tag === 'Left') {
      logger.warn('could not tell whether a dust key book exists, so it stays unknown this session', {
        origin: ORIGIN,
        error: String(exists.left),
      })
      return 0
    }
    if (!exists.right) {
      // Known-absent is a known state, so an append may safely write the first book.
      markSyncKeyBookRestored()
      logger.debug('no dust key book is stored yet', {origin: ORIGIN})
      return 0
    }
    const raw = yield* vault.retrieve(DUST_KEY_BOOK_SLOT, authPrompt).pipe(Effect.either)
    if (raw._tag === 'Left') {
      logger.warn('could not read the dust key book, so dust stays prompt-driven this session', {
        origin: ORIGIN,
        error: String(raw.left),
      })
      return 0
    }
    const entries = parseDustKeyBook(raw.right)
    for (const entry of entries) {
      const dust = fromHex(entry.dust)
      if (dust === undefined) continue
      const keys: MidnightSyncKeys = {dust, dustAddress: entry.dustAddress, network: entry.network}
      putSyncKeys(entry.groupId, entry.accountIndex, keys)
    }
    markSyncKeyBookRestored()
    logger.info('restored the dust key book, so scheduled syncs can run without prompting', {
      origin: ORIGIN,
      accounts: entries.length,
    })
    return entries.length
  })

/**
 * Add or replace one account's entries — one per network — and persist the book.
 *
 * Called when a wallet is created or imported **and** when an account is added — one path, because two
 * would drift and the second would silently not autosync.
 *
 * Refuses when the book has not been restored this session: see the module note. The keys still go into
 * the in-memory cache, so this session syncs normally; only the persistence is skipped.
 */
export const appendDustKeysToBook = (
  groupId: string,
  accountIndex: number,
  keys: readonly MidnightSyncKeys[],
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    for (const one of keys) putSyncKeys(groupId, accountIndex, one)
    if (!isSyncKeyBookRestored()) {
      logger.warn('not persisting the dust keys: the book has not been read this session', {
        origin: ORIGIN,
        groupId,
        accountIndex,
        networks: keys.map((one) => one.network),
      })
      return
    }
    // One write for the whole set, not one per network — the book is rewritten whole either way.
    yield* writeBook(bookFromHeldKeys())
  })

/**
 * Persist the held set as the whole book — call after forgetting keys, so a deleted wallet's key leaves
 * the vault instead of lingering until the next append happens to rewrite it.
 *
 * ⚠️ Same restore rule as an append, and it matters *more* here. Writing an unrestored cache after a
 * deletion would look like it worked while actually erasing every surviving wallet's key.
 */
export const persistDustKeyBook = (): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (!isSyncKeyBookRestored()) {
      logger.warn('not persisting the dust key book: it has not been read this session', {origin: ORIGIN})
      return
    }
    yield* writeBook(bookFromHeldKeys())
  })

/**
 * Forget every key belonging to a deleted wallet, and persist what is left.
 *
 * Keyed on the group, because a wallet's accounts all derive from the one seed — deleting the wallet
 * retires all of them at once.
 */
export const forgetDustKeysForGroup = (groupId: string): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (forgetSyncKeysForGroup(groupId) === 0) return
    yield* persistDustKeyBook()
  })

/**
 * Forget one account's key and persist what is left — the account was disabled, so the scheduler has no
 * business syncing it.
 */
export const forgetDustKeyForAccount = (groupId: string, accountIndex: number): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    forgetSyncKeys(groupId, accountIndex)
    yield* persistDustKeyBook()
  })

/**
 * Remove the book entirely — the whole wallet was erased, so an empty book left behind would be a slot
 * claiming a state that no longer exists.
 */
export const deleteDustKeyBook = (): Effect.Effect<void, never> =>
  createEnclaveMnemonicVault()
    .delete(DUST_KEY_BOOK_SLOT)
    .pipe(
      Effect.tap(() => Effect.sync(() => logger.info('removed the dust key book', {origin: ORIGIN}))),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          logger.warn('could not remove the dust key book', {origin: ORIGIN, error: String(error)})
        }),
      ),
    )
