/**
 * Per-account Cardano account context, derived from the persisted derive-only
 * base address (CIP-1852 `m/1852'/1815'/ACCOUNT'/0/0`, the same shape
 * `deriveCardanoAddress` stored per account). The account index parameterizes
 * the signing-key paths so account N's witnesses derive under `.../N'/…`.
 *
 * @module
 */

import {Address as EvolutionAddress} from '@evolution-sdk/evolution'
import {type AddressHex, type Bech32, KeyHashHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import type {OwnedSigningKey, ScriptSpendAuthority, WalletContext} from '@pnyx/tx-review'
import {Data, Effect} from 'effect'
import type {IdentityCardanoCreds} from '../identity-cardano-creds'

/** CIP-1852 payment (external role 0, index 0) path for an account. */
export const cardanoPaymentPath = (account: number): string => `m/1852'/1815'/${account}'/0/0`
/** CIP-1852 stake (role 2, index 0) path for an account. */
export const cardanoStakePath = (account: number): string => `m/1852'/1815'/${account}'/2/0`
/** CIP-1852 account root path. */
export const cardanoAccountPath = (account: number): string => `m/1852'/1815'/${account}'`
/**
 * CIP-**1854** account root path — the shared-wallet chain.
 *
 * A different purpose index, so a completely different key from
 * {@link cardanoAccountPath} at the same account. This is the one a shared
 * wallet's roster names a co-signer by; the 1852 one is the wallet's own
 * spending account. Never interchangeable.
 */
export const cardanoSharedAccountPath = (account: number): string => `m/1854'/1815'/${account}'`
/** CIP-1852 path for any receive (`external`, role 0) or change (`internal`, role 1) address. */
export const cardanoAddressPath = (account: number, branch: 'external' | 'internal', index: number): string =>
  `m/1852'/1815'/${account}'/${branch === 'internal' ? 1 : 0}/${index}`

// Account-0 constants kept for callers still pinned to account 0 (the dApp
// data-sign path resolution, tests); account-aware code uses the builders.
export const CARDANO_PAYMENT_PATH = cardanoPaymentPath(0)
export const CARDANO_STAKE_PATH = cardanoStakePath(0)
export const CARDANO_ACCOUNT_PATH = cardanoAccountPath(0)

export class CardanoAccountError extends Data.TaggedError('CardanoAccountError')<{
  readonly reason: string
}> {}

/**
 * What authorises a spend from this account.
 *
 * `'key'` is the ordinary wallet: its own signature is sufficient and complete.
 *
 * `'script'` is a CIP-1854 shared wallet. The account still knows which keys
 * *it* can contribute (`keyRegistry`), but its signature alone never completes a
 * transaction, and every spend must carry the native scripts plus whatever
 * validity interval the script's time locks demand. Carrying that here rather
 * than at each flow is what lets send, stake, consolidation and dust build a
 * spendable transaction without knowing which kind of wallet they are serving.
 */
/**
 * One payment index a script wallet can spend at, and what authorises it there.
 *
 * A CIP-1854 wallet compiles a different script at every payment index, because
 * every co-signer's key differs there. So this is per index, not per wallet: the
 * leaves that authorise a spend at index 0 authorise nothing at index 3.
 */
export type ScriptIndexAuthority = {
  readonly keyIndex: number
  /** Payment credential (script hash) of the address this index's script guards. */
  readonly scriptHashHex: string
  readonly nativeScriptHex: string
  /**
   * Every key hash the script names, at this index.
   *
   * A script address exposes only a script hash, so nothing downstream can work
   * these out from the transaction — see `resolveCardanoSigningPaths`. Passing
   * them is what makes our own key resolve to a signing path, and what lets the
   * quorum panel name the co-signers still missing.
   */
  readonly signerKeyHashes: readonly string[]
  /** Distinct witnesses this index's script requires. */
  readonly requiredSigners: number
}

/**
 * The stake side of a script wallet: one delegation script for the whole
 * account.
 *
 * Not per index, and that asymmetry is CIP-1854's: payment keys rotate at
 * `.../0/i` while stake keys are pinned at `.../2/0`, so every address of a
 * shared wallet shares one reward address and one delegation script. A wallet
 * therefore delegates once, whatever its funds are spread across.
 *
 * Its leaves are the co-signers' *stake* key hashes — a different set from any
 * payment index's, so a witness made for a spend authorises no delegation and
 * vice versa.
 */
export type ScriptStakeAuthority = {
  /** Stake credential (script hash) the reward address and certificates name. */
  readonly scriptHashHex: string
  readonly nativeScriptHex: string
  readonly signerKeyHashes: readonly string[]
  readonly requiredSigners: number
}

export type SpendAuthority =
  | {readonly kind: 'key'}
  | {
      readonly kind: 'script'
      /**
       * Every payment index this account may spend at, ascending, the spending
       * index first.
       *
       * More than one is ordinary: the ledger is perfectly willing to spend two
       * indexes in one transaction, carrying a script and a witness set for each,
       * and an ordinary key wallet already does exactly that across its own
       * addresses. What used to make it impossible here was the envelope, not the
       * chain.
       */
      readonly indexes: readonly ScriptIndexAuthority[]
      /**
       * What authorises this account's *stake* credential — delegating,
       * deregistering, withdrawing rewards.
       *
       * Always present rather than optional: a CIP-1854 wallet is defined by
       * both templates, so there is no shared wallet without one, and an
       * optional field is one a staking path could forget to read.
       */
      readonly stake: ScriptStakeAuthority
      /** Bounds the script's time locks demand; `null` where unconstrained. */
      readonly validity: {readonly invalidBefore: bigint | null; readonly invalidHereafter: bigint | null}
      /**
       * The wallet group whose credential signs our share.
       *
       * A script wallet has no key of its own, so a signing request against it
       * must be redirected at the group that contributed our co-signer xpub —
       * otherwise the vault is asked for a seed that was never stored under
       * this id. `null` when the roster does not include us.
       */
      readonly signingGroupId: string | null
    }

/** The ordinary case, so existing construction says nothing about authority. */
export const KEY_AUTHORITY: SpendAuthority = {kind: 'key'}

/**
 * What signing-path resolution needs from the account's authority: the leaf key
 * hashes no address exposes, and the script each belongs to.
 *
 * One entry per payment index, because a spend may draw on several and a witness
 * made at one authorises nothing at another. `undefined` for a key wallet, where
 * the addresses already say both.
 */
export const authorityScriptContexts = (authority: SpendAuthority): readonly ScriptSpendAuthority[] | undefined =>
  authority.kind === 'script'
    ? authority.indexes.map((i) => ({scriptHashHex: i.scriptHashHex, signerKeyHashes: i.signerKeyHashes}))
    : undefined

/**
 * The same, taken from an account. The overwhelmingly common call shape, and it
 * removes the chance of pairing one account's authority with another's
 * credentials.
 */
export const accountScriptContext = (account: CardanoAccountContext): readonly ScriptSpendAuthority[] | undefined =>
  authorityScriptContexts(account.authority)

/** Every native script a script authority's spends must carry, in index order. */
export const authorityNativeScripts = (authority: SpendAuthority): readonly string[] =>
  authority.kind === 'script' ? authority.indexes.map((i) => i.nativeScriptHex) : []

/**
 * The delegation script's authority, or `undefined` for a key wallet.
 *
 * Deliberately not folded into {@link authorityPlanFields}: the ledger rejects a
 * transaction carrying a native script nothing in it needs
 * (`ExtraneousScriptWitnessesUTXOW`), so an ordinary send that shipped the
 * delegation script would be invalid rather than merely larger. Only a
 * transaction that names the stake credential — a certificate or a withdrawal —
 * may carry it.
 */
export const authorityStakeContext = (authority: SpendAuthority): ScriptStakeAuthority | undefined =>
  authority.kind === 'script' ? authority.stake : undefined

/**
 * Plan fields an authority contributes to every spend.
 *
 * One place, so a flow cannot build a script spend that forgets the scripts (it
 * would fail phase-1) or the validity interval (a time-locked script fails
 * whenever it is submitted without one).
 *
 * The witness budget sums every index's quorum: a 2-of-3 spending two indexes is
 * charged for four signatures, because that is how many the transaction will
 * carry by the time it can be submitted. Sizing for one index's worth leaves it
 * under-funded exactly when the last co-signer signs.
 */
export const authorityPlanFields = (
  authority: SpendAuthority,
): {
  readonly nativeScripts?: readonly string[]
  readonly ttl?: number
  readonly extraSigners: number
} =>
  authority.kind === 'key'
    ? {extraSigners: 0}
    : {
        nativeScripts: authorityNativeScripts(authority),
        ...(authority.validity.invalidHereafter === null ? {} : {ttl: Number(authority.validity.invalidHereafter)}),
        // A quorum's worth of witnesses per index, less the one an ordinary build
        // assumes.
        extraSigners: Math.max(0, authority.indexes.reduce((sum, i) => sum + i.requiredSigners, 0) - 1),
      }

export type CardanoAccountContext = {
  /**
   * The account's own address, typed.
   *
   * ⚠️ This is the one the COMPUTE path uses — provider queries, output building, ownership
   * checks. The two string forms below are not interchangeable with it: `addressBech32` is the
   * display and map-key form, `addressHex` the CIP-30 wire form. Carrying the typed value here
   * is what stops every caller re-decoding a string the account already validated, which is
   * where `Address.fromBech32` was being called once per sync, per send and per history page.
   */
  readonly address: EvolutionAddress.Address
  readonly addressBech32: Bech32
  /** Raw address bytes, hex (CIP-30 wire form). */
  readonly addressHex: AddressHex
  /**
   * NOT `KeyHashHex`: a shared wallet's credential is a SCRIPT hash of the same
   * length and shape (see `cardanoAccountFromSharedWallet`, which writes one here).
   * `authority.kind` is what says which it is — branding this would assert something
   * the value does not carry.
   */
  readonly paymentKeyHashHex: string
  /**
   * `null` for a wallet watching a bare address. An enterprise address carries no
   * stake credential at all, so there is no account to delegate, withdraw from or
   * enumerate — every such path must check rather than assume one exists.
   */
  /** A key hash, or a script hash for a shared wallet — see {@link paymentKeyHashHex}. */
  readonly stakeKeyHashHex: string | null
  /** Keys this wallet can sign with, mapped to their BIP-32 paths. */
  readonly keyRegistry: readonly OwnedSigningKey[]
  /** Ownership context for @pnyx/tx-review. */
  readonly walletContext: WalletContext
  /**
   * What authorises a spend. Always `'key'` for an address-derived account —
   * a script account is built by its own constructor.
   */
  readonly authority: SpendAuthority
  /**
   * The account's reward address.
   *
   * Computed here rather than by each caller from `stakeKeyHashHex`, because a
   * script account's stake credential is a script hash and needs the script
   * reward encoding — a caller reaching for the key encoding would silently
   * build the wrong address.
   */
  readonly rewardAddressBech32: Bech32 | null
  /** The same reward address as raw bytes, so callers need no codec to read it. */
  readonly rewardAddressHex: AddressHex | null
}

/**
 * Build the account context from the stored bech32 base address for account
 * `accountIndex` (default 0). The index drives the signing-key paths so account
 * N's payment/stake witnesses derive under `.../N'/…`. Fails when the address is
 * not a key-credential base address (never stored by us).
 *
 * `identity` is the forum identity's persisted Cardano key-hash pair, threaded
 * into the review context so its addresses read as the user's rather than a
 * counterparty's.
 */
export const cardanoAccountFromAddress = (
  addressBech32: Bech32,
  accountIndex = 0,
  identity?: IdentityCardanoCreds | null,
  /**
   * The account's other derived addresses (the gap-scanned book). Their payment
   * credentials join the review's own-set, so paying one of our own receive
   * addresses reads as our own rather than as a stake-key hijack.
   */
  extraAddressesBech32: readonly Bech32[] = [],
  /**
   * `bech32 → CIP-1852 path` for those addresses, when the caller knows it.
   *
   * Without it an address can be *recognised* as ours but not *signed for*, and
   * that gap was a real bug: a send spending a UTxO at a non-primary address went
   * out missing that address's witness, because the key registry only ever held
   * the primary payment path. An address whose path is unknown is therefore
   * deliberately left out of the registry rather than guessed at — a wrong path
   * derives a wrong key and produces a witness the ledger rejects.
   */
  addressPaths: ReadonlyMap<string, string> = new Map(),
): Effect.Effect<CardanoAccountContext, CardanoAccountError | CoreError> =>
  Effect.gen(function* () {
    const addressHex = yield* Effect.try({
      try: () => Address.fromBech32Sync(addressBech32),
      catch: (e) =>
        new CardanoAccountError({reason: `invalid cardano address: ${e instanceof Error ? e.message : String(e)}`}),
    })
    const info = yield* Effect.try({
      try: () => Address.inspect(addressHex),
      catch: (e) =>
        new CardanoAccountError({reason: `uninspectable address: ${e instanceof Error ? e.message : String(e)}`}),
    })
    // A stake credential is optional: an enterprise address has none, and a wallet
    // may legitimately watch one. A *script* payment or stake credential is still
    // refused — we can neither derive nor spend those.
    if (info.paymentCredHex === undefined || info.paymentIsScript === true || info.stakeIsScript === true) {
      return yield* Effect.fail(
        new CardanoAccountError({reason: `expected a key payment credential, got ${info.kind}`}),
      )
    }
    // Both credentials are key hashes by the guard above — `Address.inspect` reports a
    // credential, which may be a script hash of the same shape, and the script cases
    // have just been refused.
    const stakeCredHex = info.stakeCredHex === undefined ? null : KeyHashHex(info.stakeCredHex)
    const paymentCredHex = KeyHashHex(info.paymentCredHex)
    // Every address of this account shares its stake credential, so requiring a
    // match keeps hijack detection meaningful: a foreign address that reuses our
    // stake key still classifies as a hijack, because its payment credential
    // never enters this set.
    const paymentKeyHashes = new Set([paymentCredHex])
    // The primary payment key and the stake key; every other owned address whose
    // path we know joins below, so a transaction spending one of them can be
    // witnessed.
    const keyRegistry: OwnedSigningKey[] = [
      {keyHashHex: paymentCredHex, path: cardanoPaymentPath(accountIndex)},
      ...(stakeCredHex !== null ? [{keyHashHex: stakeCredHex, path: cardanoStakePath(accountIndex)}] : []),
    ]
    const registered = new Set<string>([paymentCredHex, ...(stakeCredHex !== null ? [stakeCredHex] : [])])
    for (const bech32 of extraAddressesBech32) {
      if (bech32 === addressBech32) continue
      const extra = yield* Effect.try({
        try: () => Address.inspect(Address.fromBech32Sync(bech32)),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null))
      if (extra === null) continue
      if (extra.paymentCredHex === undefined || extra.paymentIsScript === true) continue
      // Without a stake credential there is no account to belong to, so the wallet is
      // exactly the one address it was given and no extra can join it.
      if (stakeCredHex === null || extra.stakeCredHex !== stakeCredHex) continue
      const extraCredHex = KeyHashHex(extra.paymentCredHex)
      paymentKeyHashes.add(extraCredHex)
      const path = addressPaths.get(bech32)
      if (path === undefined || registered.has(extraCredHex)) continue
      registered.add(extraCredHex)
      keyRegistry.push({keyHashHex: extraCredHex, path})
    }

    const network = info.networkId === 1 ? Address.Network.Mainnet : Address.Network.Testnet
    const rewardAddressHex = stakeCredHex === null ? null : Address.rewardHex(network, stakeCredHex)
    const rewardAddressBech32 = rewardAddressHex === null ? null : Address.toBech32Sync(rewardAddressHex)

    const address = yield* Effect.try({
      try: () => EvolutionAddress.fromBech32(addressBech32),
      catch: (e) =>
        new CardanoAccountError({reason: `invalid cardano address: ${e instanceof Error ? e.message : String(e)}`}),
    })

    return {
      address,
      addressBech32,
      addressHex,
      paymentKeyHashHex: paymentCredHex,
      stakeKeyHashHex: stakeCredHex,
      authority: KEY_AUTHORITY,
      rewardAddressBech32,
      rewardAddressHex,
      keyRegistry,
      walletContext: {
        paymentKeyHashes,
        ...(stakeCredHex !== null ? {stakeKeyHashHex: stakeCredHex} : {}),
        // Lets review tell "the forum identity received this" from "a stranger
        // received this". Absent on installs predating the persisted pair —
        // the ID simply isn't recognised, never guessed at.
        ...(identity != null
          ? {
              identity: {
                paymentKeyHashes: new Set([identity.paymentKeyHashHex]),
                stakeKeyHashHex: identity.stakeKeyHashHex,
              },
            }
          : {}),
      },
    } satisfies CardanoAccountContext
  })
