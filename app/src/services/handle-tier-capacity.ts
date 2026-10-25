/**
 * How many *characters* a length tier holds, which depends on the script you write in.
 *
 * A tier is a range of **UTF-8 bytes**, and a character costs between one and three of them. So "4
 * characters" is only true of Latin: the same tier holds two Cyrillic characters and one CJK one. That
 * is the whole reason the rows show a rank rather than a number — the number is not one number.
 *
 * ⚠️ **Three classes, not four.** Four-byte code points are emoji and the rare CJK extensions, and the
 * charset denies emoji (`handle-charset.ts`), so offering an emoji count would advertise names that
 * cannot be claimed. Every *script* is allowed; it is the pictographs that are not.
 *
 * @module
 */

import type {TierRange} from './handle-tier-ranges'

/** A width of character, by what it costs in UTF-8. */
export type ScriptClass = 'latin' | 'cyrillic' | 'cjk'

/** Bytes per character. Latin here means ASCII — the letters, digits, `-` and `_` a handle admits. */
export const SCRIPT_BYTES: Readonly<Record<ScriptClass, number>> = {
  latin: 1,
  cyrillic: 2,
  cjk: 3,
}

export const SCRIPT_CLASSES: readonly ScriptClass[] = ['latin', 'cyrillic', 'cjk']

export type Capacity = {
  readonly script: ScriptClass
  /** Inclusive character counts, or `null` when no name in this script lands in this tier at all. */
  readonly from: number | null
  readonly to: number | null
}

/**
 * The character counts each script class can write inside `range`'s byte bounds.
 *
 * A count fits when its bytes land inside the range, so the minimum rounds **up** and the maximum
 * rounds **down** — three bytes of budget hold one two-byte character, not one and a half.
 *
 * ⚠️ A tier can be unreachable for a script: tier 1 is exactly three bytes, which no whole number of
 * two-byte characters hits. That is `null`, and the screen has to say so rather than print `2–1`.
 */
export const capacityFor = (range: TierRange, script: ScriptClass): Capacity => {
  const bytes = SCRIPT_BYTES[script]
  const from = Math.ceil(range.from / bytes)
  const to = Math.floor(range.to / bytes)
  return from > to || to < 1 ? {script, from: null, to: null} : {script, from, to}
}

/** Every script class for one tier, in ascending cost. */
export const capacitiesFor = (range: TierRange): readonly Capacity[] =>
  SCRIPT_CLASSES.map((script) => capacityFor(range, script))
