/**
 * A wallet's Night **verifying key** — the `UtxoSpend.owner` a co-funded offer needs.
 *
 * ⚠️ **Not the address, and not `nightPayload`.** An address carries the *hash* of this key, so a
 * composer cannot recover it from anything an indexer reports; a contributor has to publish it. This
 * is how a wallet on this device produces its own.
 *
 * ⚠️ **Derived here rather than through the native bridge on purpose.** The only native surface that
 * returns a verifying key is `signData`, which signs something to do it — asking a wallet to sign a
 * throwaway message to read a public key is the kind of thing that later looks like a signing oracle.
 * BIP-340 x-only is exactly what the ledger's `VerifyingKey` serializes to, so `@noble/curves` gives
 * the same 32 bytes with no key use at all, and `owner-key.test.ts` pins that against a vector taken
 * from the Rust.
 *
 * @module
 */

import {schnorr} from '@noble/curves/secp256k1.js'

/**
 * The 32-byte BIP-340 x-only verifying key for a Night role key.
 *
 * Same bytes `midnight_base_crypto`'s `SigningKey::verifying_key()` serializes to, which is what makes
 * an offer built from these owners signable by the same keys.
 */
export const nightVerifyingKey = (nightRoleKey: Uint8Array): Uint8Array => {
  if (nightRoleKey.length !== 32) {
    throw new Error(`a night role key is 32 bytes, got ${nightRoleKey.length}`)
  }
  return schnorr.getPublicKey(nightRoleKey)
}
