// The arithmetic, against this app's own codes. A quiet zone that is wrong in either direction fails
// silently: too small and scanners cannot lock on, too large and the modules shrink until they cannot
// either.
import {describe, expect, it} from 'vitest'
import {moduleCountFor, QUIET_ZONE_MODULES, quietZoneForEdge, quietZoneForFill} from './qr-quiet-zone'

const ADDRESS =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'
/** A JWT-carrying pairing URI: the densest code this app produces. */
const DENSE = `pnyx-mcp:https://pnyx.pxkq.uk/mcp?token=${'e'.repeat(480)}`

describe('moduleCountFor', () => {
  it('measures the density that decides the quiet zone', () => {
    expect(moduleCountFor(ADDRESS)).toBe(41)
    expect(moduleCountFor(DENSE)).toBeGreaterThan(80)
  })

  it('answers null for an empty value rather than guessing', () => {
    expect(moduleCountFor('')).toBeNull()
  })

  // The level is the version is the module count — measuring at a different level than the renderer
  // draws at would misplace every quiet zone computed from it.
  it('reports a denser code at a stronger error-correction level', () => {
    expect(moduleCountFor(DENSE, 'Q')).toBeGreaterThan(moduleCountFor(DENSE, 'M') as number)
  })
})

describe('quietZoneForEdge', () => {
  it('reproduces the old fixed 20 pt for a sparse code, which is what it was tuned for', () => {
    // 4 modules of a 41-module code drawn at 200 pt is 19.5 pt — the constant was right here all along.
    expect(quietZoneForEdge(200, 41)).toBe(20)
  })

  it('stops over-padding a dense code', () => {
    // 4 modules of an 89-module code at 200 pt is 9 pt; the old constant spent 20 on a 4-module job.
    expect(quietZoneForEdge(200, 89)).toBeLessThan(12)
  })

  it('falls back to the sparse default when the density is unknown', () => {
    expect(quietZoneForEdge(200, null)).toBe(20)
  })
})

describe('quietZoneForFill', () => {
  // The self-referential case: padding shrinks the symbol, which shrinks the module, which shrinks the
  // padding. The closed form has to land on a padding that IS four modules of the symbol it produces.
  it('lands on exactly four modules of the symbol it leaves room for', () => {
    for (const [available, modules] of [
      [361, 89],
      [320, 41],
      [420, 105],
    ] as const) {
      const {padding, edge} = quietZoneForFill(available, modules)
      const module = edge / modules
      expect(padding / module).toBeCloseTo(QUIET_ZONE_MODULES, 1)
      expect(edge + 2 * padding).toBeCloseTo(available, 0)
    }
  })

  it('gives a dense code more of the width than the old constant did', () => {
    const {edge} = quietZoneForFill(361, 89)
    expect(edge).toBeGreaterThan(361 - 2 * 20)
  })

  it('never returns a negative edge for a container smaller than its padding', () => {
    expect(quietZoneForFill(4, 89).edge).toBe(0)
  })
})
