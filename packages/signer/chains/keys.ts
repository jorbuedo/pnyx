/**
 * Multi-chain key derivation from BIP-39 mnemonic.
 *
 * Provides secp256k1 (BIP-32) key derivation for chains that don't use
 * Cardano's BIP32-Ed25519 scheme (which was removed with the legacy stack).
 *
 * @module
 */

import * as bip32 from '@scure/bip32'
import * as bip39 from '@scure/bip39'
import {Effect} from 'effect'
import {ChainSignerError} from './types.js'

/**
 * Derive a secp256k1 HD key from a mnemonic at the given BIP-32 path.
 *
 * Used by: EVM, Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Cosmos, THORChain, Tron.
 *
 * @param mnemonic - BIP-39 mnemonic phrase
 * @param path - BIP-32 derivation path (e.g., "m/44'/60'/0'/0/0")
 * @param chain - Chain identifier for error reporting
 * @returns HD key with private/public key material
 */
export const deriveSecp256k1Key = (
  mnemonic: string,
  path: string,
  chain: string,
): Effect.Effect<bip32.HDKey, ChainSignerError> =>
  Effect.gen(function* () {
    const seed = yield* Effect.tryPromise({
      try: () => bip39.mnemonicToSeed(mnemonic, ''),
      catch: (e) =>
        new ChainSignerError({
          message: `Invalid mnemonic: ${e instanceof Error ? e.message : String(e)}`,
          chain,
          cause: e,
        }),
    })

    return yield* Effect.try({
      try: () => {
        const root = bip32.HDKey.fromMasterSeed(seed)
        return root.derive(path)
      },
      catch: (e) =>
        new ChainSignerError({
          message: `Key derivation failed for path ${path}: ${e instanceof Error ? e.message : String(e)}`,
          chain,
          cause: e,
        }),
    })
  })

/**
 * Derive a secp256k1 private key (raw 32 bytes) from a mnemonic at the given path.
 *
 * Convenience wrapper that extracts the private key from the HD key.
 */
export const deriveSecp256k1PrivateKey = (
  mnemonic: string,
  path: string,
  chain: string,
): Effect.Effect<Uint8Array, ChainSignerError> =>
  Effect.gen(function* () {
    const hdKey = yield* deriveSecp256k1Key(mnemonic, path, chain)
    if (!hdKey.privateKey) {
      return yield* Effect.fail(
        new ChainSignerError({
          message: `No private key at path ${path}`,
          chain,
        }),
      )
    }
    return hdKey.privateKey
  })
