/**
 * Does `String.prototype.normalize('NFC')` actually work on this device?
 *
 * Handle validation (`@pnyx/contract-client/handle`) treats NFC as the canonical form: the bytes we
 * claim on chain are the composed spelling, and the read gate refuses anything that is not already
 * canonical. That makes NFC load-bearing rather than cosmetic — if it silently no-ops, two users can
 * claim spellings that render identically, and a name typed on a Vietnamese keyboard may never match
 * the one stored.
 *
 * The method is known to *exist* on Hermes: `packages/wallet/account/seed.ts` calls
 * `.normalize('NFKD')` on every sign-in. That proves only that it does not throw. English mnemonics
 * are ASCII, where NFKD is the identity function, so a stubbed implementation would look identical.
 * Hermes routes normalization through platform Unicode, and there is a "lite" build where it
 * degrades — hence this probe.
 *
 * Vectors are written as codepoint arrays, never as literal decomposed strings: a literal would be
 * at the mercy of whatever editor or tool last touched this file, and a source-level normalisation
 * would quietly turn every test into the trivial one.
 *
 * @module
 */

export type NfcVector = {
  readonly name: string
  readonly input: readonly number[]
  readonly expected: readonly number[]
  /** What a failure of this specific vector would mean. */
  readonly why: string
}

export const NFC_VECTORS: readonly NfcVector[] = [
  {
    name: 'ASCII passthrough',
    input: [0x61, 0x6c, 0x69, 0x63, 0x65],
    expected: [0x61, 0x6c, 0x69, 0x63, 0x65],
    why: 'control — passes even on a no-op implementation, so it isolates the others',
  },
  {
    name: 'Latin: e + acute',
    input: [0x65, 0x0301],
    expected: [0x00e9],
    why: 'the simplest composition; French, Spanish and Portuguese handles depend on it',
  },
  {
    name: 'Vietnamese: e + circumflex + acute',
    input: [0x65, 0x0302, 0x0301],
    expected: [0x1ebf],
    why: 'two stacked marks composing to one codepoint — Vietnamese is why NFC is load-bearing here',
  },
  {
    name: 'Hangul: conjoining jamo',
    input: [0x1112, 0x1161, 0x11ab],
    expected: [0xd55c],
    why: 'algorithmic Hangul composition, a separate code path from the decomposition tables',
  },
  {
    name: 'canonical ordering of combining marks',
    input: [0x71, 0x0307, 0x0323],
    expected: [0x71, 0x0323, 0x0307],
    why: 'reordering by combining class, with nothing to compose — a naive port skips this',
  },
  {
    name: 'singleton: angstrom sign',
    input: [0x212b],
    expected: [0x00c5],
    why: 'singleton decomposition, which a table-driven port can omit without failing anything else',
  },
]

export type NfcVectorResult = {
  readonly vector: NfcVector
  readonly actual: readonly number[]
  readonly ok: boolean
}

/** `'ok'` — every vector matched. `'no-op'` — normalize returned its input, i.e. a stub. */
export type NfcVerdict = 'ok' | 'no-op' | 'wrong'

const codepoints = (s: string): readonly number[] => [...s].map((ch) => ch.codePointAt(0) as number)

export const runNfcVector = (vector: NfcVector): NfcVectorResult => {
  const actual = codepoints(String.fromCodePoint(...vector.input).normalize('NFC'))
  return {
    vector,
    actual,
    ok: actual.length === vector.expected.length && actual.every((cp, i) => cp === vector.expected[i]),
  }
}

export const runNfcVectors = (): readonly NfcVectorResult[] => NFC_VECTORS.map(runNfcVector)

/**
 * Distinguishes a stub from a wrong answer, because the two have different fixes: a no-op means the
 * runtime has no Unicode data and we must ship our own composition, while a wrong answer means the
 * data is there and disagrees with us.
 */
export const nfcVerdict = (results: readonly NfcVectorResult[]): NfcVerdict => {
  if (results.every((r) => r.ok)) return 'ok'
  const failed = results.filter((r) => !r.ok)
  const allPassThrough = failed.every(
    (r) => r.actual.length === r.vector.input.length && r.actual.every((cp, i) => cp === r.vector.input[i]),
  )
  return allPassThrough ? 'no-op' : 'wrong'
}
