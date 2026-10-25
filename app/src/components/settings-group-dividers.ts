/**
 * Which rows in a settings group get a divider.
 *
 * ⚠️ **The one fact a row cannot know about itself.** "Am I the last row?" is a property of the
 * sibling list, so while each `SettingsRow` carried its own `showBorder`, every call site had to
 * restate the list's shape by hand — and the Menu screen got three of twenty wrong: two omitted the
 * prop (it defaults to `false`, so they drew nothing) and one passed `false` with a row still after
 * it, merging two entries into one block. Both failures are invisible: a missing divider looks like
 * a design choice, never like a bug.
 *
 * Pure and separate from the component so it can be tested directly — `SettingsGroup` reaches React
 * Native through `Card`, which a unit test cannot import.
 *
 * @module
 */

/**
 * `true` for every row that should draw a divider: all of them except the last.
 *
 * Takes a mask rather than the children themselves because a group may hold things that are not
 * rows — an empty-state view, a footnote — and those neither take a divider nor count as the last
 * row. A trailing non-row must not steal the last row's exemption.
 */
export const dividerFlags = (isRow: readonly boolean[]): readonly boolean[] => {
  const lastRow = isRow.reduce<number>((last, row, index) => (row ? index : last), -1)
  return isRow.map((row, index) => row && index !== lastRow)
}
