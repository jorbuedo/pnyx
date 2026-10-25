import {describe, expect, it} from 'vitest'
import {
  canonicalizeHandle,
  decodeHandle,
  encodeDisplayName,
  encodeHandle,
  foldLengthChanges,
  HANDLE_BYTES,
  handlesMatch,
  handleTier,
  hasHandle,
  MAX_HANDLE_BYTES,
  MIN_HANDLE_BYTES,
  NO_HANDLE,
  validateHandle,
} from './handle.js'

const ok = (input: string) => {
  const r = validateHandle(input)
  if (!r.ok) throw new Error(`expected ${JSON.stringify(input)} to be valid, got ${r.reason}`)
  return r
}

const rejects = (input: string) => {
  const r = validateHandle(input)
  return r.ok ? null : r.reason
}

describe('validateHandle — accepts what a keyboard produces', () => {
  it('accepts a plain Latin handle', () => {
    expect(ok('alice').ok).toBe(true)
  })

  it('accepts European diacritics', () => {
    expect(ok('müller').handle).toBe('müller')
  })

  it('accepts Vietnamese, which precomposes under NFC', () => {
    const r = ok('nguyễn')
    expect([...r.handle]).toHaveLength(6)
  })

  it('accepts Cyrillic', () => {
    expect(ok('привет').ok).toBe(true)
  })

  it('accepts Han, and reports the shared group deterministically', () => {
    expect(ok('田中').ok).toBe(true)
  })

  it('accepts Japanese mixing Han, kana and the prolonged sound mark', () => {
    expect(ok('東京タワー').ok).toBe(true)
  })

  it('accepts Hangul', () => {
    expect(ok('김민수').ok).toBe(true)
  })

  it('accepts digits and both separators inside a handle', () => {
    expect(ok('alice_01').handle).toBe('alice_01')
    expect(ok('alice-01').handle).toBe('alice-01')
  })
})

describe('validateHandle — canonical form', () => {
  it('case-folds', () => {
    expect(ok('ALICE').handle).toBe('alice')
  })

  it('trims surrounding whitespace', () => {
    expect(ok('  alice  ').handle).toBe('alice')
  })

  it('composes decomposed input to NFC', () => {
    const decomposed = 'nguyễn'
    expect(decomposed.normalize('NFC')).not.toBe(decomposed)
    expect(ok(decomposed).handle).toBe('nguyễn')
  })

  it('canonicalizeHandle is idempotent', () => {
    const once = canonicalizeHandle('  NguyỄn  ')
    expect(canonicalizeHandle(once)).toBe(once)
  })
})

describe('validateHandle — rejections', () => {
  it('rejects an empty handle', () => {
    expect(rejects('')).toBe('empty')
    expect(rejects('   ')).toBe('empty')
  })

  it('admits every length the tiers price, down to one byte', () => {
    // The 5-byte floor was retired 2026-08-24: short names became expensive rather than forbidden,
    // because a permit gates every `bind` at every length. A client floor above the circuit's would
    // strand names on chain that this app then refuses to draw.
    expect(rejects('a')).toBeNull()
    expect(rejects('ab')).toBeNull()
    expect(rejects('abcd')).toBeNull()
    expect(ok('a').bytes.filter((b) => b !== 0)).toHaveLength(MIN_HANDLE_BYTES)
  })

  // Scarcity is now priced rather than forbidden, and the pricing is what `handleTier` owns. A
  // single-character name of any script is admissible; what differs is which tier it lands in.
  it('admits a one-character name in every script, and prices it by bytes', () => {
    expect(rejects('田')).toBeNull()
    expect(rejects('오')).toBeNull()
    expect(handleTier(ok('田').bytes)).toBe(1)
    expect(handleTier(ok('오').bytes)).toBe(1)
    expect(ok('김민').ok).toBe(true)
    // ⚠️ The accepted bias: three bytes per Han character means one Han character prices a tier below
    // one Latin character. Unfixable in-circuit — the circuit counts bytes, not codepoints.
    expect(handleTier(ok('a').bytes)).toBe(0)
  })

  it('admits a three-character Cyrillic name', () => {
    expect(rejects('оса')).toBeNull()
    expect([...ok('оса').handle]).toHaveLength(3)
    expect(ok('оса').bytes).toHaveLength(6)
  })

  it('rejects a handle past the 31-byte ceiling, one short of the field', () => {
    // The 32nd byte buys soundness, not space: it is the canonicality guard on `bind`'s limb
    // recomposition (see MAX_HANDLE_BYTES). A full-width name would leave one field wrap
    // representable, and the wrap changes the low limbs the tier reads.
    expect(rejects('a'.repeat(HANDLE_BYTES))).toBe('too-long')
    expect(rejects('a'.repeat(MAX_HANDLE_BYTES))).toBeNull()
    // `.bytes` is the UTF-8 encoding, not the padded field — `encodeHandle` is what pads.
    expect(ok('a'.repeat(MAX_HANDLE_BYTES)).bytes).toHaveLength(MAX_HANDLE_BYTES)
    expect(handleTier(encodeHandle('a'.repeat(MAX_HANDLE_BYTES)))).toBe(6)
  })

  it('measures length in bytes, not characters', () => {
    expect(ok('東'.repeat(10)).bytes).toHaveLength(30)
    // Ten Han characters is 30 bytes, which fits; eleven is 33 and does not.
    expect(handleTier(encodeHandle('東'.repeat(10)))).toBe(6)
    expect(rejects('東'.repeat(11))).toBe('too-long')
  })

  it('ALLOWS a script mix, and that is the policy — confusables are not judged here', () => {
    // `alicе` ends in Cyrillic ye. It is a different name from `alice` and both are claimable.
    // Impersonation is answered by the identicon and the layers above, not by the charset: there is no
    // registry to compare a new name against, so this design cannot ask the question at all.
    expect(ok('alicе').handle).not.toBe('alice')
    expect(ok('аӏісе').ok).toBe(true)
    expect(ok('paypa1').ok).toBe(true)
  })

  it('rejects emoji', () => {
    expect(rejects('alice😀')).toBe('disallowed-character')
  })

  it('rejects zero-width and bidi controls', () => {
    expect(rejects('ali​ce')).toBe('disallowed-character')
    expect(rejects('ali‍ce')).toBe('disallowed-character')
    expect(rejects('ali‮ce')).toBe('disallowed-character')
  })

  it('accepts a trailing combining mark, and caps only a run of them', () => {
    // Marks are how Indic, Arabic and Thai are written, so they cannot be banned outright. What is
    // bounded is a *run*: an unbounded one smears a name vertically over the rows around it.
    expect(ok(`田中${String.fromCodePoint(0x0301)}`).ok).toBe(true)
    const tilde = String.fromCodePoint(0x0334)
    expect(ok(`a${tilde.repeat(4)}`).ok).toBe(true)
    expect(rejects(`a${tilde.repeat(5)}`)).toBe('too-many-combining-marks')
  })

  it('rejects a leading combining mark, which has nothing to attach to', () => {
    expect(rejects(`${String.fromCodePoint(0x0301)}alice`)).toBe('leading-combining-mark')
  })

  it('denies punctuation and symbols, keeping only the two separators', () => {
    // `.`, `@`, `/`, `$`, `#` address users, name commands and split paths in the surfaces above this
    // one, so a handle carrying them is ambiguous wherever it is written down. Denied by *category*
    // (`P` and `S`), not by a list — otherwise `。`, `・`, `＠` and `＄` walk straight back in.
    for (const bad of ['alice.bob', 'alice@bob', 'alice/bob', 'alice$', '#alice', "l'amie", 'Al!ce', 'a+b']) {
      expect(rejects(bad), bad).toBe('disallowed-character')
    }
    for (const lookalike of ['alice＠bob', 'alice。bob', 'alice—bob', 'ジョン・スミス']) {
      expect(rejects(lookalike), lookalike).toBe('disallowed-character')
    }
    expect(ok('alice-bob').ok).toBe(true)
    expect(ok('alice_bob').ok).toBe(true)
    // ⚠️ The modifier *letters* survive, and that is the point of using categories: `ー` U+30FC,
    // `ʻ` U+02BB and `ʼ` U+02BC are `Lm`, so Japanese, Hawaiian and Uzbek names still work.
    expect(ok('ラーメン').ok).toBe(true)
    expect(ok('oʻzbek').ok).toBe(true)
    // ⚠️ The ordinary space is admitted; every other whitespace code point is not, and that pair is the
    // safety argument. An interior NBSP is indistinguishable from a space on screen, so admitting both
    // would let `alice bob` exist twice — admitting exactly one leaves nothing to confuse it with.
    expect(ok('alice bob').ok).toBe(true)
    expect(rejects('alice\u00a0bob')).toBe('disallowed-character')
    expect(rejects('alice\u2009bob')).toBe('disallowed-character')
    expect(rejects('alice\u3000bob')).toBe('disallowed-character')
    expect(ok('  alice  ').handle).toBe('alice')
  })

  it('treats a space as a separator, so a name has exactly one shape', () => {
    // One space between words is a name; two is a typo, and so is a space touching another separator.
    expect(ok('alice bob').handle).toBe('alice bob')
    expect(rejects('alice  bob')).toBe('repeated-separator')
    expect(rejects('alice - bob')).toBe('repeated-separator')
    expect(rejects('alice_ bob')).toBe('repeated-separator')
    // Leading and trailing spaces never reach the rule — `trim()` removes them first, which is
    // forgiving of a paste rather than a refusal.
    expect(ok(' alice bob ').handle).toBe('alice bob')
    // A space costs a byte like anything else, so it counts toward the tier.
    expect(encodeHandle('alice bob').indexOf(0)).toBe(9)
  })

  it('rejects a leading or trailing separator', () => {
    expect(rejects('_alice')).toBe('leading-separator')
    expect(rejects('-alice')).toBe('leading-separator')
    expect(rejects('alice_')).toBe('trailing-separator')
    expect(rejects('alice-')).toBe('trailing-separator')
  })

  it('rejects adjacent separators, including one of each', () => {
    expect(rejects('ali__ce')).toBe('repeated-separator')
    expect(rejects('ali--ce')).toBe('repeated-separator')
    expect(rejects('ali-_ce')).toBe('repeated-separator')
  })
})

describe('encodeHandle', () => {
  it('zero-pads to the field width', () => {
    const bytes = encodeHandle('alice')
    expect(bytes).toHaveLength(HANDLE_BYTES)
    expect([...bytes.subarray(0, 5)]).toEqual([...new TextEncoder().encode('alice')])
    expect([...bytes.subarray(5)].every((b) => b === 0)).toBe(true)
  })

  it('encodes the canonical form, not the input', () => {
    expect(encodeHandle('ALICE')).toEqual(encodeHandle('alice'))
  })

  it('throws rather than encoding an invalid handle', () => {
    expect(() => encodeHandle('ali__ce')).toThrow(/repeated-separator/)
  })
})

describe('decodeHandle — the read gate', () => {
  const padded = (bytes: Uint8Array): Uint8Array => {
    const out = new Uint8Array(HANDLE_BYTES)
    out.set(bytes)
    return out
  }
  const utf8 = (s: string) => new TextEncoder().encode(s)

  it('round-trips every accepted handle', () => {
    for (const h of ['alice', 'nguyễn', 'привет', '田中', '東京タワー', '김민수', 'alice_01']) {
      const r = decodeHandle(encodeHandle(h))
      expect(r.ok && r.handle).toBe(canonicalizeHandle(h))
    }
  })

  it('refuses an all-zero field', () => {
    const r = decodeHandle(NO_HANDLE)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('empty')
  })

  it('renders an upper-case spelling — a display choice, not a different name', () => {
    const upper = decodeHandle(padded(utf8('ALICE')))
    expect(upper.ok).toBe(true)
    if (!upper.ok) return
    expect(upper.display).toBe('ALICE')
    expect(upper.handle).toBe('alice')
  })

  it('still refuses a decomposed spelling, which the circuit cannot see either', () => {
    // Case is styling. Decomposition is a *different* name wearing the same face, so folding does not
    // reconcile it — that is the homoglyph case rather than the styling one.
    // Built with NFD rather than written as a literal: retyping the literal silently precomposes it,
    // and the test then asserts nothing. (It did exactly that once.)
    const decomposed = decodeHandle(padded(utf8('nguyễn'.normalize('NFD'))))
    expect(decomposed.ok).toBe(false)
    expect(!decomposed.ok && decomposed.reason).toBe('not-canonical')
  })

  it('refuses an embedded null', () => {
    const r = decodeHandle(padded(utf8('ab cde')))
    expect(!r.ok && r.reason).toBe('disallowed-character')
  })

  it('refuses malformed UTF-8', () => {
    for (const bad of [
      [0xff],
      [0xc0, 0x80], // overlong 'NUL'
      [0xc1, 0xbf], // overlong '?'
      [0xe0, 0x80, 0xaf], // overlong three-byte
      [0xed, 0xa0, 0x80], // UTF-16 surrogate half
      [0xf5, 0x80, 0x80, 0x80], // beyond U+10FFFF
      [0xe4, 0xb8], // truncated
      [0x80], // lone continuation
    ]) {
      const r = decodeHandle(padded(Uint8Array.from(bad)))
      expect(!r.ok && r.reason).toBe('invalid-utf8')
    }
  })

  it('refuses a field of the wrong width', () => {
    const r = decodeHandle(utf8('alice'))
    expect(!r.ok && r.reason).toBe('invalid-utf8')
  })

  // ⚠️ The reserved-name mechanism is GONE, and this test records why. `pnyx` and `help` were dead
  // for everyone *because* they were four bytes — below the retired floor, writable only by a
  // constructor, which parked them on an unownable all-zero owner. With no floor they are ordinary
  // tier-2 names that anyone holding a tier-2 permit can bind, so reservation becomes an
  // **operational** step: `moderate(ban: true)` on the never-claimed shell, before a single claim
  // permit exists (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.2, §8.2).
  it('treats a formerly reserved name as an ordinary claimable one', () => {
    const reserved = padded(utf8('pnyx'))
    expect(utf8('pnyx')).toHaveLength(4)

    const shown = decodeHandle(reserved)
    expect(shown.ok && shown.handle).toBe('pnyx')

    expect(rejects('pnyx')).toBeNull()
    expect(handleTier(padded(utf8('pnyx')))).toBe(2)
  })

  // The asymmetry is only about length. Everything a reserved name is rendered under still applies.
  it('still refuses a short name that is otherwise invalid', () => {
    // Case is no longer one of the reasons: `PNYX` renders. A leading separator and an emoji still do
    // not, and neither depends on length.
    expect(!decodeHandle(padded(utf8('_pnyx'))).ok).toBe(true)
    expect(!decodeHandle(padded(utf8('pn😀'))).ok).toBe(true)
    expect(decodeHandle(padded(utf8('PNYX'))).ok).toBe(true)
  })
})

describe('hasHandle', () => {
  it('distinguishes a claimed handle from the sentinel', () => {
    expect(hasHandle(NO_HANDLE)).toBe(false)
    expect(hasHandle(encodeHandle('alice'))).toBe(true)
  })
})

describe('handleTier', () => {
  const at = (n: number) => encodeHandle('a'.repeat(n))

  it('maps every byte length 1..31 to the decided boundaries', () => {
    const expected: Record<number, number> = {}
    for (let n = 1; n <= 2; n++) expected[n] = 0
    expected[3] = 1
    expected[4] = 2
    for (let n = 5; n <= 6; n++) expected[n] = 3
    for (let n = 7; n <= 10; n++) expected[n] = 4
    for (let n = 11; n <= 22; n++) expected[n] = 5
    for (let n = 23; n <= 31; n++) expected[n] = 6
    for (let n = 1; n <= MAX_HANDLE_BYTES; n++) {
      expect(handleTier(at(n)), `${n} bytes`).toBe(expected[n])
    }
  })

  it('puts each boundary on the side the circuit probes', () => {
    // The circuit reads "length >= k+1" from `b[k] != 0` at k = 2, 3, 4, 6, 10, 22. A boundary off by
    // one here builds a transaction asking for the wrong tier's permit, which cannot prove.
    expect([handleTier(at(2)), handleTier(at(3))]).toEqual([0, 1])
    expect([handleTier(at(3)), handleTier(at(4))]).toEqual([1, 2])
    expect([handleTier(at(4)), handleTier(at(5))]).toEqual([2, 3])
    expect([handleTier(at(6)), handleTier(at(7))]).toEqual([3, 4])
    expect([handleTier(at(10)), handleTier(at(11))]).toEqual([4, 5])
    expect([handleTier(at(22)), handleTier(at(23))]).toEqual([5, 6])
  })

  it('prices a shorter name at least as high as a longer one', () => {
    for (let n = 1; n < MAX_HANDLE_BYTES; n++) {
      expect(handleTier(at(n)) <= handleTier(at(n + 1)), `${n} vs ${n + 1}`).toBe(true)
    }
  })

  it('reads the length from the first zero, not the field width', () => {
    // A handle arrives left-aligned in 32 bytes; counting the whole field would make every name tier 6.
    expect(encodeHandle('bob')).toHaveLength(32)
    expect(handleTier(encodeHandle('bob'))).toBe(1)
  })

  it('prices one Han character a tier below one Latin character — the accepted bias', () => {
    expect(handleTier(encodeHandle('中'))).toBe(1)
    expect(handleTier(encodeHandle('ab'))).toBe(0)
    // And two Han characters land with 5–6 byte Latin names rather than with 2-character ones.
    expect(handleTier(encodeHandle('中文'))).toBe(3)
  })

  it('refuses a name past the 31-byte ceiling rather than tiering it', () => {
    const full = new Uint8Array(32).fill(0x61)
    expect(() => handleTier(full)).toThrow(/31-byte maximum/)
  })

  it('refuses an empty name', () => {
    expect(() => handleTier(new Uint8Array(32))).toThrow(/at least 1 byte/)
  })
})

describe('display vs canonical', () => {
  it('accepts a mixed-case spelling and reports both forms', () => {
    const checked = validateHandle('Alice')
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.handle).toBe('alice')
    expect(checked.display).toBe('Alice')
  })

  it('collides case-insensitively — the property the address depends on', () => {
    // `handle(name)`'s address is a function of these bytes, so equal bytes *is* the collision.
    const forms = ['alice', 'Alice', 'ALICE', 'AlIcE', '  Alice  ']
    const keys = forms.map((f) => Buffer.from(encodeHandle(f)).toString('hex'))
    expect(new Set(keys).size).toBe(1)
  })

  it('displays case-sensitively', () => {
    const shown = ['alice', 'Alice', 'ALICE'].map((f) => Buffer.from(encodeDisplayName(f)).toString('hex'))
    expect(new Set(shown).size).toBe(3)
  })

  it('renders a stored display spelling as written, not folded', () => {
    const decoded = decodeHandle(encodeDisplayName('Alice'))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.display).toBe('Alice')
    expect(decoded.handle).toBe('alice')
  })

  it('matches a display name against the handle it claims, folded', () => {
    expect(handlesMatch(encodeDisplayName('Alice'), encodeHandle('alice'))).toBe(true)
    expect(handlesMatch(encodeDisplayName('ALICE'), encodeHandle('alice'))).toBe(true)
    // The impersonation case, closed by folding: capital I folds to `aiice`, not `alice`.
    expect(handlesMatch(encodeDisplayName('AIice'), encodeHandle('alice'))).toBe(false)
    expect(handlesMatch(encodeDisplayName('bob'), encodeHandle('alice'))).toBe(false)
  })

  it('prices the tier on the canonical form, whose length folding can change', () => {
    // `ẞ` is three bytes and folds to `ß`, two — the only reachable length-changing fold in the whole
    // allowed charset (`İ` folds to `i` + U+0307, which is allowed nowhere, so it is refused outright).
    // The name being claimed is the folded one, so that is what the tier must be read from.
    const display = encodeDisplayName('ẞ')
    const key = encodeHandle('ẞ')
    expect(display.filter((b) => b !== 0)).toHaveLength(3)
    expect(key.filter((b) => b !== 0)).toHaveLength(2)
    expect(handleTier(key)).toBe(0)
    expect(handleTier(display)).toBe(1)
  })

  it('accepts İ, whose fold introduces a combining mark the charset now admits', () => {
    // Until the charset opened, `İ` was the single code point in the whole set whose fold left it —
    // `i` + U+0307 — so `İstanbul` was unclaimable. Allowing every script allowed U+0307 with it, and
    // the problem dissolved without a single-character mapping.
    const checked = validateHandle('İstanbul')
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.display).toBe('İstanbul')
    expect([...checked.handle].map((c) => c.codePointAt(0))).toEqual([
      0x69, 0x307, 0x73, 0x74, 0x61, 0x6e, 0x62, 0x75, 0x6c,
    ])
  })

  it('accepts the Kelvin sign as K, because NFC already neutralises it', () => {
    // U+212A has a *canonical* decomposition to `K`, so normalisation removes the homoglyph before any
    // charset check sees it. Worth pinning: it is the reason the display charset check has no known
    // reachable member in this charset, rather than the reason it exists.
    const checked = validateHandle('\u212Aelvin')
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.display).toBe('Kelvin')
    expect(checked.handle).toBe('kelvin')
  })

  it('accepts mathematical bold A, which is assigned and therefore not denied', () => {
    // NFC preserves it (its decomposition is compatibility, not canonical) and it has no case mapping.
    // Under the open charset it is simply a character, and `𝐀lice` is a different name from `Alice`.
    // That is the confusable trade taken deliberately — see the module header.
    expect(validateHandle('\u{1D400}lice').ok).toBe(true)
  })

  it('measures the ceiling on the canonical form too', () => {
    // 30 display bytes that fold to 31 are claimable; 31 that fold to 32 are not, even though the
    // display spelling fits the field.
    // ẞ makes the display longer than the canonical, so the *display* form is what runs out of field
    // first — and both bounds are checked, or a claimable name would be unwritable as its owner spells it.
    expect(validateHandle(`${'a'.repeat(28)}ẞ`).ok).toBe(true) // 31 display, 30 canonical
    expect(validateHandle(`${'a'.repeat(29)}ẞ`).reason).toBe('too-long') // 32 display, 31 canonical
  })

  it('still refuses a decomposed spelling, which is a different name wearing the same face', () => {
    const decomposed = 'élise' // e + combining acute, not é
    const stored = new Uint8Array(32)
    stored.set(new TextEncoder().encode(decomposed))
    expect(decodeHandle(stored).reason).toBe('not-canonical')
  })

  it('still strands what the charset refuses, whatever its case', () => {
    // Structural refusals only now. `Al!ce` and `Alicа` (Cyrillic) are valid names under the open
    // charset — they are simply *different* names, which is the confusable trade taken on purpose.
    for (const bad of ['_Alice', 'Alice_', 'Ali__ce', 'Ali\u200dce', 'Alice\u{1F600}']) {
      expect(validateHandle(bad).ok, bad).toBe(false)
    }
    expect(validateHandle('Al!ce').ok).toBe(false)
    // Still a valid, different name: confusables are not judged here.
    expect(validateHandle('Alicа').ok).toBe(true)
  })
})

describe('foldLengthChanges', () => {
  it('still reports İ and ẞ, the two the Latin range contributes', () => {
    const byCodePoint = new Map(foldLengthChanges().map((e) => [e.codePoint, e]))
    expect(byCodePoint.get(0x0130)).toMatchObject({fromBytes: 2, toBytes: 3})
    expect(byCodePoint.get(0x1e9e)).toMatchObject({fromBytes: 3, toBytes: 2})
    // Code points, never literals: `i` + U+0307 is a decomposed sequence, and a tool that normalises
    // this file on save would silently rewrite it into the assertion that passes.
    expect(byCodePoint.get(0x0130)?.to).toBe(String.fromCodePoint(0x0069, 0x0307))
    expect(byCodePoint.get(0x1e9e)?.to).toBe(String.fromCodePoint(0x00df))
  })

  it('is now dominated by Indic and Tibetan, where NFC decomposes rather than composes', () => {
    const found = foldLengthChanges()
    // Opening the charset took this from two entries to hundreds, which is why the device probe reads
    // a digest of the whole sweep rather than this list. A count is still a cheap canary.
    expect(found.length).toBeGreaterThan(400)
    const nukta = found.find((e) => e.codePoint === 0x0958)
    expect(nukta).toMatchObject({fromBytes: 3, toBytes: 6})
  })
})
