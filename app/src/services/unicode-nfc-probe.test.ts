import {validateHandle} from '@pnyx/contract-client/handle'
import {describe, expect, it} from 'vitest'
import {NFC_VECTORS, nfcVerdict, runNfcVectors} from './unicode-nfc-probe'

// Node ships full ICU, so this pins the *expectations* rather than the runtime: if a vector is
// wrong here it would be wrong on device too, and the probe would report a Hermes fault that is
// really our arithmetic. What the device run adds is whether Hermes agrees with Node.
describe('NFC vectors are correct under a known-good implementation', () => {
  it('every vector passes on Node', () => {
    const results = runNfcVectors()
    const failed = results.filter((r) => !r.ok).map((r) => r.vector.name)
    expect(failed).toEqual([])
    expect(nfcVerdict(results)).toBe('ok')
  })

  // A vector whose input already equals its expected output tests nothing about composition. Only
  // the ASCII control is allowed to be one.
  it('all but the control actually change under normalization', () => {
    const inert = NFC_VECTORS.filter((v) => String(v.input) === String(v.expected))
    expect(inert.map((v) => v.name)).toEqual(['ASCII passthrough'])
  })
})

describe('nfcVerdict', () => {
  it('reports a stub that returns its input as no-op, not as wrong', () => {
    const stubbed = NFC_VECTORS.map((vector) => ({
      vector,
      actual: vector.input,
      ok: String(vector.input) === String(vector.expected),
    }))
    expect(nfcVerdict(stubbed)).toBe('no-op')
  })

  it('reports a disagreeing implementation as wrong', () => {
    const results = runNfcVectors()
    const broken = results.map((r) =>
      r.vector.name === 'Hangul: conjoining jamo' ? {...r, actual: [0x41], ok: false} : r,
    )
    expect(nfcVerdict(broken)).toBe('wrong')
  })
})

// The reason the probe exists: this is the path that breaks if NFC no-ops on device.
describe('handle validation depends on NFC', () => {
  it('composes a decomposed Vietnamese handle to its canonical spelling', () => {
    const decomposed = String.fromCodePoint(0x6e, 0x67, 0x75, 0x79, 0x65, 0x0302, 0x0301, 0x6e)
    const checked = validateHandle(decomposed)
    expect(checked.ok && checked.handle).toBe(String.fromCodePoint(0x6e, 0x67, 0x75, 0x79, 0x1ebf, 0x6e))
    expect(checked.ok && checked.bytes.length).toBe(8)
  })

  it('would let two spellings of one name be claimed separately if NFC no-opped', () => {
    const composed = String.fromCodePoint(0x65, 0x6c, 0x69, 0x73, 0x65, 0x0301)
    const already = composed.normalize('NFC')
    expect(already).not.toBe(composed)
    const a = validateHandle(composed)
    const b = validateHandle(already)
    expect(a.ok && b.ok && a.handle === b.handle).toBe(true)
  })
})
