import {describe, expect, it} from 'vitest'
import {decodeCache, mergeRows, registrationCacheKey, watermarkOf} from './registration-cache'
import type {RegistrationRow} from './registration-discovery'

const row = (over: Partial<RegistrationRow> = {}): RegistrationRow => ({
  txHash: 'aa',
  blockHeight: 100,
  name: 'Council',
  keyHashes: ['11'],
  scriptHashes: ['ss'],
  participants: {},
  ...over,
})

describe('registrationCacheKey', () => {
  it('is per network', () => {
    // A preprod registration is not a mainnet one; one key would answer a mainnet
    // search with testnet rows.
    expect(registrationCacheKey('mainnet')).not.toBe(registrationCacheKey('preprod'))
  })
})

describe('mergeRows', () => {
  it('de-duplicates by transaction hash', () => {
    // The watermark is inclusive, so a resume always re-reads its boundary block.
    const cached = [row({txHash: 'a'}), row({txHash: 'b'})]
    const fresh = [row({txHash: 'b'}), row({txHash: 'c'})]
    expect(
      mergeRows(cached, fresh)
        .map((r) => r.txHash)
        .sort(),
    ).toEqual(['a', 'b', 'c'])
  })

  it('lets the freshly read row win a collision', () => {
    const cached = [row({txHash: 'a', name: 'stale'})]
    const fresh = [row({txHash: 'a', name: 'from the chain'})]
    expect(mergeRows(cached, fresh)[0]?.name).toBe('from the chain')
  })

  it('handles either side being empty', () => {
    expect(mergeRows([], [row()])).toHaveLength(1)
    expect(mergeRows([row()], [])).toHaveLength(1)
    expect(mergeRows([], [])).toEqual([])
  })
})

describe('watermarkOf', () => {
  it('is the highest block seen', () => {
    expect(watermarkOf([row({blockHeight: 5}), row({blockHeight: 900}), row({blockHeight: 40})])).toBe(900)
  })

  it('is undefined for nothing, so an empty result never writes a watermark', () => {
    // Writing 0 would make the next search look like a resume from genesis, which
    // reads the same as a full search — but writing *any* watermark from an empty
    // set risks recording progress that was never made.
    expect(watermarkOf([])).toBeUndefined()
  })
})

describe('decodeCache', () => {
  const valid = JSON.stringify({version: 1, watermark: 900, rows: [row()]})

  it('round-trips a saved cache', () => {
    expect(decodeCache(valid)).toEqual({watermark: 900, rows: [row()]})
  })

  it('is null for anything unusable, which costs one full search and nothing else', () => {
    for (const raw of [null, '', 'not json', '{}', '[]']) expect(decodeCache(raw)).toBeNull()
  })

  it('discards a cache from another version rather than migrating it', () => {
    expect(decodeCache(JSON.stringify({version: 2, watermark: 900, rows: [row()]}))).toBeNull()
  })

  it('drops rows it cannot read, and the cache when none survive', () => {
    // A half-read cache would be treated as the total view on the next search,
    // which is what the oldest-wins rule must never be given.
    const mixed = JSON.stringify({version: 1, watermark: 900, rows: [row(), {txHash: 'x'}, null]})
    expect(decodeCache(mixed)?.rows).toHaveLength(1)
    expect(decodeCache(JSON.stringify({version: 1, watermark: 900, rows: [{txHash: 'x'}]}))).toBeNull()
  })

  it('is null without a watermark, which would otherwise resume from nowhere', () => {
    expect(decodeCache(JSON.stringify({version: 1, rows: [row()]}))).toBeNull()
  })
})
