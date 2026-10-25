/**
 * BIP-39 mnemonic → seed.
 *
 * PBKDF2-HMAC-SHA512, 2048 iterations, 64-byte output, salt `mnemonic<passphrase>` —
 * the standard BIP-39 derivation. Shared so every chain (and Midnight) derives from a
 * byte-identical seed regardless of which code path produced it.
 *
 * The PBKDF2 itself lives in `pbkdf2.ts` / `pbkdf2.native.ts`: React Native routes it through
 * OpenSSL (~1 ms) rather than pure JS on Hermes (~1100 ms). Everything above that boundary — the
 * NFKD normalisation and the salt construction — stays shared, because those are the parts that
 * decide *which* seed you get.
 *
 * @module
 */
import {bip39Pbkdf2} from './pbkdf2.js'

/**
 * The 64-byte BIP-39 seed for `mnemonic`.
 *
 * NFKD normalisation is load-bearing rather than hygiene: BIP-39 specifies it, and a mnemonic or
 * passphrase containing composable characters would otherwise derive a different seed depending on
 * how it was typed or pasted. The passphrase is appended to the literal `"mnemonic"` to form the
 * salt — this used to be delegated to `@scure/bip39`, so the salt rule is now spelled out here.
 */
export const mnemonicToSeed = (mnemonic: string, passphrase = ''): Promise<Uint8Array> =>
  bip39Pbkdf2(mnemonic.normalize('NFKD'), `mnemonic${passphrase.normalize('NFKD')}`)
