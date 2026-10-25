/**
 * Solana receive-address derivation — derive-only.
 *
 * SLIP-0010 ed25519 path `m/44'/501'/account'/0'` (all hardened, the Phantom /
 * Solana-CLI convention); address = base58(ed25519 public key). Same address on
 * every cluster.
 *
 * @module
 */

import {base58, ed25519PrivateKeyAtPath, ed25519PublicKey} from '@pnyx/crypto'
import {Effect} from 'effect'
import {DerivationError} from '../../errors.js'
import {mnemonicToSeed} from '../seed.js'

export type SolanaDeriveOptions = {readonly account?: number; readonly index?: number}

const pathOf = (account: number, index: number): string => `m/44'/501'/${account}'/${index}'`

/** Derive the Solana address (base58) for a seed. */
export const deriveSolanaAddress = (
  seed: Uint8Array,
  options: SolanaDeriveOptions = {},
): Effect.Effect<string, DerivationError> => {
  const account = options.account ?? 0
  const index = options.index ?? 0
  return Effect.try({
    try: () => {
      const priv = ed25519PrivateKeyAtPath(seed, pathOf(account, index))
      return base58.encode(ed25519PublicKey(priv))
    },
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive Solana address: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: pathOf(account, index),
      }),
  })
}

/** Convenience: derive the Solana address straight from a mnemonic. */
export const deriveSolanaAddressFromMnemonic = (
  mnemonic: string,
  options: SolanaDeriveOptions = {},
): Effect.Effect<string, DerivationError> =>
  Effect.tryPromise({
    try: () => mnemonicToSeed(mnemonic),
    catch: (cause) =>
      new DerivationError({
        message: `Failed to derive seed for Solana address: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: pathOf(options.account ?? 0, options.index ?? 0),
      }),
  }).pipe(Effect.flatMap((seed) => deriveSolanaAddress(seed, options)))
