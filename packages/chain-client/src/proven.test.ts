// Pure-helper coverage for the on-device-proving submit seam. The balance+submit path itself
// needs a live wallet + chain (exercised by the e2e rail); these lock down the decisions made
// before the ledger WASM is touched.
import {describe, expect, it} from 'vitest'
import {isTxSuccess, PROVEN_TX_MARKERS, TX_SUCCESS, validateProvenTxBytes} from './proven.js'

describe('PROVEN_TX_MARKERS', () => {
  it('is the proven, signature-enabled, pre-binding triple Transaction.deserialize expects', () => {
    // Proven on-device (proof), signed (signature), fee not yet bound (pre-binding) so the sponsor
    // balances it. Order matters: deserialize(markerS, markerP, markerB, bytes).
    expect(PROVEN_TX_MARKERS).toEqual(['signature', 'proof', 'pre-binding'])
  })
})

describe('isTxSuccess', () => {
  it('accepts only a full on-chain success', () => {
    expect(isTxSuccess(TX_SUCCESS)).toBe(true)
    expect(isTxSuccess('SucceedEntirely')).toBe(true)
  })

  it('rejects partial and full failures (contract assertion rejected, fallible segment failed)', () => {
    expect(isTxSuccess('FailEntirely')).toBe(false)
    expect(isTxSuccess('FailFallible')).toBe(false)
    expect(isTxSuccess('')).toBe(false)
    expect(isTxSuccess('succeeded')).toBe(false)
  })
})

describe('validateProvenTxBytes', () => {
  it('returns the bytes unchanged when valid', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(validateProvenTxBytes(bytes)).toBe(bytes)
  })

  it('rejects empty bytes before the ledger WASM can panic', () => {
    expect(() => validateProvenTxBytes(new Uint8Array())).toThrow(/empty/)
  })

  it('rejects a non-Uint8Array payload', () => {
    expect(() => validateProvenTxBytes([1, 2, 3])).toThrow(/Uint8Array/)
    expect(() => validateProvenTxBytes('deadbeef')).toThrow(/Uint8Array/)
    expect(() => validateProvenTxBytes(undefined)).toThrow(/Uint8Array/)
  })
})
