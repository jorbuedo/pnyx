import {describe, expect, it} from 'vitest'

import {admitScan, initialScanGate, type ScanGate} from './camera-scan-gate'

/** Feed a sequence of camera reads through the gate, returning what reached `onScan`. */
const run = (reads: readonly string[], continuous: boolean): string[] => {
  let gate: ScanGate = initialScanGate
  const delivered: string[] = []
  for (const data of reads) {
    const step = admitScan(gate, data, continuous)
    gate = step.gate
    if (step.deliver) delivered.push(data)
  }
  return delivered
}

describe('single-shot', () => {
  it('delivers the first read and nothing after it', () => {
    expect(run(['a', 'a', 'b', 'c'], false)).toEqual(['a'])
  })

  it('latches even when the second read differs', () => {
    expect(run(['a', 'b'], false)).toEqual(['a'])
  })
})

describe('continuous', () => {
  it('delivers every distinct frame of an animated sequence', () => {
    expect(run(['p1', 'p2', 'p3', 'p4'], true)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('drops the same frame read repeatedly while it sits in front of the lens', () => {
    // 60fps sensor, ~2fps animation: each part is resolved many times before the next.
    const reads = ['p1', 'p1', 'p1', 'p2', 'p2', 'p2', 'p2', 'p3']
    expect(run(reads, true)).toEqual(['p1', 'p2', 'p3'])
  })

  it('re-delivers a part that comes round again, since a fountain cycles', () => {
    // Only a repeat of the immediately preceding read is a duplicate. A fountain encoder
    // loops, and a decoder still missing a part needs that second pass to complete.
    expect(run(['p1', 'p2', 'p1', 'p2'], true)).toEqual(['p1', 'p2', 'p1', 'p2'])
  })

  it('never latches', () => {
    const reads = Array.from({length: 200}, (_, i) => `p${i % 5}`)
    expect(run(reads, true)).toHaveLength(200)
  })
})

describe('the two modes are genuinely different', () => {
  it('same reads, different deliveries', () => {
    const reads = ['p1', 'p1', 'p2']
    expect(run(reads, false)).toEqual(['p1'])
    expect(run(reads, true)).toEqual(['p1', 'p2'])
  })
})
