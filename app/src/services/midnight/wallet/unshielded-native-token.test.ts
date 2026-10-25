/**
 * Pin {@link NIGHT_TOKEN_TYPE} to the ledger's own answer.
 *
 * The app cannot call `nativeToken()` at runtime — it is WASM and Hermes has none — so the constant is
 * written out by hand. This test is the only thing standing between that copy and a silent divergence:
 * if Midnight ever changes what the native unshielded token type is, this fails instead of the wallet
 * quietly reporting a zero NIGHT balance for a wallet that holds some.
 */

import {nativeToken, shieldedToken} from '@midnight-ntwrk/ledger-v8'
import {describe, expect, it} from 'vitest'

import {NIGHT_TOKEN_TYPE} from './unshielded-utxo-set'

describe('NIGHT_TOKEN_TYPE', () => {
  it('matches the ledger WASM nativeToken()', () => {
    const native = nativeToken() as unknown as {tag: string; raw: string}
    expect(native.tag).toBe('unshielded')
    expect(NIGHT_TOKEN_TYPE).toBe(native.raw)
  })

  it('is 32 bytes of hex, lower-case, as the indexer reports token types', () => {
    expect(NIGHT_TOKEN_TYPE).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is also the native *shielded* colour, so one constant covers both rails', () => {
    // The two differ only by tag: shieldedToken() and nativeToken() carry the same raw bytes. That is
    // what lets a shielded balance and an unshielded UTxO be labelled NIGHT from the same constant.
    const shielded = shieldedToken() as unknown as {tag: string; raw: string}
    expect(shielded.tag).toBe('shielded')
    expect(NIGHT_TOKEN_TYPE).toBe(shielded.raw)
  })
})
