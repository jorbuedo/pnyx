/**
 * Bytewords (BCR-2020-012): each byte as one of 256 four-letter English words.
 *
 * Three styles share one table. `standard` and `uri` differ only in separator; `minimal` keeps
 * each word's first and last letter and drops the separator, which is what a UR carries — the
 * word list is built so those two letters are unique across all 256, and `wordIndexByMinimal`
 * asserts that rather than assuming it.
 *
 * Decoding returns a typed failure instead of throwing: this parses camera input, so malformed
 * is an expected outcome on the happy path, not an exception. Encoding throws, because a caller
 * handing us something unencodable is a bug in the caller.
 *
 * @module
 */

import {crc32, crc32Bytes} from './crc32.js'

/**
 * The 256 Bytewords, index 0..255, verbatim from BCR-2020-012.
 *
 * Written as one space-separated string rather than an array literal so that a dropped or
 * duplicated entry changes the length and trips the invariant check below, instead of silently
 * shifting every later byte's encoding by one.
 */
const WORD_LIST =
  'able acid also apex aqua arch atom aunt away axis back bald barn belt beta bias ' +
  'blue body brag brew bulb buzz calm cash cats chef city claw code cola cook cost ' +
  'crux curl cusp cyan dark data days deli dice diet door down draw drop drum dull ' +
  'duty each easy echo edge epic even exam exit eyes fact fair fern figs film fish ' +
  'fizz flap flew flux foxy free frog fuel fund gala game gear gems gift girl glow ' +
  'good gray grim guru gush gyro half hang hard hawk heat help high hill holy hope ' +
  'horn huts iced idea idle inch inky into iris iron item jade jazz join jolt jowl ' +
  'judo jugs jump junk jury keep keno kept keys kick kiln king kite kiwi knob lamb ' +
  'lava lazy leaf legs liar limp lion list logo loud love luau luck lung main many ' +
  'math maze memo menu meow mild mint miss monk nail navy need news next noon note ' +
  'numb obey oboe omit onyx open oval owls paid part peck play plus poem pool pose ' +
  'puff puma purr quad quiz race ramp real redo rich road rock roof ruby ruin runs ' +
  'rust safe saga scar sets silk skew slot soap solo song stub surf swan taco task ' +
  'taxi tent tied time tiny toil tomb toys trip tuna twin ugly undo unit urge user ' +
  'vast very veto vial vibe view visa void vows wall wand warm wasp wave waxy webs ' +
  'what when whiz wolf work yank yawn yell yoga yurt zaps zero zest zinc zone zoom'

export const BYTEWORDS: readonly string[] = WORD_LIST.split(' ')

/** The `minimal` style's two-letter form of a word: first letter and last. */
export const minimalKey = (word: string): string => word.slice(0, 1) + word.slice(3, 4)

// The table's load-bearing properties, checked before anything is derived from it. A
// transcription slip in WORD_LIST breaks at import rather than producing a codec that encodes
// fine and decodes to different bytes.
if (BYTEWORDS.length !== 256) {
  throw new Error(`bytewords: expected 256 words, got ${BYTEWORDS.length}`)
}
if (BYTEWORDS.some((word) => word.length !== 4)) {
  throw new Error('bytewords: every word must be exactly 4 letters')
}

/** Full word → byte value. */
const wordIndex: ReadonlyMap<string, number> = new Map(BYTEWORDS.map((word, index) => [word, index]))

/** Two letters ("ta") → byte value. */
const wordIndexByMinimal: ReadonlyMap<string, number> = new Map(
  BYTEWORDS.map((word, index) => [minimalKey(word), index]),
)

if (wordIndex.size !== 256 || wordIndexByMinimal.size !== 256) {
  throw new Error('bytewords: words and their first+last letter pairs must both be unique')
}

export type BytewordsStyle = 'standard' | 'uri' | 'minimal'

const SEPARATOR: Record<BytewordsStyle, string> = {standard: ' ', uri: '-', minimal: ''}

export type BytewordsError =
  /** Length is not a whole number of words, so the input is truncated or padded. */
  | {readonly kind: 'malformed'; readonly detail: string}
  /** A token that is not one of the 256, i.e. a misread frame or a typo. */
  | {readonly kind: 'unknown-word'; readonly token: string}
  /** Well-formed words whose trailing CRC-32 does not match the body. */
  | {readonly kind: 'checksum-mismatch'; readonly expected: number; readonly actual: number}

export type BytewordsResult =
  | {readonly ok: true; readonly data: Uint8Array}
  | {readonly ok: false; readonly error: BytewordsError}

/** Render bytes as Bytewords, one word per byte. Adds no checksum — see {@link encodeBytewords}. */
export const bytewordsFromBytes = (data: Uint8Array, style: BytewordsStyle): string => {
  const words: string[] = []
  for (const byte of data) {
    // biome-ignore lint/style/noNonNullAssertion: a Uint8Array element is 0..255 and the table is asserted to hold 256.
    const word = BYTEWORDS[byte]!
    words.push(style === 'minimal' ? minimalKey(word) : word)
  }
  return words.join(SEPARATOR[style])
}

/** Parse Bytewords back to bytes. Verifies no checksum — see {@link decodeBytewords}. */
export const bytewordsToBytes = (encoded: string, style: BytewordsStyle): BytewordsResult => {
  const tokens: string[] =
    style === 'minimal'
      ? (encoded.match(/.{1,2}/g) ?? []).filter((chunk) => chunk.length > 0)
      : encoded.split(SEPARATOR[style]).filter((token) => token.length > 0)

  if (style === 'minimal' && encoded.length % 2 !== 0) {
    return {ok: false, error: {kind: 'malformed', detail: `minimal length ${encoded.length} is not even`}}
  }

  const out = new Uint8Array(tokens.length)
  for (const [i, token] of tokens.entries()) {
    const index = style === 'minimal' ? wordIndexByMinimal.get(token) : wordIndex.get(token)
    if (index === undefined) return {ok: false, error: {kind: 'unknown-word', token}}
    out[i] = index
  }
  return {ok: true, data: out}
}

/** Append the CRC-32 trailer and render. This is what the UR format carries. */
export const encodeBytewords = (payload: Uint8Array, style: BytewordsStyle): string => {
  const checksummed = new Uint8Array(payload.length + 4)
  checksummed.set(payload, 0)
  checksummed.set(crc32Bytes(payload), payload.length)
  return bytewordsFromBytes(checksummed, style)
}

/** Parse, verify the CRC-32 trailer, and return the payload without it. */
export const decodeBytewords = (encoded: string, style: BytewordsStyle): BytewordsResult => {
  const parsed = bytewordsToBytes(encoded, style)
  if (!parsed.ok) return parsed
  // 4 bytes is the shortest well-formed input: an empty payload plus its trailer, which is
  // exactly what `encodeBytewords(new Uint8Array())` emits. Some references require 5, i.e. at
  // least one payload byte — that is a UR-level rule (a UR always carries CBOR) and does not
  // belong here, where encode and decode should stay exact inverses.
  if (parsed.data.length < 4) {
    return {
      ok: false,
      error: {kind: 'malformed', detail: `${parsed.data.length} bytes is too short to hold a checksum`},
    }
  }
  const body = parsed.data.subarray(0, parsed.data.length - 4)
  const trailer = parsed.data.subarray(parsed.data.length - 4)
  const expected = new DataView(trailer.buffer, trailer.byteOffset, 4).getUint32(0, false)
  const actual = crc32(body)
  if (expected !== actual) return {ok: false, error: {kind: 'checksum-mismatch', expected, actual}}
  return {ok: true, data: Uint8Array.from(body)}
}
