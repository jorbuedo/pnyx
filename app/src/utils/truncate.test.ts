import {describe, expect, it} from 'vitest'
import {
  ADDRESS_HEAD,
  ADDRESS_HIGHLIGHT,
  ADDRESS_TAIL,
  addressRuns,
  truncateCompact,
  truncateMiddle,
  truncateWide,
} from './truncate'

const ADDRESS =
  'addr1q8wcjtuzsg6clu883yvrqkatn9rdfat9jgj78yl9nnqkypzqx3h4gqed2z3mqxy6s46fyf8ntfv5fchz9mac5xywqceqyjh4ne'

describe('truncateMiddle', () => {
  it('keeps a head and a tail around one ellipsis', () => {
    expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 4, 3)).toBe('abcd…xyz')
  })

  it('passes a value through when truncating would not shorten it', () => {
    // Without the guard a short input renders LONGER than the original.
    expect(truncateMiddle('abcdefgh', 4, 3)).toBe('abcdefgh')
    expect(truncateMiddle('abcdefghi', 4, 3).length).toBeLessThanOrEqual('abcdefghi'.length)
  })

  it('never drops the tail — that is the half that identifies an address', () => {
    for (const budget of [truncateCompact, truncateWide]) {
      const out = budget(ADDRESS)
      expect(out.endsWith(ADDRESS.slice(-6))).toBe(true)
      expect(out.startsWith('addr1')).toBe(true)
      expect(out.length).toBeLessThan(ADDRESS.length)
    }
  })

  it('gives the wide budget more room than the compact one', () => {
    expect(truncateWide(ADDRESS).length).toBeGreaterThan(truncateCompact(ADDRESS).length)
  })
})

describe('addressRuns', () => {
  it('keeps head, ellipsis, tail and highlight as separate runs', () => {
    const runs = addressRuns(ADDRESS)
    expect(runs.head).toBe(ADDRESS.slice(0, ADDRESS_HEAD))
    expect(runs.elided).toBe(true)
    expect(runs.tail).toHaveLength(ADDRESS_TAIL)
    expect(runs.highlight).toBe(ADDRESS.slice(-ADDRESS_HIGHLIGHT))
  })

  // ⚠️ The regression this pins, twice over. The head is the only run a narrow row may clip, so no run
  // may carry an ellipsis of its own: when the platform clipped a head that already contained `…`, the
  // address rendered with TWO ellipses and the second one ate the tail.
  it('puts the ellipsis outside every run, so no run can be clipped through one', () => {
    for (const value of [ADDRESS, '0'.repeat(200), `addr_test1${'q'.repeat(40)}`]) {
      const runs = addressRuns(value)
      expect(runs.head).not.toContain('…')
      expect(runs.tail).not.toContain('…')
      expect(runs.highlight).not.toContain('…')
    }
  })

  it('puts real characters between the ellipsis and the highlight', () => {
    // The older regression: a flex-shrunk lead with a CSS ellipsis could only ever elide immediately
    // before the highlight, so however much room the row had, the rendered tail was the 6 highlighted
    // characters.
    const runs = addressRuns(ADDRESS)
    expect(runs.tail + runs.highlight).toBe(ADDRESS.slice(-(ADDRESS_TAIL + ADDRESS_HIGHLIGHT)))
  })

  it('takes a per-surface head budget as an upper bound', () => {
    expect(addressRuns(ADDRESS, 50).head.length).toBeGreaterThan(addressRuns(ADDRESS, 10).head.length)
    expect(addressRuns(ADDRESS, 50).highlight).toBe(addressRuns(ADDRESS, 10).highlight)
  })

  it('loses nothing when the value is too short to truncate', () => {
    const short = 'abcdefgh'
    const runs = addressRuns(short)
    expect(runs.head + runs.tail + runs.highlight).toBe(short)
    expect(runs.elided).toBe(false)
  })

  it('never drops or duplicates the highlight, whatever the input', () => {
    for (const value of ['', 'a', 'abcdef', 'abcdefghijklmn', ADDRESS, '0'.repeat(200)]) {
      const runs = addressRuns(value)
      expect(runs.highlight).toBe(value.slice(-ADDRESS_HIGHLIGHT))
      expect(runs.head.length + runs.tail.length).toBeLessThanOrEqual(Math.max(0, value.length - ADDRESS_HIGHLIGHT))
    }
  })
})
