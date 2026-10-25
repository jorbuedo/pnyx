// Pnyx handles — the human-readable name an identity may claim for its `C`.
//
// The contract enforces exactly two things about a handle: that no other identity already holds
// those bytes, and that they are not all-zero (the "no name" sentinel). Everything else — which
// characters exist, which scripts may share a name, what counts as canonical — lives here, because
// enforcing it in-circuit is not affordable: a four-comparison range check costs ~395 constraint
// rows per byte, which puts a 32-byte ASCII check at K15, and Unicode script/confusable tables are
// three orders of magnitude beyond that. ENS reached the same split — ENSIP-15 is a client
// standard, and the registry contract validates length and nothing else.
//
// That makes this module the whole policy, so it runs in *both* directions. On write it produces
// the canonical bytes; on read it decides whether bytes off the chain may be rendered as a handle.
// Running it on read is what closes the gap the circuit leaves: a hostile client can claim the
// decomposed or upper-case spelling of a name, but those bytes are not canonical, so they never
// render and cannot be mistaken for the real one.
//
// **What this module denies, and what it deliberately does not.** Confusables are not policed here.
// `аӏісе` in Cyrillic, `paypa1`, `ıstanbul` next to `istanbul` — all valid, all distinct names. That
// is a layering decision: impersonation is answered by the identicon a handle is shown with, by the ZK
// gating on circles, and by the surfaces above, none of which a charset rule can substitute for. It is
// also the only answer available, because **there is no registry to check a new name against** — one
// contract per name means nothing enumerates what is already claimed, so "is this confusable with an
// existing name?" is a question this design cannot ask.
//
// What `handle-charset.ts` denies instead is narrower and different in kind: code points where the
// bytes and what a reader sees do not correspond at all — controls, bidi overrides, invisibles,
// unassigned, private use, interior whitespace, emoji. Plus two structural rules here: a name may not
// begin with a combining mark, and no more than four nonspacing marks may run together.
//
import {
  allowedCodePointRanges,
  isCombiningMark,
  isDeniedCodePoint,
  isNonspacingMark,
  MAX_CONSECUTIVE_NONSPACING_MARKS,
} from './handle-charset.js'

/** Why a candidate handle was refused. */
export type HandleRejection =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'disallowed-character'
  | 'leading-separator'
  | 'trailing-separator'
  | 'repeated-separator'
  | 'leading-combining-mark'
  | 'too-many-combining-marks'
  | 'not-canonical'
  | 'invalid-utf8'

export type HandleCheck =
  | {
      readonly ok: true
      /**
       * The **canonical** spelling — folded and NFC-composed. This is the name a handle contract's
       * address derives from, so it is what decides whether two spellings collide.
       */
      readonly handle: string
      /**
       * The spelling as written, trimmed and NFC-composed but **not folded** — what a reader renders.
       *
       * `Alice` and `alice` are the same handle with different displays. Equal to {@link handle} for
       * an already-lower-case name.
       */
      readonly display: string
      /** UTF-8 of {@link handle} — the canonical bytes, never the display ones. */
      readonly bytes: Uint8Array
      /** UTF-8 of {@link display}. Can differ in *length* from {@link bytes}; see {@link encodeDisplayName}. */
      readonly displayBytes: Uint8Array
      readonly reason?: undefined
    }
  | {readonly ok: false; readonly reason: HandleRejection}

/** The width of `IdentityRow.name` in `pnyx.compact`. A handle is UTF-8, left-aligned, zero-padded. */
export const HANDLE_BYTES = 32

/**
 * Minimum length, in **bytes**. One, and it is structural rather than policy: `pad(32, "")` already
 * means "no handle" in `identity(C).primaryName`, so a zero-length name is unrepresentable.
 *
 * ⚠️ **This was 5 until 2026-08-24, and the drop is deliberate.** The floor's only real job was
 * stopping a modified client land-grabbing short names — and a *permit* now gates every `bind`, at
 * every length, so the floor defended against a threat the permit mechanism removes outright. Short
 * names became **expensive rather than forbidden** ({@link handleTier}), which also moves naming
 * policy out of a frozen assert and into mutable price state — the distinction that matters on a chain
 * where the code is in the address.
 *
 * A *stricter client* remains the harmful direction: it strands names on chain that the app then
 * refuses to render, unreachable for their owner and free to grief. That is why this may not creep
 * back up without the circuit moving with it.
 */
export const MIN_HANDLE_BYTES = 1

/**
 * Maximum length, in **bytes** — one less than the 32-byte field, and the missing byte buys soundness.
 *
 * `bind` reads a name's length from limbs supplied as a witness, bound to the sealed name by field
 * recomposition. That recomposition ranges over 2^256 while the scalar modulus is ~0.45 * 2^256,
 * leaving room for exactly one wrap: limbs recomposing to `name + p` are *different bytes with the
 * same field element*, and the carries change the low limbs the tier reads — buying a premium name at
 * a cheap tier. Forcing the top limb to zero caps the value at 2^248 and makes the wrap
 * unrepresentable, at the cost of the 32nd byte. One comparison instead of a full range check.
 */
export const MAX_HANDLE_BYTES = 31

/**
 * Which price tier a handle falls in, from its **byte** length. Zero is the most expensive.
 *
 * Boundaries decided 2026-08-24, with finer resolution at the short end because that is where value
 * changes fastest — a name's worth grows geometrically as it shortens, so the tiers should too:
 *
 * | tier | bytes | Latin | Han (3B/char) |
 * |---|---|---|---|
 * | 0 | 1–2 | 1–2 chars | — |
 * | 1 | 3 | 3 | 1 char |
 * | 2 | 4 | 4 | — |
 * | 3 | 5–6 | 5–6 | 2 chars |
 * | 4 | 7–10 | 7–10 | 3 chars |
 * | 5 | 11–22 | 11–22 | 4–7 chars |
 * | 6 | 23–31 | 23–31 | 8–10 chars |
 *
 * ⚠️ **Byte tiers underprice non-Latin scripts, permanently.** A 1-character Han name is tier 1 where
 * a 1-character Latin name is tier 0, and a 2-character Han name is tier 3. Tiering by *codepoint*
 * would fix it and is not affordable: the circuit sees UTF-8 bytes, not characters, and counting them
 * needs variable-length logic with no dynamic indexing. Accepted deliberately in exchange for the
 * short-Latin resolution above; the boundaries are frozen at deploy, so this cannot be revisited.
 *
 * ⚠️ **Must stay equal to `bind`'s boundary probes.** The circuit derives the same tier from limbs and
 * requires a permit whose color is exactly that tier's, so a client computing a different tier builds
 * a transaction that cannot prove. The circuit probes the first byte of each tier — indices 2, 3, 4, 6,
 * 10, 22 — which is this table read as "the length is at least".
 */
export const handleTier = (bytes: Uint8Array): number => {
  const length = bytes.indexOf(0)
  // Left-aligned and zero-padded, so the first zero ends the name; a full-width name has no zero.
  const size = length === -1 ? bytes.length : length
  if (size < MIN_HANDLE_BYTES) throw new Error(`handleTier: a handle needs at least ${MIN_HANDLE_BYTES} byte`)
  if (size > MAX_HANDLE_BYTES) throw new Error(`handleTier: ${size} bytes exceeds the ${MAX_HANDLE_BYTES}-byte maximum`)
  if (size <= 2) return 0
  if (size === 3) return 1
  if (size === 4) return 2
  if (size <= 6) return 3
  if (size <= 10) return 4
  if (size <= 22) return 5
  return 6
}

/**
 * The characters treated as word separators: `-`, `_` and the ordinary space.
 *
 * Everything else the charset admits is a character. Being a separator is what gives each of them the
 * three rules below — it cannot lead, trail, or sit next to another — which is the whole reason a
 * space is safe to admit: `a  b` and `a - b` are refused, so a name has exactly one shape.
 *
 * ⚠️ The set is *uniform*: `a -b` is a repeat too, not just `a  b`. Two separators of different kinds
 * touching reads as a typo either way, and treating them as one class is what keeps the rule
 * explicable.
 */
const SEPARATORS = new Set([0x20, 0x2d, 0x5f])

const decodeUtf8Strict = (bytes: Uint8Array): string | null => {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] as number
    let cp: number
    let extra: number
    let lo: number
    let hi: number
    if (b0 <= 0x7f) {
      cp = b0
      extra = 0
      lo = 0x80
      hi = 0xbf
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f
      extra = 1
      lo = 0x80
      hi = 0xbf
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f
      extra = 2
      lo = b0 === 0xe0 ? 0xa0 : 0x80
      hi = b0 === 0xed ? 0x9f : 0xbf
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07
      extra = 3
      lo = b0 === 0xf0 ? 0x90 : 0x80
      hi = b0 === 0xf4 ? 0x8f : 0xbf
    } else {
      return null
    }
    if (i + extra >= bytes.length) return null
    for (let k = 1; k <= extra; k++) {
      const b = bytes[i + k] as number
      const min = k === 1 ? lo : 0x80
      const max = k === 1 ? hi : 0xbf
      if (b < min || b > max) return null
      cp = (cp << 6) | (b & 0x3f)
    }
    out += String.fromCodePoint(cp)
    i += extra + 1
  }
  return out
}

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * The canonical spelling of a handle: trimmed, case-folded and NFC-composed.
 *
 * Case folding uses `toLowerCase`, never `toLocaleLowerCase` — the latter is locale-sensitive and
 * would fold Turkish `I` differently depending on who is typing, so the same input would canonicalise
 * to two different handles. Folding runs before NFC because folding can introduce a combining mark
 * (`İ` → `i` + U+0307) that NFC then recomposes or that the allowlist rejects.
 */
export const canonicalizeHandle = (input: string): string => input.trim().toLowerCase().normalize('NFC')

/**
 * Everything about a handle's shape: charset, group, separators, width.
 *
 * **Validates the canonical form, and carries the display form alongside.** Case is a display choice
 * and folding is what makes two spellings one name, so every rule is applied to the folded spelling —
 * a name is claimable or not regardless of how its owner capitalises it.
 *
 * ⚠️ **The width rule is on the canonical bytes**, because those are the name being claimed. Folding
 * can *lengthen* a name: `İ` is two bytes and folds to `i` + U+0307, three. So a 31-byte display
 * spelling containing one folds to 32 and is unclaimable, and this is where that is caught.
 */
const checkShape = (input: string): HandleCheck => {
  const display = input.trim().normalize('NFC')
  const handle = canonicalizeHandle(input)
  if (handle.length === 0) return {ok: false, reason: 'empty'}

  // ⚠️ **Both spellings carry the width rule, not just the canonical one.** Folding changes byte
  // length in both directions — `ẞ` shrinks three bytes to two, `İ` grows two to three — so a name can
  // fit as typed and overflow once folded, or the reverse. Both ends have to fit the field or the name
  // is not usable. Only the canonical side feeds {@link handleTier}, which is what the chain prices.
  const bytes = encodeUtf8(handle)
  if (bytes.length > MAX_HANDLE_BYTES) return {ok: false, reason: 'too-long'}
  const displayBytes = encodeUtf8(display)
  if (displayBytes.length > MAX_HANDLE_BYTES) return {ok: false, reason: 'too-long'}

  // Both spellings are charset-checked, and the display one is not optional: folding can introduce a
  // code point the input never contained, and it can equally hide one the input did contain.
  for (const text of [display, handle]) {
    for (const ch of text) {
      if (isDeniedCodePoint(ch.codePointAt(0) as number)) return {ok: false, reason: 'disallowed-character'}
    }
  }

  const cps = [...handle].map((ch) => ch.codePointAt(0) as number)

  if (SEPARATORS.has(cps[0] as number)) return {ok: false, reason: 'leading-separator'}
  if (SEPARATORS.has(cps[cps.length - 1] as number)) return {ok: false, reason: 'trailing-separator'}

  // A leading mark has nothing to attach to, so it renders on whatever the UI drew before it.
  if (isCombiningMark(cps[0] as number)) return {ok: false, reason: 'leading-combining-mark'}
  if (isCombiningMark(display.codePointAt(0) as number)) return {ok: false, reason: 'leading-combining-mark'}

  let run = 0
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] as number
    if (SEPARATORS.has(cp) && SEPARATORS.has(cps[i - 1] as number)) {
      return {ok: false, reason: 'repeated-separator'}
    }
    // Nonspacing marks only. A spacing mark (`Mc`) is how an Indic syllable is written, and capping
    // those would refuse ordinary Devanagari; an unbounded `Mn` run is what smears a name vertically
    // across the rows around it.
    run = isNonspacingMark(cp) ? run + 1 : 0
    if (run > MAX_CONSECUTIVE_NONSPACING_MARKS) return {ok: false, reason: 'too-many-combining-marks'}
  }

  return {ok: true, handle, display, bytes, displayBytes}
}

/**
 * Check a handle a user is trying to claim, in whatever case they typed it.
 *
 * ⚠️ **No longer rejects a non-canonical spelling.** Until 2026-08-24 `Alice` was refused outright; case
 * is now a display choice, so it is accepted and folded. What that means for a caller: `handle` is the
 * name being claimed and `display` is what to show, and the two are not interchangeable.
 *
 * Returns a reason rather than throwing, because this runs against live input as it is typed and every
 * rejection needs a message the caller must not confuse with a defect.
 */
export const validateHandle = (input: string): HandleCheck => {
  const shape = checkShape(input)
  if (shape.ok && shape.bytes.length < MIN_HANDLE_BYTES) return {ok: false, reason: 'too-short'}
  return shape
}

/**
 * Encode a validated handle into its fixed-width **canonical** form.
 *
 * ⚠️ **This is the one function whose output an address may derive from.** `handle(name)`'s address is a
 * function of the sealed name, so two spellings collide exactly when this returns the same bytes for
 * both — which is what makes `Alice` and `alice` one name. Every path that reaches the chain must go
 * through here: resolution, claiming, and the bidirectional check. A caller that folds by hand, or
 * derives from a display spelling, creates a second address for the same name and strands it.
 *
 * @throws if the handle is not valid — callers must validate first, and a caller that did not is a
 * defect rather than a user error.
 */
export const encodeHandle = (handle: string): Uint8Array => {
  const checked = validateHandle(handle)
  if (!checked.ok) throw new Error(`handle: cannot encode an invalid handle (${checked.reason})`)
  const out = new Uint8Array(HANDLE_BYTES)
  out.set(checked.bytes)
  return out
}

/**
 * Encode the **display** spelling for `identity(C).primaryName` — the case its owner chose.
 *
 * Separate from {@link encodeHandle} because the two answer different questions: which name is this
 * (canonical, decides collision and the address), versus how is it shown (display, decides nothing).
 * Writing the display form where the canonical one belongs derives an address nobody else can find.
 *
 * A reader must fold this before comparing it to a handle it owns — see {@link handlesMatch}.
 *
 * @throws for the same reason {@link encodeHandle} does.
 */
export const encodeDisplayName = (handle: string): Uint8Array => {
  const checked = validateHandle(handle)
  if (!checked.ok) throw new Error(`handle: cannot encode an invalid display name (${checked.reason})`)
  const out = new Uint8Array(HANDLE_BYTES)
  out.set(checked.displayBytes)
  return out
}

/**
 * Whether a display spelling names the same handle as a canonical one — the folded comparison the
 * bidirectional validity rule needs.
 *
 * `identity(C).primaryName` is unvalidated on chain, so a reader must check it against the handle
 * contract `C` actually owns. Comparing raw bytes would make `Alice` fail against the `alice` it owns;
 * comparing folded closes the impersonation case for free, because `AIice` folds to `aiice` and misses.
 */
export const handlesMatch = (displayName: Uint8Array, canonical: Uint8Array): boolean => {
  const shown = decodeHandle(displayName)
  if (!shown.ok) return false
  const claimed = decodeHandle(canonical)
  if (!claimed.ok) return false
  return shown.handle === claimed.handle
}

/** An all-zero `name` field: this identity claims no handle. */
export const NO_HANDLE: Uint8Array = new Uint8Array(HANDLE_BYTES)

/**
 * The read gate: decide whether bytes read off the chain may be rendered as a handle.
 *
 * ⚠️ **Accepts any case, and returns the spelling as stored.** It used to require the bytes to be
 * *exactly* canonical; case is now a display choice, so a mixed-case spelling renders as written while
 * `handle` still carries the folded form for comparison. NFC is still required — a decomposed spelling
 * is a *different* name that happens to look identical, which is the homoglyph case rather than a
 * styling one.
 *
 * Still refuses anything the charset, script or separator rules reject, so bytes minted outside this
 * app's policy are stranded: on chain, unrenderable, and invisible to every reader here.
 *
 * Deliberately does **not** apply {@link MIN_HANDLE_BYTES}, which is 1 and structural anyway. This runs
 * the permissive way on purpose — only names the chain already accepted can reach it.
 */
export const decodeHandle = (bytes: Uint8Array): HandleCheck => {
  if (bytes.length !== HANDLE_BYTES) return {ok: false, reason: 'invalid-utf8'}
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  if (end === 0) return {ok: false, reason: 'empty'}

  const text = decodeUtf8Strict(bytes.subarray(0, end))
  if (text === null) return {ok: false, reason: 'invalid-utf8'}

  const checked = checkShape(text)
  if (!checked.ok) return checked
  // NFC is required, case is not: a decomposed spelling is a different name wearing the same face.
  if (checked.display !== text) return {ok: false, reason: 'not-canonical'}
  return checked
}

/** Whether a row's `name` field carries a handle at all. */
export const hasHandle = (name: Uint8Array): boolean => name.some((b) => b !== 0)

/**
 * Whether a `names` entry is a reserved handle rather than one somebody owns.
 *
 * Reserved handles are written by the constructor against an all-zero owner, which no identity can
 * hold — `claimName` writes the `C` it derives from a witness, and asserts it is not the sentinel.
 * So the distinction is readable straight from the map value, and there is deliberately **no list
 * of reserved names in this module**: duplicating the constructor's list here would be a second
 * source of truth to drift, and the chain already answers the question.
 *
 * Callers checking availability should distinguish the two — "reserved" and "taken" are different
 * answers to a user typing a name.
 */
export const isReservedOwner = (owner: Uint8Array): boolean => owner.every((b) => b === 0)

/** A code point whose case fold changes how many UTF-8 bytes it occupies. */
export type FoldLengthChange = {
  readonly codePoint: number
  readonly from: string
  readonly to: string
  readonly fromBytes: number
  readonly toBytes: number
}

/**
 * Every allowed code point whose case fold changes its **byte length**, with what it folds to.
 *
 * Pure, and exported so a device probe can run it on Hermes. ⚠️ **The engine's `toLowerCase` is
 * load-bearing for address derivation**: a handle contract's address derives from the folded bytes, so
 * an engine that folds any code point differently from the reference derives an address the app can
 * neither find nor bind — and the failure looks like "that name is not taken" rather than like a bug.
 *
 * On Node this returns exactly two entries: `İ` (U+0130) → `i` + U+0307, two bytes to three, and `ẞ`
 * (U+1E9E) → `ß`, three to two. `İ`'s fold introduces U+0307, which no group allows, so a name
 * containing it is refused by the charset check rather than stranded on chain.
 *
 * ⚠️ **A length change is the narrow half of the risk.** A fold that returns the wrong code point of
 * the same width — or that does not fold at all — is invisible here and strands a name just as
 * thoroughly. `app/src/services/handle-fold-probe.ts` digests the whole sweep for that; this
 * stays because a length change is the one divergence a human can read straight off the screen.
 */
export const foldLengthChanges = (): readonly FoldLengthChange[] => {
  const out: FoldLengthChange[] = []
  for (const [lo, hi] of allowedCodePointRanges()) {
    for (let cp = lo; cp <= hi; cp++) {
      const from = String.fromCodePoint(cp)
      const to = canonicalizeHandle(from)
      const fromBytes = encodeUtf8(from).length
      const toBytes = encodeUtf8(to).length
      if (fromBytes !== toBytes) out.push({codePoint: cp, from, to, fromBytes, toBytes})
    }
  }
  return out
}
