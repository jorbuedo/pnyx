// Splitting a built swap tx into the parts the signing rail re-assembles.
// Verifies splitBuiltSwapTx composes the Inspect extractors correctly: body +
// non-vkey witness entries (scripts/redeemers) + aux, all byte-exact, so the
// shared ceremony can add our vkey witness and submit without re-planning.

import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {splitBuiltSwapTx} from './execution'

// ── minimal CBOR encoder (only what the fixture needs) ──
const head = (major: number, n: number): number[] => (n < 24 ? [(major << 5) | n] : [(major << 5) | 24, n])
const bstr = (bytes: number[]): number[] => [...head(2, bytes.length), ...bytes]
const hx = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, '0')).join('')

const vkeyWitnessesVal = [...head(4, 1), ...head(4, 2), ...bstr(Array(32).fill(1)), ...bstr(Array(64).fill(2))]
const redeemersVal = [...head(5, 1), ...head(0, 0), ...bstr([0xde, 0xad])]
const datumsVal = [...head(4, 1), ...bstr([0xaa, 0xbb])]
const witnessSet = [
  ...head(5, 3),
  ...head(0, 0),
  ...vkeyWitnessesVal,
  ...head(0, 4),
  ...datumsVal,
  ...head(0, 5),
  ...redeemersVal,
]
const body = [...head(5, 0)]
const aux = [...bstr([0x11, 0x22, 0x33])]
const tx = [...head(4, 4), ...body, ...witnessSet, 0xf5, ...aux]

describe('splitBuiltSwapTx', () => {
  it('returns body + non-vkey witness entries + aux, byte-exact', async () => {
    const result = await Effect.runPromise(splitBuiltSwapTx(hx(tx)))
    expect(result.bodyHex).toBe(hx(body))
    expect(result.auxHex).toBe(hx(aux))
    // vkey witnesses (key 0) dropped; datums (4) + redeemers (5) kept verbatim.
    expect(result.witnessExtra).toEqual([
      [4, hx(datumsVal)],
      [5, hx(redeemersVal)],
    ])
  })
})
