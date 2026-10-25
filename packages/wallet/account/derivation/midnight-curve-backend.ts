/**
 * Midnight curve-math backend — default (WASM) implementation.
 *
 * The three non-BIP32 curve operations behind Midnight receive addresses (night payload hash,
 * DUST BLS12-381 public key, shielded JubJub public keys) run through a swappable backend so the
 * runtime that can't load the `@midnight-ntwrk/ledger-v8` WebAssembly — React Native / Hermes —
 * can replace it with a native module (`midnight-curve-backend.native.ts`). Node and Web keep
 * this WASM backend; it is the file metro resolves on every platform *except* native.
 *
 * Keeping the `ledger-v8` import isolated here (not in `midnight.ts`) is what lets the native
 * bundle exclude the WASM package entirely.
 *
 * @module
 */

import * as ledger from '@midnight-ntwrk/ledger-v8'
import {hex} from '@pnyx/crypto'
import {Effect, Either} from 'effect'
import {DerivationError} from '../../errors.js'

/** The curve operations a platform must provide to derive Midnight receive-address payloads. */
export type MidnightCurveBackend = {
  /** Role-0 secp256k1 key → 32-byte unshielded (`mn_addr`) address payload. */
  readonly nightPayload: (nightRoleKey: Uint8Array) => Effect.Effect<Uint8Array, DerivationError>
  /** Role-2 secp256k1 key → DUST public key, a BLS12-381 scalar (the `mn_dust` payload pre-encoding). */
  readonly dustPublicKey: (dustRoleKey: Uint8Array) => Effect.Effect<bigint, DerivationError>
  /** Role-3 secp256k1 key → shielded JubJub coin + encryption public keys (32 bytes each). */
  readonly shieldedPublicKeys: (
    zswapRoleKey: Uint8Array,
  ) => Effect.Effect<{readonly coin: Uint8Array; readonly encryption: Uint8Array}, DerivationError>
}

/**
 * Optional host-provided WASM initializer. On Node the `@midnight-ntwrk/ledger-v8` `node` entry
 * instantiates the WASM eagerly at import, so no initializer is needed. On Web/extension the host
 * may inject one (load the `.wasm` bytes, then `initLedgerWasm`). It must be idempotent; it's
 * awaited before any `ledger.*` op.
 */
let ledgerInitializer: (() => Promise<void>) | null = null

export const setMidnightLedgerInitializer = (init: () => Promise<void>): void => {
  ledgerInitializer = init
}

/** Run the host WASM initializer (if any) before touching the ledger WASM. No-op when unset. */
const ensureLedgerReady: Effect.Effect<void, DerivationError> = Effect.suspend(() => {
  const init = ledgerInitializer
  if (!init) return Effect.void
  return Effect.tryPromise({
    try: () => init(),
    catch: (cause) =>
      new DerivationError({
        message: `Failed to initialize Midnight ledger WASM: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
})

const op = <A>(thunk: () => A, message: string): Effect.Effect<A, DerivationError> =>
  ensureLedgerReady.pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: thunk,
        catch: (cause) =>
          new DerivationError({message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`}),
      }),
    ),
  )

export const midnightCurveBackend: MidnightCurveBackend = {
  nightPayload: (key) =>
    op(() => {
      const verifyingKey = ledger.signatureVerifyingKey(ledger.signingKeyFromBip340(key))
      return ledger.encodeUserAddress(ledger.addressFromKey(verifyingKey))
    }, 'Failed to derive Midnight night payload'),

  dustPublicKey: (key) =>
    op(() => {
      const dustSecretKey = ledger.DustSecretKey.fromSeed(key)
      try {
        return dustSecretKey.publicKey
      } finally {
        dustSecretKey.clear()
      }
    }, 'Failed to derive Midnight DUST public key'),

  shieldedPublicKeys: (key) =>
    op(() => {
      const keys = ledger.ZswapSecretKeys.fromSeed(key)
      try {
        return {
          coin: Either.getOrThrowWith(hex.decode(keys.coinPublicKey), (e) => e),
          encryption: Either.getOrThrowWith(hex.decode(keys.encryptionPublicKey), (e) => e),
        }
      } finally {
        keys.clear()
      }
    }, 'Failed to derive Midnight shielded public keys'),
}
