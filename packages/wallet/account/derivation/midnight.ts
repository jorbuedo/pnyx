/**
 * Midnight receive-address derivation.
 *
 * Midnight derives keys at `m/44'/2400'/account'/role/index` over secp256k1 (BIP32 via
 * `@scure/bip32`), with roles: NightExternal 0, NightInternal 1, Dust 2, Zswap 3, Metadata 4.
 *
 * Unlike xpub-only chains, Midnight's DUST and shielded receive addresses are
 * non-BIP32 curve points (BLS12-381 / JubJub) derived from each role's *secret* key — there
 * is no public-only derivation analog — so address generation requires the seed, not an
 * account xpub. Encoding (bech32m, HRP `mn_<type>[_<network>]`) is pure and lives in
 * `./midnight-address-encoding`; the curve math runs through a swappable backend
 * (`./midnight-curve-backend`) — WASM on Node/Web, a native module on React Native.
 *
 * @module
 */

import {HDWallet, type Role, Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {Effect} from 'effect'
import {DerivationError} from '../../errors.js'
import {mnemonicToSeed} from '../seed.js'
import {
  encodeDustAddress,
  encodeNightAddress,
  encodeShieldedAddress,
  type MidnightNetworkId,
} from './midnight-address-encoding.js'
import {midnightCurveBackend} from './midnight-curve-backend.js'

export type {MidnightNetworkId} from './midnight-address-encoding.js'
export {setMidnightLedgerInitializer} from './midnight-curve-backend.js'

/**
 * The set of receive addresses a Midnight wallet exposes for a single (account, index).
 */
export type MidnightReceiveAddresses = {
  /** Unshielded address (`mn_addr…`) — receives unshielded NIGHT / native tokens. */
  readonly night: string
  /** DUST delivery address (`mn_dust…`) — also the value placed in a cNIGHT→DUST registration datum. */
  readonly dust: string
  /** Shielded Zswap address (`mn_shield-addr…`) — receives shielded tokens. */
  readonly shielded: string
}

export type MidnightDeriveOptions = {
  readonly account?: number
  readonly index?: number
  readonly networkId?: MidnightNetworkId
}

const DEFAULTS = {account: 0, index: 0, networkId: 'mainnet' as MidnightNetworkId}

const pathOf = (account: number, role: Role, index: number): string => `m/44'/2400'/${account}'/${role}/${index}`

/** Derive the raw secp256k1 secret key for a role/index, failing on out-of-bounds (hardened-only) indices. */
const deriveRoleKey = (
  seed: Uint8Array,
  role: Role,
  account: number,
  index: number,
): Effect.Effect<Uint8Array, DerivationError> =>
  Effect.try({
    try: () => {
      const wallet = HDWallet.fromSeed(seed)
      if (wallet.type !== 'seedOk') throw wallet.error
      try {
        const result = wallet.hdWallet.selectAccount(account).selectRole(role).deriveKeyAt(index)
        if (result.type !== 'keyDerived') {
          throw new Error(`key out of bounds at ${pathOf(account, role, index)}`)
        }
        // Copy out: the returned value must not alias SDK-internal buffers cleared in `finally`.
        return Uint8Array.from(result.key)
      } finally {
        wallet.hdWallet.clear()
      }
    },
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive Midnight role ${role} key: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: pathOf(account, role, index),
      }),
  })

/**
 * The raw role secret key at `m/44'/2400'/account'/role/index`.
 *
 * ⚠️ **This is secret material**, unlike everything else this module exports. It exists because a
 * shielded *wallet* — as opposed to a receive address — needs the role-3 key itself: coin ownership,
 * ciphertext decryption and spend authority all derive from it, and there is no public-only form
 * (`./midnight-curve-backend` takes the secret key for exactly that reason). Callers must not persist
 * or log it; hand it to the native wallet ops and let it go.
 *
 * Role 2 is Dust and role 3 is Zswap. The published SDK guide said Dust was 4 until
 * `midnightntwrk/midnight-docs#1248`; a wallet built on that number derives its DUST from the
 * metadata key and cannot spend what it generates.
 */
export const deriveMidnightRoleKey = (
  seed: Uint8Array,
  role: Role,
  options: MidnightDeriveOptions = {},
): Effect.Effect<Uint8Array, DerivationError> => {
  const {account, index} = {...DEFAULTS, ...options}
  return deriveRoleKey(seed, role, account, index)
}

/**
 * Derive the unshielded Midnight receive address (`mn_addr…`).
 *
 * Role 0 secp256k1 key → BIP340 Schnorr signing key → verifying key → 32-byte `UserAddress`.
 */
export const deriveMidnightNightAddress = (
  seed: Uint8Array,
  options: MidnightDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const {account, index, networkId} = {...DEFAULTS, ...options}
  return deriveRoleKey(seed, Roles.NightExternal, account, index).pipe(
    Effect.flatMap((key) => midnightCurveBackend.nightPayload(key)),
    Effect.flatMap((payload) =>
      Effect.try({
        try: () => encodeNightAddress(payload, networkId),
        catch: (cause) =>
          new DerivationError({
            message: `Failed to encode Midnight night address: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: pathOf(account, Roles.NightExternal, index),
          }),
      }),
    ),
  )
}

/** Derive the DUST public key (a BLS12-381 scalar) for a role-2 key — the payload behind `mn_dust…`. */
export const deriveMidnightDustPublicKey = (
  seed: Uint8Array,
  options: MidnightDeriveOptions = {},
): Effect.Effect<bigint, DerivationError> => {
  const {account, index} = {...DEFAULTS, ...options}
  return deriveRoleKey(seed, Roles.Dust, account, index).pipe(
    Effect.flatMap((key) => midnightCurveBackend.dustPublicKey(key)),
  )
}

/**
 * Derive the DUST delivery address (`mn_dust…`).
 *
 * Role 2 secp256k1 key → `DustSecretKey` → BLS12-381 scalar public key → SCALE-compact → bech32m.
 */
export const deriveMidnightDustAddress = (
  seed: Uint8Array,
  options: MidnightDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const {networkId} = {...DEFAULTS, ...options}
  return deriveMidnightDustPublicKey(seed, options).pipe(
    Effect.flatMap((publicKey) =>
      Effect.try({
        try: () => encodeDustAddress(publicKey, networkId),
        catch: (cause) =>
          new DerivationError({
            message: `Failed to encode Midnight DUST address: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }),
    ),
  )
}

/**
 * Derive the shielded Zswap receive address (`mn_shield-addr…`).
 *
 * Role 3 secp256k1 key → `ZswapSecretKeys` → JubJub coin + encryption public keys → bech32m.
 */
export const deriveMidnightShieldedAddress = (
  seed: Uint8Array,
  options: MidnightDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const {account, index, networkId} = {...DEFAULTS, ...options}
  return deriveRoleKey(seed, Roles.Zswap, account, index).pipe(
    Effect.flatMap((key) => midnightCurveBackend.shieldedPublicKeys(key)),
    Effect.flatMap(({coin, encryption}) =>
      Effect.try({
        try: () => encodeShieldedAddress(coin, encryption, networkId),
        catch: (cause) =>
          new DerivationError({
            message: `Failed to encode Midnight shielded address: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: pathOf(account, Roles.Zswap, index),
          }),
      }),
    ),
  )
}

/** Derive the full set of Midnight receive addresses (night + dust + shielded) for one (account, index). */
export const deriveMidnightReceiveAddresses = (
  seed: Uint8Array,
  options: MidnightDeriveOptions = {},
): Effect.Effect<MidnightReceiveAddresses, DerivationError> =>
  Effect.all({
    night: deriveMidnightNightAddress(seed, options),
    dust: deriveMidnightDustAddress(seed, options),
    shielded: deriveMidnightShieldedAddress(seed, options),
  })

/**
 * Derive the full set of Midnight receive addresses from a BIP-39 mnemonic.
 *
 * Convenience over {@link deriveMidnightReceiveAddresses} for callers that hold the
 * mnemonic rather than a raw seed; uses the shared {@link mnemonicToSeed} so the seed
 * is byte-identical to every other chain's derivation.
 */
export const deriveMidnightReceiveAddressesFromMnemonic = (
  mnemonic: string,
  options: MidnightDeriveOptions = {},
): Effect.Effect<MidnightReceiveAddresses, DerivationError> =>
  Effect.tryPromise({
    try: () => mnemonicToSeed(mnemonic),
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive seed from mnemonic: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(Effect.flatMap((seed) => deriveMidnightReceiveAddresses(seed, options)))
