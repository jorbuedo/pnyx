import {describe, expect, it} from 'vitest'
import {metadataEntries, metadataMessageLines} from './entries'

describe('metadataEntries', () => {
  it('reads a CIP-20 message as its lines, not as [object Object]', () => {
    // The real payload from a Dexhunter trade, which rendered as "674 [object Object]".
    const entries = metadataEntries({'674': {msg: ['Dexhunter Trade', 'Partner VESPRDAPPBROWSER']}})
    expect(entries).toEqual([{key: '674', isMessage: true, lines: ['Dexhunter Trade', 'Partner VESPRDAPPBROWSER']}])
  })

  it('accepts a single-string CIP-20 message', () => {
    expect(metadataEntries({'674': {msg: 'Thanks!'}})[0]).toEqual({key: '674', isMessage: true, lines: ['Thanks!']})
  })

  it('falls back to readable JSON for a label it does not know', () => {
    const entries = metadataEntries({'721': {policy: {name: 'Cool #1'}}})
    expect(entries[0]?.isMessage).toBe(false)
    expect(entries[0]?.lines.join('\n')).toContain('"name": "Cool #1"')
    // Multi-line, so the UI can render it as a block rather than one clipped row.
    expect((entries[0]?.lines.length ?? 0) > 1).toBe(true)
  })

  it('renders primitives directly', () => {
    expect(metadataEntries({'1': 'hello', '2': 42, '3': true})).toEqual([
      {key: '1', isMessage: false, lines: ['hello']},
      {key: '2', isMessage: false, lines: ['42']},
      {key: '3', isMessage: false, lines: ['true']},
    ])
  })

  it('flattens an array of strings into lines', () => {
    expect(metadataEntries({'5': ['a', 'b']})[0]?.lines).toEqual(['a', 'b'])
  })

  it('drops entries with nothing to show rather than rendering an empty row', () => {
    expect(metadataEntries({'1': null, '2': '', '3': [], '4': undefined})).toEqual([])
  })

  it('treats a 674 without a msg as ordinary metadata rather than a message', () => {
    const entries = metadataEntries({'674': {other: 'x'}})
    expect(entries[0]?.isMessage).toBe(false)
  })
})

describe('metadataMessageLines', () => {
  // The Overview renders this and Details filters it out, so the two surfaces must
  // agree on exactly which payloads count as a message.
  it('returns the CIP-20 lines the Overview shows', () => {
    expect(metadataMessageLines({'674': {msg: ['Dexhunter Trade', 'Partner VESPRDAPPBROWSER']}})).toEqual([
      'Dexhunter Trade',
      'Partner VESPRDAPPBROWSER',
    ])
  })

  it('is null when there is no 674, when 674 carries no msg, and when the msg is empty', () => {
    expect(metadataMessageLines({})).toBeNull()
    expect(metadataMessageLines({'721': {name: 'x'}})).toBeNull()
    expect(metadataMessageLines({'674': {other: 'x'}})).toBeNull()
    expect(metadataMessageLines({'674': {msg: []}})).toBeNull()
  })

  it('agrees with metadataEntries on what is a message', () => {
    const both = {'674': {msg: ['hi']}, '721': {name: 'nft'}}
    const flagged = metadataEntries(both).filter((e) => e.isMessage)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]?.lines).toEqual(metadataMessageLines(both))
    // …and Details keeps the rest.
    expect(
      metadataEntries(both)
        .filter((e) => !e.isMessage)
        .map((e) => e.key),
    ).toEqual(['721'])
  })
})

describe('CIP-20 chunk joining', () => {
  // The `msg` array carries two different things and the standard does not say
  // which: a message split at the 64-byte cap, or deliberately separate lines.
  const chunk = (n: number, fill = 'a') => fill.repeat(n)

  it('keeps deliberately separate short lines apart', () => {
    // Real payload from a Dexhunter trade — two lines, not one split message.
    expect(metadataMessageLines({'674': {msg: ['Dexhunter Trade', 'Partner VESPRDAPPBROWSER']}})).toEqual([
      'Dexhunter Trade',
      'Partner VESPRDAPPBROWSER',
    ])
  })

  it('rejoins a message that was split at the cap', () => {
    const parts = [chunk(64), chunk(64, 'b'), 'tail']
    expect(metadataMessageLines({'674': {msg: parts}})).toEqual([`${chunk(64)}${chunk(64, 'b')}tail`])
  })

  it('rejoins across a multi-byte boundary, where the chunk is short of 64', () => {
    // The encoder stops before a 4-byte character would overflow, so a
    // continuation can be 61-63 bytes rather than exactly 64.
    const head = `${chunk(60)}🙂` // 60 + 4 = 64 bytes
    expect(metadataMessageLines({'674': {msg: [head, 'rest']}})).toEqual([`${head}rest`])
  })

  it('mixes both: a split message followed by its own separate line', () => {
    expect(metadataMessageLines({'674': {msg: [chunk(64), 'end of first', 'second line']}})).toEqual([
      `${chunk(64)}end of first`,
      'second line',
    ])
  })

  it('leaves a non-string msg on the generic rendering', () => {
    expect(metadataMessageLines({'674': {msg: [1, 2]}})).toEqual(['1', '2'])
  })
})

describe('values split across consecutive labels', () => {
  const cap = (fill: string) => fill.repeat(64)

  it('reassembles a datum chunked across labels 50-56 into one entry', () => {
    // The real shape from a marketplace sale: six at-cap labels then a short one.
    const md: Record<string, unknown> = {'30': '6'}
    for (let i = 0; i < 6; i++) md[String(50 + i)] = cap('ab'[i % 2] as string)
    md['56'] = 'ff'
    const entries = metadataEntries(md)
    expect(entries.map((e) => e.key)).toEqual(['30', '50'])
    const joined = entries.find((e) => e.key === '50')
    expect(joined?.joinedLabels).toEqual(['50', '51', '52', '53', '54', '55', '56'])
    expect(joined?.lines).toHaveLength(1)
    expect(joined?.lines[0]).toHaveLength(64 * 6 + 2)
    expect(joined?.isHex).toBe(true)
  })

  it('tolerates the trailing separator seen on chain', () => {
    const md = {'1': cap('a'), '2': 'ff,'}
    // 64+2 hex chars once the comma is dropped — still even, so still data.
    expect(metadataEntries(md)[0]?.isHex).toBe(true)
  })

  it('does not claim data when the joined value is not hex', () => {
    const md = {'1': cap('z'), '2': 'tail'}
    const e = metadataEntries(md)[0]
    expect(e?.joinedLabels).toEqual(['1', '2'])
    expect(e?.isHex).toBeUndefined()
  })

  it('leaves non-consecutive at-cap labels alone', () => {
    const md = {'1': cap('a'), '9': cap('b')}
    expect(metadataEntries(md).map((e) => e.key)).toEqual(['1', '9'])
    expect(metadataEntries(md).every((e) => e.joinedLabels === undefined)).toBe(true)
  })

  it('never folds a CIP-20 message into a run', () => {
    const md = {'674': {msg: ['hi']}, '50': cap('a'), '51': 'ff'}
    const entries = metadataEntries(md)
    expect(entries.find((e) => e.key === '674')?.isMessage).toBe(true)
    expect(entries.find((e) => e.key === '50')?.joinedLabels).toEqual(['50', '51'])
  })
})
