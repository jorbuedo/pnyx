import {describe, expect, it} from 'vitest'
import {METADATA_LABELS, metadataLabelInfo} from './label-registry'

describe('metadataLabelInfo', () => {
  it('names a registered label and cites the CIP that defines it', () => {
    expect(metadataLabelInfo('674')).toEqual({name: 'Transaction message', cip: 'CIP-20'})
    expect(metadataLabelInfo('721')).toEqual({name: 'NFT metadata', cip: 'CIP-25'})
    expect(metadataLabelInfo('61284')).toEqual({name: 'Catalyst registration', cip: 'CIP-15'})
  })

  it('names a registered label that no CIP defines', () => {
    // The label that prompted the registry: a Reeve payload rendered as a bare
    // `1447` over a JSON dump, telling the reader nothing.
    expect(metadataLabelInfo('1447')).toEqual({name: 'Reeve: financial records'})
  })

  it('returns undefined for an unregistered label rather than inventing a name', () => {
    // ~98.5% of the label space in use is unregistered, so this is the common
    // case — the UI must render it as "unknown", not as a guess.
    expect(metadataLabelInfo('1234567')).toBeUndefined()
    expect(metadataLabelInfo('0')).toBeUndefined()
    expect(metadataLabelInfo('')).toBeUndefined()
  })

  it('does not resolve inherited object properties as labels', () => {
    // A bare `Record` lookup answers `toString` / `constructor` truthily unless
    // the table is consulted as data. Metadata keys come off-chain.
    expect(metadataLabelInfo('toString')).toBeUndefined()
    expect(metadataLabelInfo('constructor')).toBeUndefined()
  })
})

describe('the registry as data', () => {
  // CIP-10 had exactly 48 registered labels when this was built. The count is
  // asserted so that adding one is a deliberate act with a source, not a guess
  // someone slipped in — update it together with the entry.
  it('carries the 48 CIP-10 registered labels and nothing invented', () => {
    expect(Object.keys(METADATA_LABELS)).toHaveLength(48)
  })

  it('keys on the integer label as it appears on chain', () => {
    for (const label of Object.keys(METADATA_LABELS)) expect(label).toMatch(/^\d+$/)
  })

  it('gives every entry a non-empty name', () => {
    for (const [label, info] of Object.entries(METADATA_LABELS)) {
      expect(info.name.length, `label ${label}`).toBeGreaterThan(0)
    }
  })
})
