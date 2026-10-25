import {allowedCodePointRanges} from '@pnyx/contract-client/handle-charset'
import {describe, expect, it} from 'vitest'

import {
  FOLD_SWEEP_BUCKETS,
  FOLD_SWEEP_REFERENCE,
  FOLD_VECTORS,
  foldVerdict,
  runFoldSweep,
  runFoldVectors,
} from './handle-fold-probe'

describe('fold vectors', () => {
  it('every vector passes under Node, which is what makes it a reference', () => {
    for (const result of runFoldVectors()) {
      expect(result.actual, `${result.vector.name} — ${result.vector.why}`).toEqual([...result.vector.expected])
    }
  })

  it('covers a spread of scripts, so a partial Unicode build cannot pass on Latin alone', () => {
    const covered = new Set(FOLD_VECTORS.flatMap((v) => v.input))
    for (const cp of [0x41, 0x00c9, 0x0141, 0x1ebe, 0x0410, 0x4e00, 0xac00]) {
      expect(covered.has(cp), `U+${cp.toString(16)}`).toBe(true)
    }
  })
})

describe('fold sweep', () => {
  it('matches the pinned reference, so the constant cannot go stale unnoticed', () => {
    const sweep = runFoldSweep()
    expect(sweep.diverged.map((b) => b.index)).toEqual([])
  })

  it('sweeps exactly what the charset admits — not a copy of it', () => {
    const expected = allowedCodePointRanges().reduce((n, [a, b]) => n + (b - a + 1), 0)
    expect(runFoldSweep().codePoints).toBe(expected)
  })

  it('pins one digest per bucket, with none missing on either side', () => {
    const sweep = runFoldSweep()
    expect(sweep.buckets.length).toBe(FOLD_SWEEP_BUCKETS)
    expect(FOLD_SWEEP_REFERENCE.length).toBe(sweep.buckets.length)
    for (const bucket of sweep.buckets) expect(bucket.expected).not.toBeNull()
  })

  it('buckets tile the allowed set in order, without gaps or overlap', () => {
    const sweep = runFoldSweep()
    let previousLast = -1
    let counted = 0
    for (const bucket of sweep.buckets) {
      expect(bucket.first).toBeGreaterThan(previousLast)
      expect(bucket.last).toBeGreaterThanOrEqual(bucket.first)
      previousLast = bucket.last
      counted += bucket.codePoints
    }
    expect(counted).toBe(sweep.codePoints)
  })

  it('the verdict is ok here, and distinguishes an ASCII-only runtime from a wrong one', () => {
    const sweep = runFoldSweep()
    expect(foldVerdict(runFoldVectors(), sweep)).toBe('ok')

    const asciiOnly = runFoldVectors().map((r) =>
      r.vector.input.some((cp) => cp > 0x7f) ? {...r, actual: [...r.vector.input], ok: false} : r,
    )
    expect(foldVerdict(asciiOnly, sweep)).toBe('ascii-only')
    expect(foldVerdict(asciiOnly, {...sweep, diverged: sweep.buckets})).toBe('ascii-only')

    const wrong = runFoldVectors().map((r) => ({...r, actual: [0x2603], ok: false}))
    expect(foldVerdict(wrong, sweep)).toBe('diverges')
  })
})
