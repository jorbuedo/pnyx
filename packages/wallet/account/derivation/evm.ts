/**
 * EVM (Ethereum & compatible) receive-address derivation — derive-only.
 *
 * BIP-44 path `m/44'/60'/account'/0/index` over secp256k1; address = last 20
 * bytes of keccak256(uncompressed pubkey X‖Y), rendered with the EIP-55 mixed-
 * case checksum. Same address across all EVM chains (Ethereum, Base, Polygon, …).
 *
 * @module
 */

import {keccak256, secp256k1PrivateKeyAtPath, secp256k1PublicKeyRaw64} from '@pnyx/crypto'
import {Effect} from 'effect'
import {DerivationError} from '../../errors.js'
import {mnemonicToSeed} from '../seed.js'

export type EvmDeriveOptions = {readonly account?: number; readonly index?: number}

const pathOf = (account: number, index: number): string => `m/44'/60'/${account}'/0/${index}`

const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * The EVM address (`0x…`, EIP-55 checksummed) for a raw 64-byte (X‖Y)
 * uncompressed public key. Shared by the seed path and the xpub-based
 * {@link AddressGenerator} so both render identically.
 */
export const evmAddressFromRaw64 = (pub64: Uint8Array): string =>
  toChecksumAddress(bytesToHex(keccak256(pub64).slice(-20)))

/** Apply the EIP-55 mixed-case checksum to a lowercase (no-0x) hex address. */
const toChecksumAddress = (lowerHex: string): string => {
  // keccak256 over the ASCII of the lowercase hex string (hex chars are ASCII).
  const hash = keccak256(Uint8Array.from(lowerHex, (c) => c.charCodeAt(0)))
  let out = '0x'
  for (let i = 0; i < lowerHex.length; i++) {
    const c = lowerHex[i] as string
    const hashByte = hash[i >> 1] as number
    // Nibble i of the hash: high nibble for even i, low nibble for odd i.
    const nibble = i % 2 === 0 ? hashByte >> 4 : hashByte & 0x0f
    out += nibble >= 8 ? c.toUpperCase() : c
  }
  return out
}

/** Derive the EVM address (`0x…`, EIP-55 checksummed) for a seed. */
export const deriveEvmAddress = (
  seed: Uint8Array,
  options: EvmDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const account = options.account ?? 0
  const index = options.index ?? 0
  return Effect.try({
    try: () => {
      const priv = secp256k1PrivateKeyAtPath(seed, pathOf(account, index))
      return evmAddressFromRaw64(secp256k1PublicKeyRaw64(priv))
    },
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive EVM address: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: pathOf(account, index),
      }),
  })
}

/** Convenience: derive the EVM address straight from a mnemonic. */
export const deriveEvmAddressFromMnemonic = (
  mnemonic: string,
  options: EvmDeriveOptions = {},
): Effect.Effect<string, DerivationError> =>
  Effect.tryPromise({
    try: () => mnemonicToSeed(mnemonic),
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive seed for EVM address: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: pathOf(options.account ?? 0, options.index ?? 0),
      }),
  }).pipe(Effect.flatMap((seed) => deriveEvmAddress(seed, options)))
