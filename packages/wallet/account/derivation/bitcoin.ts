/**
 * Bitcoin receive-address derivation — derive-only, native SegWit (P2WPKH).
 *
 * BIP-84 path `m/84'/coin'/account'/0/index` over secp256k1 (coin 0 mainnet,
 * 1 testnet); address = bech32(HRP, witness-v0, HASH160(compressed pubkey)),
 * HRP `bc` mainnet / `tb` testnet.
 *
 * @module
 */

import {encodeSegwitAddress, hash160, secp256k1PrivateKeyAtPath, secp256k1PublicKeyCompressed} from '@pnyx/crypto'
import {Effect} from 'effect'
import {DerivationError} from '../../errors.js'
import type {Network} from '../../types.js'
import {mnemonicToSeed} from '../seed.js'

export type BitcoinDeriveOptions = {
  readonly account?: number
  readonly index?: number
  readonly network?: Network
}

const paramsFor = (network: Network): {readonly coin: number; readonly hrp: string} =>
  network === 'mainnet' ? {coin: 0, hrp: 'bc'} : {coin: 1, hrp: 'tb'}

const pathOf = (coin: number, account: number, index: number): string => `m/84'/${coin}'/${account}'/0/${index}`

/**
 * The native-SegWit (P2WPKH) address for a compressed secp256k1 public key on
 * the given network. Shared by the seed path and the xpub-based
 * {@link AddressGenerator} so both render identical `bc1…` / `tb1…` forms.
 */
export const bitcoinAddressFromPublicKey = (compressedPubkey: Uint8Array, network: Network): string => {
  const {hrp} = paramsFor(network)
  return encodeSegwitAddress(hrp, 0, hash160(compressedPubkey))
}

/** Derive the Bitcoin native-SegWit address (`bc1…` / `tb1…`) for a seed. */
export const deriveBitcoinAddress = (
  seed: Uint8Array,
  options: BitcoinDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const account = options.account ?? 0
  const index = options.index ?? 0
  const network = options.network ?? 'mainnet'
  const {coin} = paramsFor(network)
  return Effect.try({
    try: () => {
      const pubkey = secp256k1PublicKeyCompressed(secp256k1PrivateKeyAtPath(seed, pathOf(coin, account, index)))
      return bitcoinAddressFromPublicKey(pubkey, network)
    },
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive Bitcoin address: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: pathOf(coin, account, index),
      }),
  })
}

/** Convenience: derive the Bitcoin address straight from a mnemonic. */
export const deriveBitcoinAddressFromMnemonic = (
  mnemonic: string,
  options: BitcoinDeriveOptions = {},
): Effect.Effect<string, DerivationError> =>
  Effect.tryPromise({
    try: () => mnemonicToSeed(mnemonic),
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive seed for Bitcoin address: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: 'm/84h',
      }),
  }).pipe(Effect.flatMap((seed) => deriveBitcoinAddress(seed, options)))
