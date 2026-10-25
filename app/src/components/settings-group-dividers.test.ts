import {describe, expect, it} from 'vitest'

import {dividerFlags} from './settings-group-dividers'

describe('dividerFlags', () => {
  it('divides every row but the last', () => {
    expect(dividerFlags([true, true, true])).toEqual([true, true, false])
  })

  it('handles a single row, which needs no divider', () => {
    expect(dividerFlags([true])).toEqual([false])
  })

  it('handles an empty group', () => {
    expect(dividerFlags([])).toEqual([])
  })

  // The Menu bug, as data. Two rows said nothing and defaulted to no divider; the group cannot make
  // that mistake because it never asks the row.
  it('gives the middle rows dividers regardless of what they would have said', () => {
    expect(dividerFlags([true, true, true, true, true, true])).toEqual([true, true, true, true, true, false])
  })

  // ⚠️ A trailing non-row must not steal the last row's exemption: with a footnote after the final
  // row, the naive "index === length - 1" test would draw a divider under the last row, leaving a
  // hairline hanging above the footnote.
  it('exempts the last row even when something follows it', () => {
    expect(dividerFlags([true, true, false])).toEqual([true, false, false])
  })

  it('never marks a non-row', () => {
    expect(dividerFlags([false, true, false, true])).toEqual([false, true, false, false])
  })

  // A conditional row renders as `null`, which `Children.toArray` drops before this sees it — so the
  // list simply gets shorter and the row before it becomes last. Nothing recomputes an index.
  it('treats a shortened list as the whole list', () => {
    expect(dividerFlags([true, true])).toEqual([true, false])
  })
})
