/**
 * Group-scoped seed verbs — the narrow, intent-named alternatives to a generic
 * "give me the mnemonic" getter.
 *
 * Phase 16 item 42: a plaintext-mnemonic accessor used to sit on the
 * WalletProvider context, where every `useWalletData()` consumer could reach it
 * and where it appeared in autocomplete beside ordinary wallet state. Each verb
 * here names *why* the plaintext is needed, so reaching for one is a visible
 * decision in review rather than an incidental import.
 *
 * The verb-shaped rule and what it does and does not buy: this is mechanical
 * discipline, not isolation. Nothing prevents a caller importing this module —
 * it makes the callers enumerable and the intent explicit, which is the whole
 * claim (see item 42's rejected-native-custody reasoning).
 *
 * Signing does **not** belong here: it takes key material lazily through
 * `CredentialStoreDeps.retrieveMnemonic`, so the mnemonic never enters a
 * caller's scope at all. Add a verb here only when a *human* must see the words,
 * or when a derivation genuinely needs the seed and returns a derived result.
 *
 * @module
 */

import {Keys} from '@pnyx/cardano-core'
import type {Mnemonic} from '@pnyx/crypto'
import {InvalidMnemonicError, KeyMaterialUnavailableError, type WalletSource} from '@pnyx/wallet'
import {Effect, Either} from 'effect'
import {logger} from '../logger'
import {govKeysAreCurrent, loadCardanoGovKeys, persistCardanoGovKeys} from './cardano/gov-keys'
import {coSignerKeySourceOf, deriveOwnAccountXpub, type IneligibleReason} from './cardano/multisig'
import {createEnclaveMnemonicVault} from './credential-vault'

/**
 * Retrieve a group's mnemonic, mapping vault failure to the errors the app's UI
 * already routes on.
 *
 * **Never `Effect.runPromise` the retrieve directly.** A rejected `runPromise`
 * surfaces a `FiberFailure` whose `message` is Effect's generic default, so the
 * typed `VaultError` — and with it the distinction that drives the UI — is lost.
 * That exact mistake cost a debugging session on the DUST submit path. So this
 * goes through `Effect.either` and maps deliberately:
 *
 * - `key-invalidated` → {@link KeyMaterialUnavailableError}, which routes to the
 *   re-import sheet. It is non-retryable on this device, so looping the signing
 *   overlay would strand the user.
 * - anything else (including `auth-cancelled`) → {@link InvalidMnemonicError},
 *   preserving the existing cancel/retry path.
 *
 * The `VaultError` rides along as `cause` so the Sentry breadcrumb can serialize
 * the native code and message; without it every cause field logs as null.
 */
/**
 * Cache the account's public keys off a ceremony that already holds the seed.
 *
 * Every path that opens the vault passes through here, so this is where the
 * backfill belongs: a wallet created before those keys were persisted acquires
 * them the next time its owner does anything that needs the seed — revealing the
 * recovery phrase, enabling a chain, contributing a co-signer key — rather than
 * waiting for it to happen to sign a transaction.
 *
 * Fire-and-forget and best-effort. It is public data derived from a seed that is
 * already in hand, and no caller of this function is asking for it.
 */
const backfillGovKeys = (groupId: string, mnemonic: Mnemonic): void => {
  void Effect.runPromise(loadCardanoGovKeys(groupId).pipe(Effect.orElseSucceed(() => null)))
    .then((cached) =>
      govKeysAreCurrent(cached)
        ? null
        : Effect.runPromise(persistCardanoGovKeys(groupId, mnemonic).pipe(Effect.orElseSucceed(() => null))),
    )
    .catch((e) => {
      logger.warn('Cardano governance key refresh failed', {origin: 'GroupSeed', groupId, error: String(e)})
    })
}

const retrieveGroupMnemonic = async (groupId: string, authPrompt?: string): Promise<Mnemonic> => {
  const exit = await Effect.runPromise(Effect.either(createEnclaveMnemonicVault().retrieve(groupId, authPrompt)))
  if (exit._tag === 'Right') {
    backfillGovKeys(groupId, exit.right)
    return exit.right
  }
  const vaultError = exit.left
  logger.warn('Enclave mnemonic retrieve failed', {
    origin: 'GroupSeed',
    groupId,
    vaultErrorCode: vaultError.code,
    vaultErrorMessage: vaultError.message,
  })
  if (vaultError.code === 'key-invalidated') {
    throw new KeyMaterialUnavailableError({
      message: 'Biometric key is no longer accessible on this device. Re-import the wallet to continue.',
      cause: vaultError,
    })
  }
  throw new InvalidMnemonicError({
    message: 'Biometric authentication required to retrieve the wallet seed.',
    cause: vaultError,
  })
}

/**
 * Decrypt a wallet group's recovery phrase so the **user** can read it, for
 * backup verification or an encrypted-backup export.
 *
 * Fires the OS biometric / device-passcode prompt inside the keychain read.
 *
 * This is the one category where returning plaintext is the point: the phrase is
 * the thing being displayed. Every other caller wants a derived result and must
 * ask for that instead.
 */
export const revealGroupMnemonicForBackup = (groupId: string, authPrompt?: string): Promise<Mnemonic> =>
  retrieveGroupMnemonic(groupId, authPrompt)

/** Why a co-signer key could not be produced. Each maps to its own message. */
export type CoSignerXpubFailure =
  /** No enclave entry — a hardware, watch-only, or otherwise seedless group. */
  | {readonly kind: 'no-key-material'}
  | {readonly kind: 'auth-cancelled'}
  | {readonly kind: 'key-invalidated'}
  | {readonly kind: 'vault-error'; readonly code: string}
  | {readonly kind: 'derivation-failed'}
  /**
   * A hardware wallet whose CIP-1854 key has never been read off the device —
   * recoverable by reconnecting, which is what separates it from
   * `no-key-material` (a wallet that has no key here at all, ever).
   */
  | {readonly kind: 'device-key-missing'}
  /** This source can never contribute a key; `reason` names which of the three. */
  | {readonly kind: 'ineligible'; readonly reason: IneligibleReason}

/**
 * Derive a group's own CIP-1854 account xpub — its identity in a shared-wallet
 * roster.
 *
 * A derivation verb: the caller receives the account public key and never sees
 * the seed, so the plaintext's residency is bounded by this function rather than
 * by a screen's lifetime. The xpub, not a key hash, is what CIP-1854 says
 * co-signers exchange — it is what lets every participant derive this wallet's
 * key at any index.
 *
 * Returns a typed failure rather than throwing, and reads the raw `VaultError`
 * instead of going through {@link retrieveGroupMnemonic}'s two-way mapping. That
 * mapping collapses `not-found` (this wallet has no seed here — a hardware or
 * watch-only group) into the same error as a cancelled prompt, and the caller
 * showed both as "Enter a valid co-signer key". The distinction is the whole
 * message.
 */
export const deriveGroupCoSignerXpub = async (
  groupId: string,
  authPrompt: string | undefined,
  /**
   * Which account's co-signer key. **Required**, because the account that *derives* the key and the
   * account the message *labels* must be the same value — and they used to be two defaults that
   * happened to match. A key labelled with the wrong index is the `eternl-assigns-keys-by-position`
   * failure, and it lands on the other participants in a shared wallet rather than on this one.
   */
  account: number,
): Promise<Either.Either<string, CoSignerXpubFailure>> => {
  const exit = await Effect.runPromise(Effect.either(createEnclaveMnemonicVault().retrieve(groupId, authPrompt)))
  if (exit._tag === 'Left') {
    const vaultError = exit.left
    logger.warn('Co-signer xpub derivation: vault retrieve failed', {
      origin: 'GroupSeed',
      groupId,
      vaultErrorCode: vaultError.code,
      vaultErrorMessage: vaultError.message,
    })
    switch (vaultError.code) {
      case 'not-found':
        return Either.left({kind: 'no-key-material'})
      case 'key-invalidated':
        return Either.left({kind: 'key-invalidated'})
      case 'auth-cancelled':
        return Either.left({kind: 'auth-cancelled'})
      default:
        return Either.left({kind: 'vault-error', code: vaultError.code})
    }
  }
  const derived = await Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const root = yield* Keys.rootKeyFromMnemonic(exit.right)
        return yield* deriveOwnAccountXpub(root, account)
      }),
    ),
  )
  if (derived._tag === 'Left') {
    logger.warn('Co-signer xpub derivation failed', {origin: 'GroupSeed', groupId, message: derived.left.message})
    return Either.left({kind: 'derivation-failed'})
  }
  // The roster editor derives this wallet's shared xpub here and used to discard
  // it — so the one moment the app knew a wallet's CIP-1854 identity was also the
  // moment it forgot it, and the co-sign screen could not tell later that this
  // wallet was on the roster it had just been added to.
  backfillGovKeys(groupId, exit.right)
  return Either.right(derived.right)
}

/**
 * A group's CIP-1854 co-signer xpub, however that group happens to hold its key.
 *
 * The single entry point for every screen that asks "what is my co-signer key?",
 * so the answer cannot differ between the roster editor, the share screen, the
 * own-wallet picker and registration discovery — four call sites that previously
 * each reached for the seed and each had to be told separately that a hardware
 * wallet has none.
 *
 * - `mnemonic` → the cached xpub when there is one, otherwise derived from the
 *   seed under a biometric ceremony ({@link deriveGroupCoSignerXpub}), which also
 *   writes the cache for next time.
 * - `hardware` → read from the cache written when the device was last connected.
 *   Never a device call from here: a screen that wants one has to run the pair
 *   flow, which is a navigation, not something to do behind a button.
 * - anything else → the reason it can never contribute one.
 *
 * ⚠️ **The cache is read for a seed wallet too, and that is not a weakening.**
 * This used to re-derive every time, on the reasoning that serving the cache
 * would drop a consent ceremony the flow had always had. But the value is a
 * *public* account xpub that `ensureCardanoGovKeys` has already persisted beside
 * the CIP-1852 gov keys — `local-cosigners` reads it with no prompt at all to
 * answer "which co-signer am I?" while signing. So the ceremony was guarding
 * bytes that anything on the device could already read, and charging a couple of
 * seconds and a biometric prompt for it every time a key was shown.
 */
export const resolveGroupCoSignerXpub = async (
  groupId: string,
  source: WalletSource,
  authPrompt: string | undefined,
  /**
   * Which account's co-signer key. **Required**, because the account that *derives* the key and the
   * account the message *labels* must be the same value — and they used to be two defaults that
   * happened to match. A key labelled with the wrong index is the `eternl-assigns-keys-by-position`
   * failure, and it lands on the other participants in a shared wallet rather than on this one.
   */
  account: number,
): Promise<Either.Either<string, CoSignerXpubFailure>> => {
  const keySource = coSignerKeySourceOf(source)
  if (keySource.kind === 'unavailable') return Either.left({kind: 'ineligible', reason: keySource.reason})
  const cached = await Effect.runPromise(loadCardanoGovKeys(groupId, account).pipe(Effect.orElseSucceed(() => null)))
  const xpub = cached?.sharedAccountXpubHex
  if (keySource.kind === 'device') {
    return xpub === undefined ? Either.left({kind: 'device-key-missing'}) : Either.right(xpub)
  }
  // A seed wallet whose gov keys were never ensured — an older record, or one
  // written before the CIP-1854 xpub joined them — falls through to the seed. That
  // path backfills the cache for **account 0** only (`backfillGovKeys`), so a
  // non-zero account still derives each time; nothing about that is silent.
  return xpub === undefined ? deriveGroupCoSignerXpub(groupId, authPrompt, account) : Either.right(xpub)
}

/**
 * The provider's `enableChain` slow path: a chain shipped after this wallet was
 * created has no cached xpub, so `enableChain` needs the seed to derive one.
 *
 * Kept as a distinct name rather than reusing the backup verb, so the two
 * reasons a mnemonic leaves the vault stay separable in a grep.
 */
export const retrieveGroupMnemonicForChainEnable = retrieveGroupMnemonic
