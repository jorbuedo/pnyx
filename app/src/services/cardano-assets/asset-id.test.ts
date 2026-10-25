import {describe, expect, it} from 'vitest'
import {assetIdToUnit, unitToAssetId} from './asset-id'

const POLICY = 'a'.repeat(56)
const NAME = 'deadbeef'

describe('assetIdToUnit', () => {
  it('concatenates policy + name (drops the dot)', () => {
    expect(assetIdToUnit(`${POLICY}.${NAME}`)).toBe(`${POLICY}${NAME}`)
  })
  it('handles an empty asset name', () => {
    expect(assetIdToUnit(`${POLICY}.`)).toBe(POLICY)
  })
  it('maps ADA sentinels to the empty unit', () => {
    expect(assetIdToUnit('')).toBe('')
    expect(assetIdToUnit('.')).toBe('')
  })
  it('rejects a malformed id (no dot / wrong policy length)', () => {
    expect(assetIdToUnit('nodot')).toBeNull()
    expect(assetIdToUnit(`${'a'.repeat(10)}.${NAME}`)).toBeNull()
  })
})

describe('unitToAssetId', () => {
  it('splits policy + name with a dot', () => {
    expect(unitToAssetId(`${POLICY}${NAME}`)).toBe(`${POLICY}.${NAME}`)
  })
  it('maps the empty unit to ADA (empty id)', () => {
    expect(unitToAssetId('')).toBe('')
  })
  it('rejects a unit shorter than a policy id', () => {
    expect(unitToAssetId('abcd')).toBeNull()
  })
  it('round-trips a well-formed id', () => {
    const id = `${POLICY}.${NAME}`
    expect(unitToAssetId(assetIdToUnit(id) as string)).toBe(id)
  })
})
