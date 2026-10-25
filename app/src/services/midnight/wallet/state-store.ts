/**
 * Where a Midnight funds wallet's shielded state lives.
 *
 * ⚠️ **This is the one wallet store whose loss can lose money — for one class of coin.** Everything
 * else the app persists can be rebuilt by reading the chain again, and so can most of this: a coin is
 * discoverable by scanning iff whoever *built* its transaction knew the recipient's encryption key,
 * which covers ordinary receives, our own change, and a contract mint addressed to us. What cannot be
 * rebuilt is a coin taken with `walletInsertCoin` — no ciphertext on chain, so its nonce, colour and
 * value exist only here. ⚠️ **Nothing calls `walletInsertCoin` today**, so this store is a pure cache
 * until plan item 60 lands; item 61 is where it stops being one.
 *
 * Profile-scoped, because it holds money: `storage` writes under the active profile's prefix, so the
 * decoy profile has its own state and can never read the real one's coins.
 *
 * Keyed by `(groupId, accountIndex)` rather than one blob per app, because a funds group is the unit that
 * owns coins and a user may hold several.
 *
 * ⚠️ Size: the blob carries the local commitment tree, so it grows with the wallet's own coins (not with
 * the chain). That is fine in MMKV for a wallet holding tens of coins and wants revisiting — as a file
 * rather than a key — before anyone holds thousands.
 *
 * @module
 */

import type {WalletStateBytes} from '@pnyx/midnight-native'
import {Data, Effect} from 'effect'

import {logger} from '../../../logger'
import {storage} from '../../../platform/storage'
import {publishStoreChange} from '../../store-change'
import type {ShieldedBirthday} from './sync-window'

const ORIGIN = 'midnight-wallet-state'

/**
 * The shielded state could not be read or written.
 *
 * ⚠️ `unreadable` is a **refusal, not a fault of the caller's**: there is a state here and these bytes
 * are not it. Nothing may replace it with a fresh empty state, because a contract-minted coin has no
 * ciphertext on chain and exists only in this blob. `storage` is the ordinary "the read never happened".
 * Both stop a caller, and they are separated so a diagnosis can tell a corrupt blob from a broken MMKV.
 */
export class ShieldedStoreError extends Data.TaggedError('ShieldedStoreError')<{
  readonly cause: 'storage' | 'unreadable'
  readonly reason: string
}> {}

const get = (key: string): Effect.Effect<string | null, ShieldedStoreError> =>
  Effect.tryPromise({
    try: () => storage.get(key),
    catch: (error) => new ShieldedStoreError({cause: 'storage', reason: String(error)}),
  })

const set = (key: string, value: string): Effect.Effect<void, ShieldedStoreError> =>
  Effect.tryPromise({
    try: () => storage.set(key, value),
    catch: (error) => new ShieldedStoreError({cause: 'storage', reason: String(error)}),
  })

const remove = (key: string): Effect.Effect<void, ShieldedStoreError> =>
  Effect.tryPromise({
    try: () => storage.remove(key),
    catch: (error) => new ShieldedStoreError({cause: 'storage', reason: String(error)}),
  })

/** `@pnyx/midnight/shielded-state/<groupId>/<accountIndex>` — hex-encoded serialized wallet state. */
export const shieldedStateKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/shielded-state/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/shielded-cursor/<groupId>/<accountIndex>` — the last block height applied.
 *
 * Separate from the state so a corrupt cursor cannot cost coins, and a lost cursor only costs a rescan.
 */
export const shieldedCursorKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/shielded-cursor/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/shielded-network/<groupId>/<accountIndex>` — which network the state above belongs to.
 *
 * A sidecar rather than part of the key, because the key must not change: this blob can hold coins that
 * exist nowhere else, and rekeying would orphan them. Nothing recorded the network before, so a state
 * written by an older build is **unstamped** — see {@link loadShieldedState} for why that is read
 * permissively and stamped on the next write rather than adopted on the next read.
 */
export const shieldedNetworkKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/midnight/shielded-network/${groupId}/${accountIndex}`

/**
 * `@pnyx/midnight/shielded-birthday/<groupId>/<network>` — the height a first sync starts at.
 *
 * ⚠️ **Keyed by network, not by account.** A block height means nothing on another chain, while every
 * account under one seed shares the moment that seed was created — so `(groupId, accountIndex)`, the
 * key the state and cursor use, is the wrong shape here and a per-account copy would be the same
 * number written many times.
 *
 * Local only. The durable copy is the passkey recovery blob, which is what survives losing the phone —
 * see `services/passkey-recovery`. This one exists so a sync does not have to unwrap that blob.
 */
export const shieldedBirthdayKey = (groupId: string, network: string): string =>
  `@pnyx/midnight/shielded-birthday/${groupId}/${network}`

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Decode a stored blob. `undefined` for absent; **fails** for present-but-unreadable.
 *
 * The distinction is the point: "no wallet yet" is ordinary, while "there is a wallet and these bytes are
 * not it" must never be silently replaced by a fresh empty state — that would drop the only copy of any
 * contract-minted coin and report a zero balance as if it were true. That refusal is the `unreadable`
 * cause, and it is in the type rather than in a thrown `Error` a caller might catch by accident.
 */
export const parseStoredState = (raw: string | null): Effect.Effect<WalletStateBytes | undefined, ShieldedStoreError> =>
  Effect.suspend(() => {
    if (raw === null || raw === '') return Effect.succeed(undefined)
    if (raw.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(raw)) {
      return Effect.fail(
        new ShieldedStoreError({
          cause: 'unreadable',
          reason: `stored shielded state is not hex (${raw.length} chars) — refusing to overwrite it`,
        }),
      )
    }
    const out = new Uint8Array(raw.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16)
    return Effect.succeed(out)
  })

/** A cursor is a block height, so only a positive integer is meaningful; anything else reads as absent. */
export const parseStoredCursor = (raw: string | null): number | undefined => {
  if (raw === null || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Whether the stored state — and therefore the cursor that counts its blocks — belongs to `network`.
 *
 * One function for both because they describe **one** blob: the cursor is the height the state was
 * applied up to, so a cursor without its state is a claim about coverage nothing holds. Reading them
 * under different rules is what let a preview cursor answer for preprod.
 *
 * An **unstamped** pair is accepted rather than refused. It predates the stamp, so its network is
 * genuinely unknown, and the two ways of guessing are not equal: discarding could drop a
 * contract-minted coin that exists nowhere else, while stamping on read would cement a guess that may
 * be wrong. Accepting preserves the behaviour of a wallet that never switched, and the next
 * {@link saveShieldedState} records the network for real.
 */
const belongsToNetwork = (
  groupId: string,
  accountIndex: number,
  network: string,
  what: 'state' | 'cursor',
): Effect.Effect<boolean, ShieldedStoreError> =>
  Effect.gen(function* () {
    const stamped = yield* get(shieldedNetworkKey(groupId, accountIndex))
    if (stamped === null || stamped === '' || stamped === network) return true
    logger.info(`the stored shielded ${what} belongs to another network; reporting none`, {
      origin: ORIGIN,
      groupId,
      accountIndex,
      stored: stamped,
      asked: network,
    })
    return false
  })

/**
 * The state, if it belongs to `network`.
 *
 * ⚠️ **A network switch used to hand back the other chain's coins.** Nothing here was keyed or guarded
 * by network, and no switch handler cleared it, so a wallet moved from preprod to mainnet read its
 * preprod state as mainnet's — wrong-chain figures, not merely stale ones.
 *
 * An **unstamped** state is returned rather than refused. It predates the stamp, so its network is
 * genuinely unknown, and the two ways of guessing are not equal: discarding it could drop a
 * contract-minted coin that exists nowhere else, while stamping it on read would cement a guess that
 * may be wrong. Returning it preserves today's behaviour exactly, and the next {@link saveShieldedState}
 * records the network for real.
 */
export const loadShieldedState = (
  groupId: string,
  accountIndex: number,
  network: string,
): Effect.Effect<WalletStateBytes | undefined, ShieldedStoreError> =>
  Effect.gen(function* () {
    if (!(yield* belongsToNetwork(groupId, accountIndex, network, 'state'))) return undefined
    return yield* parseStoredState(yield* get(shieldedStateKey(groupId, accountIndex)))
  })

/**
 * Persist the state. Failures **propagate** rather than log-and-continue: a caller that just built a
 * transfer has a state whose spends are pending, and losing that write means the next transfer picks
 * the same coins.
 */
export const saveShieldedState = (
  groupId: string,
  accountIndex: number,
  state: WalletStateBytes,
  /** Required so it cannot be forgotten — an unstamped state is what made a switch return the wrong chain's coins. */
  network: string,
): Effect.Effect<void, ShieldedStoreError> =>
  Effect.gen(function* () {
    yield* set(shieldedStateKey(groupId, accountIndex), toHex(state))
    // Stamp after the state: a stamp without its state would claim a network for nothing, while a state
    // without its stamp reads exactly as the legacy case already does.
    yield* set(shieldedNetworkKey(groupId, accountIndex), network)
    // Announced after the write: a balance already on screen has no other way to learn a sync landed.
    yield* publishStoreChange('midnight-shielded')
  })

/**
 * The cursor, if it belongs to `network`.
 *
 * ⚠️ **A cursor from another chain is worse than none.** `syncWindow` reads `cursor === undefined` as
 * "first sync", which is what makes it collapse the commitment tree to the start height; a cursor left
 * behind by another network therefore both skipped the collapse and resumed at that chain's height —
 * applying blocks to a blank tree at positions no block ever held. It also defeated the catch-up check
 * of plan item 62(a) in the one direction that matters: a cursor from a longer chain reads as `current`
 * against a shorter one's tip, so a send builds from a wallet that has never scanned the network it is
 * sending on.
 */
export const loadShieldedCursor = (
  groupId: string,
  accountIndex: number,
  network: string,
): Effect.Effect<number | undefined, ShieldedStoreError> =>
  Effect.gen(function* () {
    if (!(yield* belongsToNetwork(groupId, accountIndex, network, 'cursor'))) return undefined
    return parseStoredCursor(yield* get(shieldedCursorKey(groupId, accountIndex)))
  })

/** A cursor write is advisory — losing it costs a rescan, so it warns rather than throws. */
export const saveShieldedCursor = (groupId: string, accountIndex: number, height: number): Effect.Effect<void> =>
  set(shieldedCursorKey(groupId, accountIndex), String(height)).pipe(
    Effect.catchTag('ShieldedStoreError', (error) =>
      Effect.sync(() => {
        logger.warn('failed to persist the shielded sync cursor', {origin: ORIGIN, error: error.reason})
      }),
    ),
  )

/**
 * Decode a stored birthday. `undefined` for absent **and for malformed**, which is the one case here
 * where the two collapse safely: a birthday is an optimisation over rescanning, so an unreadable one
 * costs a bounded tip-window sync rather than anything irreversible.
 */
export const parseStoredBirthday = (raw: string | null): ShieldedBirthday | undefined => {
  if (raw === null || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const row = parsed as Record<string, unknown>
    const height = row.height
    const origin = row.origin
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1) return undefined
    if (origin !== 'created' && origin !== 'recovered' && origin !== 'declared') return undefined
    return {height, origin}
  } catch (error) {
    logger.warn('stored shielded birthday could not be read; syncing from the tip window instead', {
      origin: ORIGIN,
      error: String(error),
    })
    return undefined
  }
}

export const loadShieldedBirthday = (
  groupId: string,
  network: string,
): Effect.Effect<ShieldedBirthday | undefined, ShieldedStoreError> =>
  get(shieldedBirthdayKey(groupId, network)).pipe(Effect.map(parseStoredBirthday))

/**
 * Record where this wallet's history starts.
 *
 * ⚠️ **Never overwrites an earlier height with a later one.** A birthday only ever moves *earlier*: a
 * `recovered` record arriving after a `created` one describes the same seed, and taking the later of
 * the two would skip the blocks between them — silently, and permanently, since nothing rescans.
 */
export const saveShieldedBirthday = (
  groupId: string,
  network: string,
  birthday: ShieldedBirthday,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const existing = yield* loadShieldedBirthday(groupId, network)
    if (existing !== undefined && existing.height <= birthday.height) {
      logger.debug('shielded birthday kept: the stored one is not later', {
        origin: ORIGIN,
        groupId,
        network,
        stored: existing.height,
        offered: birthday.height,
      })
      return
    }
    yield* set(shieldedBirthdayKey(groupId, network), JSON.stringify(birthday))
    logger.info('shielded birthday recorded', {
      origin: ORIGIN,
      groupId,
      network,
      height: birthday.height,
      birthdayOrigin: birthday.origin,
    })
  }).pipe(
    Effect.catchTag('ShieldedStoreError', (error) =>
      Effect.sync(() => {
        // Advisory, like the cursor: losing it costs a bounded rescan window, not coins.
        logger.warn('failed to persist the shielded birthday', {origin: ORIGIN, error: error.reason})
      }),
    ),
  )

/**
 * Forget everything this wallet has scanned, so the next sync starts from its birthday again.
 *
 * ⚠️ **Destructive, and the only operation here that is.** A tree cannot be collapsed *backwards*:
 * starting an earlier scan means rebuilding it from nothing, so the state and the cursor both go. What
 * that costs is bounded today — every coin the state holds was found by scanning and will be found
 * again — but it would not be bounded if anything called `walletInsertCoin`, whose coins exist nowhere
 * else. Nothing does (plan item 61(b) is where that changes), and this must be revisited when it does.
 *
 * The **birthday is deliberately kept**: it is the thing the rescan starts from.
 */
export const resetShieldedScan = (groupId: string, accountIndex: number): Effect.Effect<void, ShieldedStoreError> =>
  Effect.gen(function* () {
    // Cursor first: a crash between the two leaves a state with no cursor, which re-scans from the
    // birthday — the very thing being asked for. The other order leaves a cursor claiming coverage the
    // state no longer has.
    yield* remove(shieldedCursorKey(groupId, accountIndex))
    yield* remove(shieldedStateKey(groupId, accountIndex))
    logger.warn('shielded scan reset — the wallet will rebuild its coins from its birthday', {
      origin: ORIGIN,
      groupId,
      accountIndex,
    })
    yield* publishStoreChange('midnight-shielded')
  })
