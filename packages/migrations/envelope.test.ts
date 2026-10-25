import {describe, expect, it} from 'vitest'
import {parseEnvelope, serializeEnvelope} from './envelope.js'

describe('parseEnvelope', () => {
  it('recognises a versioned envelope', () => {
    const result = parseEnvelope(JSON.stringify({version: 1, data: {n: 42}}))
    expect(result).toEqual({kind: 'versioned', blob: {version: 1, data: {n: 42}}})
  })

  it('treats raw JSON without envelope shape as legacy', () => {
    const result = parseEnvelope(JSON.stringify([1, 2, 3]))
    expect(result).toEqual({kind: 'legacy', raw: [1, 2, 3]})
  })

  it('treats objects with a non-integer version as legacy', () => {
    // Matches the wallet-snapshot case: embedded version with different
    // semantics shouldn't accidentally be interpreted as our envelope.
    const result = parseEnvelope(JSON.stringify({version: 1.5, data: null}))
    expect(result.kind).toBe('legacy')
  })

  it('treats envelope-shaped objects missing `data` as legacy', () => {
    const result = parseEnvelope(JSON.stringify({version: 1}))
    expect(result.kind).toBe('legacy')
  })

  it('treats objects with version: 0 as legacy (v0 reserved for unwrapped blobs)', () => {
    // Someone could manually write {version: 0, data: ...}. We treat that
    // as legacy-shaped so the load path has a single unambiguous v0 entry
    // (the legacy-detection branch).
    const result = parseEnvelope(JSON.stringify({version: 0, data: {n: 1}}))
    expect(result.kind).toBe('legacy')
  })

  it('treats null as legacy (raw null)', () => {
    const result = parseEnvelope('null')
    expect(result).toEqual({kind: 'legacy', raw: null})
  })

  it('reports invalid JSON', () => {
    const result = parseEnvelope('not-json{')
    expect(result.kind).toBe('invalid-json')
  })
})

describe('serializeEnvelope', () => {
  it('produces a round-trippable envelope', () => {
    const raw = serializeEnvelope(2, {x: 1, y: 'hello'})
    expect(JSON.parse(raw)).toEqual({version: 2, data: {x: 1, y: 'hello'}})
  })
})
