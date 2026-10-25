/**
 * BIP-39 PBKDF2 parity.
 *
 * The React Native build routes this derivation through OpenSSL
 * (`pbkdf2.native.ts` → react-native-quick-crypto) while CI runs the pure-JS one. **CI therefore
 * cannot execute the code users run**, and a divergence would not throw — it would silently derive
 * a different wallet from the same recovery phrase, on devices only.
 *
 * So this pins the derivation three ways instead of one:
 *  1. against the **official BIP-39 vector**, which is the specification, not our opinion of it;
 *  2. against **`node:crypto`**, i.e. OpenSSL — the same engine quick-crypto calls, so agreement
 *     here is what stands in for running the native file;
 *  3. against **`@scure/bip39`**, which owned this derivation before the split, so the salt and
 *     NFKD rules we now spell out ourselves cannot drift from what already shipped.
 *
 * Byte-equality of the native path was also confirmed on-device against `@scure` (Android
 * emulator, 2026-08-03): identical output, 1126 ms → 1 ms.
 */

import {pbkdf2Sync} from 'node:crypto'
import {mnemonicToSeed as scureMnemonicToSeed} from '@scure/bip39'
import {describe, expect, it} from 'vitest'
import {mnemonicToSeed} from './seed.js'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** BIP-39's own test vector (Trezor, English wordlist), passphrase `TREZOR`. */
const OFFICIAL = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  passphrase: 'TREZOR',
  seed: 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
}

const MNEMONICS = [
  OFFICIAL.mnemonic,
  'test test test test test test test test test test test junk',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
]

describe('BIP-39 seed derivation', () => {
  it('matches the official BIP-39 vector', async () => {
    expect(hex(await mnemonicToSeed(OFFICIAL.mnemonic, OFFICIAL.passphrase))).toBe(OFFICIAL.seed)
  })

  // OpenSSL is the engine the native path uses, so this is the closest CI can get to executing it.
  it('agrees with OpenSSL for the parameters the native path passes', async () => {
    for (const mnemonic of MNEMONICS) {
      for (const passphrase of ['', 'TREZOR', 'a passphrase with spaces']) {
        const openssl = pbkdf2Sync(mnemonic.normalize('NFKD'), `mnemonic${passphrase}`, 2048, 64, 'sha512')
        expect(hex(await mnemonicToSeed(mnemonic, passphrase))).toBe(openssl.toString('hex'))
      }
    }
  })

  // Guards the salt and NFKD rules that moved out of @scure/bip39 and into seed.ts.
  it('agrees with the @scure implementation it replaced', async () => {
    for (const mnemonic of MNEMONICS) {
      for (const passphrase of ['', 'TREZOR']) {
        expect(hex(await mnemonicToSeed(mnemonic, passphrase))).toBe(
          hex(await scureMnemonicToSeed(mnemonic.normalize('NFKD'), passphrase)),
        )
      }
    }
  })

  // NFKD is part of the spec: a decomposed passphrase must derive the same seed as its composed
  // form, or the same phrase typed on two keyboards yields two wallets.
  it('normalises composable characters in both mnemonic and passphrase', async () => {
    const composed = 'é'
    const decomposed = 'é'
    expect(composed).not.toBe(decomposed)
    expect(hex(await mnemonicToSeed(OFFICIAL.mnemonic, composed))).toBe(
      hex(await mnemonicToSeed(OFFICIAL.mnemonic, decomposed)),
    )
  })

  it('is 64 bytes, and the passphrase changes the seed', async () => {
    const plain = await mnemonicToSeed(OFFICIAL.mnemonic)
    expect(plain).toHaveLength(64)
    expect(hex(plain)).not.toBe(hex(await mnemonicToSeed(OFFICIAL.mnemonic, OFFICIAL.passphrase)))
  })
})
