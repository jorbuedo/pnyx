/**
 * Midnight curve-math backend — React Native implementation.
 *
 * Metro resolves this file (over `midnight-curve-backend.ts`) on iOS/Android, so React Native gets
 * the native Rust module (`MidnightNative`, via `libmidnight_native.so` / the iOS xcframework)
 * instead of the `@midnight-ntwrk/ledger-v8` WebAssembly — which Hermes cannot load. The JS↔native
 * boundary is hex strings; HD derivation stays in JS (`wallet-sdk-hd`), encoding stays pure
 * (`midnight-address-encoding.ts`).
 *
 * @module
 */

import {dustPublicKeyLE, nightPayload, shieldedPublicKeys} from '@pnyx/midnight-native'
import {Effect} from 'effect'
import {DerivationError} from '../../errors.js'
import type {MidnightCurveBackend} from './midnight-curve-backend.js'

const leToBigint = (le: Uint8Array): bigint => {
  let n = 0n
  for (let i = le.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(le[i] as number)
  return n
}

const op = <A>(thunk: () => A, message: string): Effect.Effect<A, DerivationError> =>
  Effect.try({
    try: thunk,
    catch: (cause) =>
      new DerivationError({message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`}),
  })

/** No-op on native — the WASM initializer only matters for the Node/Web backend. */
export const setMidnightLedgerInitializer = (_init: () => Promise<void>): void => {}

export const midnightCurveBackend: MidnightCurveBackend = {
  nightPayload: (key) => op(() => nightPayload(key), 'Failed to derive Midnight night payload'),

  dustPublicKey: (key) => op(() => leToBigint(dustPublicKeyLE(key)), 'Failed to derive Midnight DUST public key'),

  shieldedPublicKeys: (key) =>
    op(() => {
      const out = shieldedPublicKeys(key)
      return {coin: out.slice(0, 32), encryption: out.slice(32, 64)}
    }, 'Failed to derive Midnight shielded public keys'),
}
