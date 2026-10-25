/**
 * Cardano receive-address derivation — derive-only.
 *
 * CIP-1852 base address over Icarus BIP32-Ed25519: `mnemonic → entropy → root key →
 * payment key (role 0) + stake key (role 2) → blake2b-224 key hashes → base address`.
 * ⚠️ **Nothing here requires a service any more.** Every function used to leave `Codec` in its
 * requirement channel so the backend stayed the caller's choice, provided once by the app's codec
 * runtime — and the hazard that bought was real: providing one here would have shadowed
 * the outer instrument, which Effect resolves innermost-first, so a differ would have reported a
 * clean run over work it never saw. There is no service to provide now: `@pnyx/cardano-core`'s
 * tiers call Evolution directly.
 *
 * Unlike the SLIP-0010 chains (BTC/EVM/SOL), Cardano derives from the raw BIP-39
 * **entropy**, not the PBKDF2 seed — so this takes the mnemonic directly.
 *
 * @module
 */

import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys, Wallet} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'
import {DerivationError} from '../../errors.js'

// `XpubHex(…)` at each `Keys.*` call is the brand boundary. Agora carries account xpubs
// as plain hex — they cross persistence, the hardware bridge and the UI, none of which
// the library's brands reach — and every one branded here is an xpub by construction:
// `publicKey ‖ chaincode` below, or the device's CIP-1852 account key. Nominal brand,
// zero runtime cost; it asserts provenance, not shape (the codec still rejects garbage).

export type CardanoDeriveOptions = {
  readonly account?: number
  readonly index?: number
  readonly network?: Address.Network
}

const pathOf = (account: number, role: number, index: number): string => `m/1852'/1815'/${account}'/${role}/${index}`

/** Derive the Cardano base (payment + stake) address (bech32) from a mnemonic. */
export const deriveCardanoAddress = (
  mnemonic: string,
  options: CardanoDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const account = options.account ?? 0
  const index = options.index ?? 0
  const network = options.network ?? Address.Network.Mainnet
  return Wallet.fromMnemonic(mnemonic, account).pipe(
    Effect.flatMap((acc) => acc.baseAddress(network, index)),
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano address: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: pathOf(account, 0, index),
        }),
    ),
  )
}

/** A derived base address in the wallet's HD address book. */
export type CardanoBookAddress = {
  /** 0 = external (receive), 1 = internal (change). */
  readonly role: 0 | 1
  readonly index: number
  readonly bech32: string
  /** Raw address bytes, hex. */
  readonly addressHex: string
  /** blake2b-224 payment key hash. */
  readonly paymentKeyHashHex: string
}

/** The wallet's HD address book for one Cardano account (public data only). */
export type CardanoAddressBook = {
  readonly external: readonly CardanoBookAddress[]
  readonly internal: readonly CardanoBookAddress[]
  readonly stakeKeyHashHex: string
  readonly rewardAddressBech32: string
  /** Account-level extended public key (pubkey‖chaincode), hex — for CIP-95 / future. */
  readonly accountXpubHex: string
}

const HARDENED = 0x80000000
const netOf = (options: {readonly network?: Address.Network}): Address.Network =>
  options.network ?? Address.Network.Mainnet

/**
 * The CIP-1852 account-level extended public key (pubkey ‖ chaincode, hex) for
 * `account`. Public data — safe to persist; enables CIP-95 pub-key export and
 * (with a public-derivation primitive) xpub-only discovery. Derived from the
 * mnemonic (root xprv), so run it while the seed is available (a ceremony).
 */
export const deriveCardanoAccountXpub = (mnemonic: string, account = 0): Effect.Effect<string, DerivationError> =>
  Keys.rootKeyFromMnemonic(mnemonic).pipe(
    Effect.flatMap((root) =>
      Keys.derivePath(root, [(1852 | HARDENED) >>> 0, (1815 | HARDENED) >>> 0, (account | HARDENED) >>> 0]),
    ),
    Effect.flatMap((acctXprv) => Keys.publicKey(acctXprv).pipe(Effect.map((pub) => pub + acctXprv.slice(-64)))),
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano account xpub: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: `m/1852'/1815'/${account}'`,
        }),
    ),
  )

/** The wallet's account-level public keys for CIP-95 + device-identity (public data only). */
export type CardanoGovKeys = {
  /** DRep public key (role 3, index 0), hex — CIP-95 `getPubDRepKey`. */
  readonly drepPubKeyHex: string
  /** Stake public key (role 2, index 0), hex — CIP-95 stake-key getters. */
  readonly stakePubKeyHex: string
  /**
   * CIP-**1854** account-level extended public key (pubkey‖chaincode), hex — the
   * key a shared wallet's roster names this account by.
   *
   * A different purpose index from {@link accountXpubHex} and therefore a
   * completely different key. Kept in the same record because it shares that
   * one's whole lifecycle — same seed, same account index, public and safe to
   * persist, derivable only inside a ceremony — so one read and one backfill
   * serve both. Never interchangeable with it: handing this to the
   * hardware device-identity check or to CIP-95 would compare the wrong key.
   *
   * Optional because records written before this existed do not carry it;
   * absence means "not derived yet", never "this wallet has none".
   */
  readonly sharedAccountXpubHex?: string
  /** CIP-1852 account-level extended public key (pubkey‖chaincode), hex — device-identity + CIP-95. */
  readonly accountXpubHex: string
}

/**
 * Derive the account's CIP-95 governance/stake public keys + account xpub from a
 * mnemonic. All PUBLIC data — safe to persist. Runs from the root xprv, so call
 * inside a ceremony (seed available); store only the returned public forms.
 */
export const deriveCardanoGovKeys = (mnemonic: string, account = 0): Effect.Effect<CardanoGovKeys, DerivationError> =>
  Keys.rootKeyFromMnemonic(mnemonic).pipe(
    Effect.flatMap((root) =>
      Effect.gen(function* () {
        const drepPubKeyHex = yield* Keys.deriveCip1852(root, account, 3, 0).pipe(Effect.flatMap(Keys.publicKey))
        const stakePubKeyHex = yield* Keys.deriveCip1852(root, account, 2, 0).pipe(Effect.flatMap(Keys.publicKey))
        const acctXprv = yield* Keys.derivePath(root, [
          (1852 | HARDENED) >>> 0,
          (1815 | HARDENED) >>> 0,
          (account | HARDENED) >>> 0,
        ])
        const accountXpubHex = (yield* Keys.publicKey(acctXprv)) + acctXprv.slice(-64)
        // The same account under CIP-1854, which is what a shared wallet's roster
        // names this wallet by. Derived here rather than on demand so that
        // matching a roster entry to a local wallet costs no biometric prompt —
        // without it, "which co-signer am I?" is unanswerable offline.
        const sharedAcctXprv = yield* Keys.derivePath(root, [
          (1854 | HARDENED) >>> 0,
          (1815 | HARDENED) >>> 0,
          (account | HARDENED) >>> 0,
        ])
        const sharedAccountXpubHex = (yield* Keys.publicKey(sharedAcctXprv)) + sharedAcctXprv.slice(-64)
        return {drepPubKeyHex, stakePubKeyHex, accountXpubHex, sharedAccountXpubHex} satisfies CardanoGovKeys
      }),
    ),
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano gov keys: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: `m/1852'/1815'/${account}'`,
        }),
    ),
  )

/**
 * The same record, assembled for an account whose seed this device never holds —
 * a hardware wallet.
 *
 * Both account-level xpubs come from the device (the CIP-1852 one is already in
 * hand from the import, the CIP-1854 one costs the extra call this exists for).
 * The DRep and stake keys are then CKDpub children of the 1852 xpub: roles 3 and
 * 2 at index 0 are **non-hardened**, so they derive from public material alone
 * and cost no further device round-trip.
 *
 * Kept separate from {@link deriveCardanoGovKeys} rather than folded into it
 * behind an optional mnemonic: the two have different inputs, different failure
 * modes and different trust stories, and a single function taking "a seed or two
 * xpubs" would have to state which it used for a caller to reason about the
 * result at all.
 */
export const deriveCardanoGovKeysFromAccountXpub = (keys: {
  readonly accountXpubHex: string
  readonly sharedAccountXpubHex: string
  readonly account?: number
}): Effect.Effect<CardanoGovKeys, DerivationError> =>
  Effect.gen(function* () {
    const drepPubKeyHex = (yield* Keys.derivePublicPath(XpubHex(keys.accountXpubHex), [3, 0])).slice(0, 64)
    const stakePubKeyHex = (yield* Keys.derivePublicPath(XpubHex(keys.accountXpubHex), [2, 0])).slice(0, 64)
    return {
      drepPubKeyHex,
      stakePubKeyHex,
      accountXpubHex: keys.accountXpubHex,
      sharedAccountXpubHex: keys.sharedAccountXpubHex,
    } satisfies CardanoGovKeys
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano gov keys from account xpub: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: `m/1852'/1815'/${keys.account ?? 0}'`,
        }),
    ),
  )

/**
 * The stake (role 2, index 0) key hash derived from the account xpub via the
 * seedless public path (CKDpub). Public data — no seed required.
 */
const stakeKeyHashFromXpub = (accountXpubHex: string): Effect.Effect<string, CoreError> =>
  Keys.derivePublicPath(XpubHex(accountXpubHex), [2, 0]).pipe(
    Effect.map((childXpub) => childXpub.slice(0, 64)),
    Effect.flatMap(Keys.keyHash),
  )

/**
 * The payment (role 0 = external, 1 = internal) key hash at `index`, derived
 * from the account xpub via the seedless public path (CKDpub).
 */
const paymentKeyHashFromXpub = (accountXpubHex: string, role: 0 | 1, index: number): Effect.Effect<string, CoreError> =>
  Keys.derivePublicPath(XpubHex(accountXpubHex), [role, index]).pipe(
    Effect.map((childXpub) => childXpub.slice(0, 64)),
    Effect.flatMap(Keys.keyHash),
  )

/**
 * Derive the HD address book (external role 0 + internal role 1, indices
 * `from..count-1`, sharing the one stake key) from the CIP-1852 **account xpub**
 * (pubkey ‖ chaincode, 128 hex). Seedless — every key is reached via BIP32-
 * Ed25519 public-child derivation (CKDpub), so no mnemonic / ceremony is
 * required. All returned data is public.
 *
 * `from` exists so a caller growing a book can pay for the **extension only**.
 * A gap scan that doubles its book (40 → 80 → … → 640) and re-derives from zero
 * each round pays 1240 derivations per role to end up holding 640: measured on a
 * 664-address wallet, that was 37.8 s of a 43 s walk. Deriving `640..1279` and
 * appending costs what the book actually holds.
 *
 * ⚠️ The returned arrays then cover `from..count-1`, **not** `0..count-1` — they
 * are the slice the caller asked for, and it is the caller's job to concatenate
 * them onto what it already had, in index order.
 *
 * `roles` narrows it further, for the same reason. The two roles have unrelated
 * frontiers — one wallet ended at 89 used external addresses and 575 internal ones
 * — so a caller growing them under one shared count derives 640 external addresses
 * to keep the internal scan company, where 160 was enough. A role that is not asked
 * for comes back as an empty array.
 */
export const deriveCardanoAddressBook = (
  accountXpubHex: string,
  options: {
    readonly network?: Address.Network
    readonly count?: number
    readonly from?: number
    readonly roles?: readonly (0 | 1)[]
  } = {},
): Effect.Effect<CardanoAddressBook, DerivationError> => {
  const network = netOf(options)
  const count = options.count ?? 20
  const from = options.from ?? 0
  const roles = options.roles ?? [0, 1]
  return Effect.gen(function* () {
    const stakeKeyHashHex = yield* stakeKeyHashFromXpub(accountXpubHex)
    const rewardAddressBech32 = yield* Address.toBech32(Address.rewardHex(network, stakeKeyHashHex))

    const deriveRole = (role: 0 | 1): Effect.Effect<CardanoBookAddress[], CoreError> =>
      Effect.forEach(
        Array.from({length: Math.max(0, count - from)}, (_, i) => from + i),
        (index) =>
          Effect.gen(function* () {
            const paymentKeyHashHex = yield* paymentKeyHashFromXpub(accountXpubHex, role, index)
            const addressHex = Address.baseHex(network, paymentKeyHashHex, stakeKeyHashHex)
            const bech32 = yield* Address.toBech32(addressHex)
            return {role, index, bech32, addressHex, paymentKeyHashHex} satisfies CardanoBookAddress
          }),
      )

    const external = roles.includes(0) ? yield* deriveRole(0) : []
    const internal = roles.includes(1) ? yield* deriveRole(1) : []
    return {external, internal, stakeKeyHashHex, rewardAddressBech32, accountXpubHex} satisfies CardanoAddressBook
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano address book: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: `m/1852'/1815'/·'`,
        }),
    ),
  )
}

/**
 * Derive one Cardano base (payment + stake) address (bech32) plus its payment
 * key hash from the account xpub, at `role` (0 external / 1 internal) + `index`.
 * Seedless (CKDpub). Powers the {@link AddressGenerator} receive/change path.
 */
export const deriveCardanoBookAddressFromXpub = (
  accountXpubHex: string,
  role: 0 | 1,
  index: number,
  network: Address.Network,
): Effect.Effect<CardanoBookAddress, DerivationError> =>
  Effect.gen(function* () {
    const stakeKeyHashHex = yield* stakeKeyHashFromXpub(accountXpubHex)
    const paymentKeyHashHex = yield* paymentKeyHashFromXpub(accountXpubHex, role, index)
    const addressHex = Address.baseHex(network, paymentKeyHashHex, stakeKeyHashHex)
    const bech32 = yield* Address.toBech32(addressHex)
    return {role, index, bech32, addressHex, paymentKeyHashHex} satisfies CardanoBookAddress
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano address (role ${role}, index ${index}): ${cause instanceof Error ? cause.message : String(cause)}`,
          path: `m/1852'/1815'/·'/${role}/${index}`,
        }),
    ),
  )

/**
 * The Cardano reward (stake) address (bech32) for the account xpub. Seedless
 * (CKDpub over role 2 / index 0). Powers the {@link AddressGenerator} reward path.
 */
export const deriveCardanoRewardAddressFromXpub = (
  accountXpubHex: string,
  network: Address.Network,
): Effect.Effect<string, DerivationError> =>
  Effect.gen(function* () {
    const stakeKeyHashHex = yield* stakeKeyHashFromXpub(accountXpubHex)
    return yield* Address.toBech32(Address.rewardHex(network, stakeKeyHashHex))
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano reward address: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: `m/1852'/1815'/·'/2/0`,
        }),
    ),
  )

/**
 * Gap-limit scan: keep an address once used, stop a role's scan after
 * `gapLimit` consecutive unused. `isUsed(bech32)` reports on-chain activity
 * (UTxOs or txs). Pure over the injected probe — returns the active subset,
 * always including external index 0 (the primary receive address).
 */
export const discoverUsedCardanoAddresses = (
  book: CardanoAddressBook,
  isUsed: (bech32: string) => Effect.Effect<boolean, never>,
  gapLimit = 20,
): Effect.Effect<readonly CardanoBookAddress[], never> =>
  Effect.gen(function* () {
    const active: CardanoBookAddress[] = []
    for (const role of [book.external, book.internal]) {
      let gap = 0
      for (const addr of role) {
        const used = yield* isUsed(addr.bech32)
        if (used) {
          active.push(addr)
          gap = 0
        } else {
          gap++
          if (gap >= gapLimit) break
        }
      }
    }
    const primary = book.external[0]
    if (primary !== undefined && !active.some((a) => a.bech32 === primary.bech32)) active.unshift(primary)
    return active
  })

/** Derive the Cardano reward (stake) address (bech32) from a mnemonic. */
export const deriveCardanoRewardAddress = (
  mnemonic: string,
  options: Omit<CardanoDeriveOptions, 'index'> = {},
): Effect.Effect<string, DerivationError> => {
  const account = options.account ?? 0
  const network = options.network ?? Address.Network.Mainnet
  return Wallet.fromMnemonic(mnemonic, account).pipe(
    Effect.flatMap((acc) => acc.rewardAddress(network)),
    Effect.mapError(
      (cause) =>
        new DerivationError({
          message: `Failed to derive Cardano reward address: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: pathOf(account, 2, 0),
        }),
    ),
  )
}
