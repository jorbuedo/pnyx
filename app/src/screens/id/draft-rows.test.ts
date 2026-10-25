import {CardKind} from '@pnyx/contract-client/card'
import {describe, expect, it} from 'vitest'
import {optionForEntry} from './card-kind-label'
import {nextRowId, seedDraftRows} from './draft-rows'

const entry = (value: string) => ({kind: CardKind.Note, value})

describe('draft row identity', () => {
  it('seeds one id per entry, all distinct', () => {
    const rows = seedDraftRows([entry('a'), entry('b'), entry('c')])
    expect(new Set(rows.map((r) => r.id)).size).toBe(3)
  })

  /**
   * ⚠️ The regression. A module-level counter produced "two children with the same key" after a fast
   * refresh: the module is re-evaluated and the counter resets while React keeps the draft, so the next
   * added row reused an id already held. Deriving from the rows themselves cannot collide.
   */
  it('never returns an id the rows already hold', () => {
    const rows = seedDraftRows([entry('a'), entry('b')])
    const grown = [...rows, {id: nextRowId(rows), option: optionForEntry(entry('c')), value: 'c'}]
    expect(new Set(grown.map((r) => r.id)).size).toBe(grown.length)
    // And again, repeatedly — an id is only ever above every one in play.
    const more = [...grown, {id: nextRowId(grown), option: optionForEntry(entry('d')), value: 'd'}]
    expect(new Set(more.map((r) => r.id)).size).toBe(more.length)
  })

  // Removing the highest row must not make the next add reuse a live id.
  it('stays distinct after the highest row is removed', () => {
    const rows = seedDraftRows([entry('a'), entry('b'), entry('c')])
    const shrunk = rows.slice(0, 2)
    const grown = [...shrunk, {id: nextRowId(shrunk), option: optionForEntry(entry('d')), value: 'd'}]
    expect(new Set(grown.map((r) => r.id)).size).toBe(3)
  })

  it('starts at 1 for an empty draft', () => {
    expect(nextRowId([])).toBe(1)
  })
})
