/**
 * BIP-39's PBKDF2 on React Native — the same derivation through OpenSSL.
 *
 * `@noble/hashes`' pure-JS PBKDF2 costs **~1100 ms on Hermes** for BIP-39's 2048 iterations of
 * HMAC-SHA512, measured on the Android emulator 2026-08-03. `react-native-quick-crypto` does it in
 * **~1 ms**. That second was paid on every sign-in, wallet create, import and restore, and it
 * blocked the JS thread — running candidates concurrently took exactly N× one, so there was nothing
 * to overlap.
 *
 * ⚠️ **The output must stay byte-identical to `pbkdf2.ts`.** A divergence would not throw; it would
 * derive a different wallet from the same recovery phrase, and only on devices. `pbkdf2.test.ts`
 * pins both against the official BIP-39 vectors *and* against Node's OpenSSL, which is the same
 * engine this calls — CI cannot execute this file, so that indirection is the coverage.
 *
 * `pbkdf2Sync` rather than the callback form: at ~1 ms there is nothing to yield for, and staying
 * synchronous keeps the seed's lifetime inside one tick.
 *
 * @module
 */

import {pbkdf2Sync} from 'react-native-quick-crypto'

/** See `pbkdf2.ts` — identical contract, identical bytes. */
export const bip39Pbkdf2 = async (password: string, salt: string): Promise<Uint8Array> =>
  new Uint8Array(pbkdf2Sync(password, salt, 2048, 64, 'sha512'))
