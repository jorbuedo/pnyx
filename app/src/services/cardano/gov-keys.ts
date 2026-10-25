/**
 * Per-account Cardano public keys (CIP-95 DRep + stake pub keys + the account
 * xpub for hardware device-identity). PUBLIC data only — persisted over the
 * platform storage layer, keyed by wallet group + account index.
 *
 * Two producers, one record. A software wallet derives from the mnemonic inside
 * an auth ceremony, backfilled lazily by `ensureCardanoGovKeys` (which reads the
 * cache, else derives via the injected `retrieveMnemonic` — the biometric gate).
 * A hardware wallet has no seed here, so `persistDeviceCardanoGovKeys` takes the
 * two account xpubs read from the device instead. Only the public keys are
 * stored — never the seed.
 *
 * @module
 */

import type {StorageError} from '@pnyx/storage'
import {type CardanoGovKeys, deriveCardanoGovKeys, deriveCardanoGovKeysFromAccountXpub} from '@pnyx/wallet'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {createProfileStorage} from '../profile/profile-storage'

export type {CardanoGovKeys}

// Account 0 keeps the legacy suffix-free key so existing caches survive; other
// accounts append `.${account}`.
const keyOf = (groupId: string, account = 0): string =>
  account === 0 ? `cardano.govkeys.${groupId}` : `cardano.govkeys.${groupId}.${account}`

const parse = (raw: string): CardanoGovKeys | null => {
  try {
    return JSON.parse(raw) as CardanoGovKeys
  } catch (e: unknown) {
    // `null` reads as "no governance keys stored", so a corrupt record silently un-registers
    // this wallet's DRep identity.
    logger.warn('Stored governance keys could not be parsed; treating them as absent', {
      origin: 'cardano/gov-keys',
      error: String(e),
    })
    return null
  }
}

/** Read the persisted gov keys for a group + account (null if not derived yet). */
export const loadCardanoGovKeys = (
  groupId: string,
  account = 0,
): Effect.Effect<CardanoGovKeys | null, StorageError> => {
  const storage = createProfileStorage()
  return Effect.map(storage.get(keyOf(groupId, account)), (raw) => (raw === null ? null : parse(raw)))
}

/**
 * Whether a cached record carries everything the app derives today.
 *
 * One predicate, because "is this cache good enough?" is asked at every ceremony
 * that happens to hold the seed, and each of those sites used to spell it
 * `=== null`. That was right until the record grew a field: a wallet with an
 * older record then had a cache that was never null and never complete, so the
 * backfill those sites exist to perform would never have run.
 */
export const govKeysAreCurrent = (keys: CardanoGovKeys | null): keys is CardanoGovKeys =>
  keys !== null && keys.sharedAccountXpubHex !== undefined

/**
 * Derive + persist gov keys from an already-obtained mnemonic (ceremony
 * backfill — no extra prompt when the seed is already in hand). Returns the keys.
 */
export const persistCardanoGovKeys = (
  groupId: string,
  mnemonic: string,
  account = 0,
): Effect.Effect<CardanoGovKeys, StorageError | {readonly message: string}> =>
  Effect.gen(function* () {
    const keys = yield* deriveCardanoGovKeys(mnemonic, account).pipe(Effect.mapError((e) => ({message: e.message})))
    const storage = createProfileStorage()
    yield* storage.set(keyOf(groupId, account), JSON.stringify(keys))
    return keys
  })

/**
 * Persist the same record for an account whose seed lives on a hardware device.
 *
 * The caller supplies both account-level xpubs read from the device; the DRep
 * and stake keys derive from the 1852 one without touching it again. Written
 * only as a complete record — a half-filled one would read as
 * {@link govKeysAreCurrent} `false` forever and re-prompt for the device on
 * every screen that asks.
 */
export const persistDeviceCardanoGovKeys = (
  groupId: string,
  keys: {readonly accountXpubHex: string; readonly sharedAccountXpubHex: string},
  account = 0,
): Effect.Effect<CardanoGovKeys, StorageError | {readonly message: string}> =>
  Effect.gen(function* () {
    const derived = yield* deriveCardanoGovKeysFromAccountXpub({...keys, account}).pipe(
      Effect.mapError((e) => ({message: e.message})),
    )
    const storage = createProfileStorage()
    yield* storage.set(keyOf(groupId, account), JSON.stringify(derived))
    return derived
  })

/**
 * Read the group's gov keys, deriving + persisting them on first use.
 * `retrieveMnemonic` is the ceremony-gated seed read — call from a context where
 * a biometric prompt is acceptable (or a ceremony is already open). The derived
 * mnemonic is used only to produce the public keys and is not retained.
 */
export const ensureCardanoGovKeys = (
  groupId: string,
  retrieveMnemonic: (groupId: string) => Effect.Effect<string, {readonly message: string}>,
  account = 0,
): Effect.Effect<CardanoGovKeys, StorageError | {readonly message: string}> =>
  Effect.gen(function* () {
    const cached = yield* loadCardanoGovKeys(groupId, account)
    // A record written before the CIP-1854 xpub joined is complete for everything
    // that existed then and short for what needs it now. Re-derived rather than
    // served as-is, or "which co-signer am I?" would stay unanswerable for every
    // wallet that predates this — silently, since the field is optional.
    if (cached !== null && cached.sharedAccountXpubHex !== undefined) return cached
    const mnemonic = yield* retrieveMnemonic(groupId)
    const keys = yield* deriveCardanoGovKeys(mnemonic, account).pipe(Effect.mapError((e) => ({message: e.message})))
    const storage = createProfileStorage()
    yield* storage.set(keyOf(groupId, account), JSON.stringify(keys))
    return keys
  })
