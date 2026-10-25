/**
 * Multi-chain address derivation from a stored account-level extended public
 * key (xpub) — no seed, no biometric prompt.
 *
 * A generator wraps one account xpub and derives receive (role 0) / change
 * (role 1) — and, on Cardano, reward (role 2) — addresses via public-child
 * derivation (BIP32 CKDpub for secp256k1, BIP32-Ed25519 CKDpub for Cardano).
 * The same generator instance powers both the receive/change UI and the
 * gap-limit discovery scanner (`./address-chain.ts`).
 *
 * Xpub-derivable families:
 *  - `bip122` (Bitcoin, BIP-84) — 65-byte secp256k1 xpub (33 pub ‖ 32 cc).
 *  - `eip155` (EVM, BIP-44)     — 65-byte secp256k1 xpub; single address.
 *  - `cardano` (CIP-1852)       — 64-byte Ed25519 xpub (32 pub ‖ 32 cc).
 *
 * NOT xpub-derivable (the dispatcher fails honestly for these):
 *  - `midnight` — receive addresses derive from role *secret* keys; persisted
 *    at wallet creation, read from the address table (see `./derivation/midnight.ts`).
 *  - `solana`   — SLIP-0010 ed25519 has no public-child derivation; the single
 *    address is derived from the seed at import and persisted.
 *
 * @module
 */

import {Address as CardanoAddr} from '@pnyx/cardano-core'
import type {ChainId} from '@pnyx/config'
import {getChainNamespace} from '@pnyx/config'
import {HDKey, hex, secp256k1PublicChild, secp256k1Raw64FromCompressed} from '@pnyx/crypto'
import {Effect} from 'effect'
import {DerivationError} from '../errors.js'
import type {Network} from '../types.js'
import {bitcoinAddressFromPublicKey} from './derivation/bitcoin.js'
import {deriveCardanoBookAddressFromXpub, deriveCardanoRewardAddressFromXpub} from './derivation/cardano.js'
import {evmAddressFromRaw64} from './derivation/evm.js'
import type {Address, AddressGenerator, AddressRole} from './derivation/types.js'

export type {Address, AddressGenerator, AddressRole} from './derivation/types.js'

/** BIP-32 mainnet version bytes (xprv / xpub); only `public` is used to serialize a neutered node. */
const SECP256K1_VERSIONS = {private: 0x0488_ade4, public: 0x0488_b21e}

/**
 * Rebuild a base58 `xpub…` string from the stored 65-byte secp256k1 account
 * xpub (33-byte compressed pubkey ‖ 32-byte chain code). CKDpub math only reads
 * the public key + chain code, so the depth/index/parent-fingerprint dropped at
 * persist time do not affect the derived children — the base58 round-trips into
 * `secp256k1PublicChild`.
 */
const secp256k1AccountXpubBase58 = (accountXpub: Uint8Array): string => {
  if (accountXpub.length !== 65) {
    throw new Error(`expected 65-byte secp256k1 account xpub (33 pub ‖ 32 cc), got ${accountXpub.length}`)
  }
  return new HDKey({
    versions: SECP256K1_VERSIONS,
    publicKey: accountXpub.slice(0, 33),
    chainCode: accountXpub.slice(33),
  }).publicExtendedKey
}

/** Build a `deriveRange` from a single-address `derive`. */
const rangeFrom =
  (derive: AddressGenerator['derive']): AddressGenerator['deriveRange'] =>
  (role, start, count) =>
    Effect.forEach(
      Array.from({length: Math.max(0, count)}, (_, i) => start + i),
      (index) => derive(role, index),
    )

const NO_REWARD: AddressGenerator['getRewardAddress'] = () => Effect.succeed(null)

/** A generator for a secp256k1 family (Bitcoin BIP-84 / EVM BIP-44). */
const secp256k1Generator = (params: {
  readonly accountXpub: Uint8Array
  readonly chainId: ChainId
  readonly network: Network
  readonly addressOf: (compressedPubkey: Uint8Array) => string
  readonly supportsMultipleAddresses: boolean
}): Effect.Effect<AddressGenerator, DerivationError> =>
  Effect.try({
    try: () => secp256k1AccountXpubBase58(params.accountXpub),
    catch: (cause) =>
      new DerivationError({
        message: `Invalid secp256k1 account xpub for ${params.chainId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.map((xpubBase58) => {
      const derive = (role: AddressRole, index: number): Effect.Effect<Address, DerivationError> =>
        Effect.try({
          try: () => {
            if (role === 2) throw new Error('secp256k1 chains have no staking role (role 2)')
            return params.addressOf(secp256k1PublicChild(xpubBase58, role, index))
          },
          catch: (cause) =>
            new DerivationError({
              message: `Failed to derive ${params.chainId} address (role ${role}, index ${index}): ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        })
      return {
        chainId: params.chainId,
        derive,
        deriveRange: rangeFrom(derive),
        getRewardAddress: NO_REWARD,
        supportsMultipleAddresses: params.supportsMultipleAddresses,
        hasRewardAddress: false,
      } satisfies AddressGenerator
    }),
  )

const cardanoNetwork = (network: Network): CardanoAddr.Network =>
  network === 'mainnet' ? CardanoAddr.Network.Mainnet : CardanoAddr.Network.Testnet

/**
 * A generator for the Cardano CIP-1852 family (base addresses + reward address).
 *
 * The codec backend is read from context **once, here**, and captured by the derive
 * closures. That is what keeps `AddressGenerator` chain-agnostic — a BTC or EVM
 * generator has no business requiring a Cardano codec — while still leaving the
 * backend the caller's choice rather than this module's.
 */
const cardanoGenerator = (
  accountXpub: Uint8Array,
  chainId: ChainId,
  network: Network,
): Effect.Effect<AddressGenerator, DerivationError> =>
  Effect.gen(function* () {
    const xpubHex = yield* Effect.try({
      try: () => {
        if (accountXpub.length !== 64) {
          throw new Error(`expected 64-byte Cardano account xpub (32 pub ‖ 32 cc), got ${accountXpub.length}`)
        }
        return hex.encode(accountXpub)
      },
      catch: (cause) =>
        new DerivationError({
          message: `Invalid Cardano account xpub: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
    const net = cardanoNetwork(network)
    const reward = deriveCardanoRewardAddressFromXpub(xpubHex, net)
    const derive = (role: AddressRole, index: number): Effect.Effect<Address, DerivationError> =>
      role === 2
        ? reward
        : deriveCardanoBookAddressFromXpub(xpubHex, role, index, net).pipe(Effect.map((a) => a.bech32))
    return {
      chainId,
      derive,
      deriveRange: rangeFrom(derive),
      getRewardAddress: () => reward.pipe(Effect.map((a): Address | null => a)),
      supportsMultipleAddresses: true,
      hasRewardAddress: true,
    } satisfies AddressGenerator
  })

/**
 * Factory function to create an address generator for any supported chain.
 *
 * @param accountXPub - Account-level extended public key. secp256k1 families
 *   (Bitcoin/EVM) store 65 bytes (33-byte compressed pubkey ‖ 32-byte chain
 *   code); Cardano stores 64 bytes (32-byte Ed25519 pubkey ‖ 32-byte chain code).
 * @param chainId - The chain to create a generator for
 * @param network - Network for address encoding (mainnet/testnet)
 * @returns Effect with the appropriate address generator, or a typed failure
 *   for families that are not xpub-derivable (Solana, Midnight).
 */
export const createAddressGeneratorForChain = (
  accountXPub: Uint8Array,
  chainId: ChainId,
  network: Network,
  _options?: {isHardware?: boolean},
): Effect.Effect<AddressGenerator, DerivationError> => {
  switch (getChainNamespace(chainId)) {
    case 'bip122':
      return secp256k1Generator({
        accountXpub: accountXPub,
        chainId,
        network,
        addressOf: (pubkey) => bitcoinAddressFromPublicKey(pubkey, network),
        supportsMultipleAddresses: true,
      })
    case 'eip155':
      return secp256k1Generator({
        accountXpub: accountXPub,
        chainId,
        network,
        addressOf: (pubkey) => evmAddressFromRaw64(secp256k1Raw64FromCompressed(pubkey)),
        // Same address across all EVM chains; the app treats EVM as single-address.
        supportsMultipleAddresses: false,
      })
    case 'cardano':
      return cardanoGenerator(accountXPub, chainId, network)
    case 'midnight':
      return Effect.fail(
        new DerivationError({
          message:
            'Midnight receive addresses derive from role secret keys and are persisted at wallet creation — no xpub-based generator exists (read them from the address table instead)',
        }),
      )
    case 'solana':
      return Effect.fail(
        new DerivationError({
          message:
            'Solana uses SLIP-0010 ed25519 (no public-child derivation) — its address is derived from the seed at import and persisted (read it from the address table instead)',
        }),
      )
    default:
      return Effect.fail(new DerivationError({message: `Address derivation not supported for chain: ${chainId}`}))
  }
}
