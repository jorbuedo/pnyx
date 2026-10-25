import {describe, expect, it} from 'vitest'
import {
  allowedCodePointRanges,
  COMBINING_MARK_RANGES,
  DENIED_RANGES,
  isCombiningMark,
  isDeniedCodePoint,
  isNonspacingMark,
  NONSPACING_MARK_RANGES,
} from './handle-charset.js'
import {CHARSET_TABLES, isDeniedByProperty, pack} from './handle-charset-source.js'

describe('the pinned tables match the properties they claim to come from', () => {
  // If one of these fails, the engine's Unicode version has moved. Regenerate and read the diff —
  // do not edit the tables by hand, and do not relax the test: an unreviewed table means characters
  // nobody has looked at become claimable on a contract where ownership is permanent.
  it('denied ranges', () => {
    expect(pack(DENIED_RANGES)).toBe(pack(CHARSET_TABLES.denied()))
  })
  it('combining-mark ranges', () => {
    expect(pack(COMBINING_MARK_RANGES)).toBe(pack(CHARSET_TABLES.marks()))
  })
  it('nonspacing-mark ranges', () => {
    expect(pack(NONSPACING_MARK_RANGES)).toBe(pack(CHARSET_TABLES.nonspacing()))
  })
})

describe('what the charset denies', () => {
  const denied: readonly [string, number][] = [
    ['NUL', 0x0000],
    ['soft hyphen', 0x00ad],
    ['NBSP', 0x00a0],
    ['ideographic space', 0x3000],
    ['ZWSP', 0x200b],
    ['ZWNJ', 0x200c],
    ['ZWJ', 0x200d],
    ['LRO', 0x202d],
    ['RLO', 0x202e],
    ['variation selector 16', 0xfe0f],
    ['combining enclosing keycap', 0x20e3],
    ['regional indicator A', 0x1f1e6],
    ['skin tone modifier', 0x1f3fb],
    ['grinning face', 0x1f600],
    ['private use', 0xe000],
    ['noncharacter', 0xfffe],
    ['tag latin a', 0xe0061],
    ['full stop', 0x002e],
    ['commercial at', 0x0040],
    ['solidus', 0x002f],
    ['dollar sign', 0x0024],
    ['number sign', 0x0023],
    ['apostrophe', 0x0027],
    ['plus sign', 0x002b],
    ['fullwidth at', 0xff20],
    ['ideographic full stop', 0x3002],
    ['katakana middle dot', 0x30fb],
    ['em dash', 0x2014],
    ['copyright sign', 0x00a9],
    ['devanagari danda', 0x0964],
  ]
  for (const [name, cp] of denied) {
    it(`denies ${name}`, () => expect(isDeniedCodePoint(cp)).toBe(true))
  }
})

describe('what the charset allows — every script, which is the point', () => {
  const allowed: readonly [string, number][] = [
    ['latin a', 0x0061],
    ['digit', 0x0031],
    ['hyphen', 0x002d],
    ['underscore', 0x005f],
    ['cyrillic a', 0x0430],
    ['greek sigma', 0x03c3],
    ['hebrew alef', 0x05d0],
    ['arabic alef', 0x0627],
    ['devanagari ka', 0x0915],
    ['devanagari matra', 0x093e],
    ['bengali ka', 0x0995],
    ['tamil ka', 0x0b95],
    ['thai ko kai', 0x0e01],
    ['armenian ayb', 0x0531],
    ['georgian an', 0x10d0],
    ['ethiopic ha', 0x1200],
    ['han', 0x4e00],
    ['hiragana a', 0x3042],
    ['hangul ga', 0xac00],
    ['combining acute', 0x0301],
    ['combining dot above', 0x0307],
    // The two separators are the only punctuation kept, as explicit exceptions.
    ['hyphen-minus', 0x002d],
    ['low line', 0x005f],
    // ⚠️ Modifier *letters*, not punctuation — which is why category rules do not cost these scripts.
    ['katakana prolonged sound mark', 0x30fc],
    ['hawaiian okina', 0x02bb],
    ['uzbek modifier apostrophe', 0x02bc],
  ]
  for (const [name, cp] of allowed) {
    it(`allows ${name}`, () => expect(isDeniedCodePoint(cp)).toBe(false))
  }
})

describe('derived views', () => {
  it('the allowed ranges are the exact complement of the denied ones', () => {
    const allowed = allowedCodePointRanges()
    for (const [first, last] of allowed) {
      expect(isDeniedCodePoint(first)).toBe(false)
      expect(isDeniedCodePoint(last)).toBe(false)
      if (first > 0) expect(isDeniedCodePoint(first - 1)).toBe(true)
      if (last < 0x10ffff) expect(isDeniedCodePoint(last + 1)).toBe(true)
    }
    const total = allowed.reduce((n, [a, b]) => n + (b - a + 1), 0)
    const deniedTotal = DENIED_RANGES.reduce((n, [a, b]) => n + (b - a + 1), 0)
    expect(total + deniedTotal).toBe(0x110000)
  })

  it('classifies marks, and every nonspacing mark is a mark', () => {
    expect(isCombiningMark(0x0301)).toBe(true)
    expect(isNonspacingMark(0x0301)).toBe(true)
    // Devanagari sign AA is a *spacing* mark: a mark, but exempt from the run cap.
    expect(isCombiningMark(0x093e)).toBe(true)
    expect(isNonspacingMark(0x093e)).toBe(false)
    expect(isCombiningMark(0x0061)).toBe(false)
  })

  it('agrees with the property predicate across a dense sample', () => {
    for (let cp = 0; cp <= 0x2fff; cp++)
      expect(isDeniedCodePoint(cp), `U+${cp.toString(16)}`).toBe(isDeniedByProperty(cp))
  })
})
