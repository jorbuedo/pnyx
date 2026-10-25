/**
 * Does this device's `String.prototype.toLowerCase` agree with the reference on every code point a
 * handle may contain?
 *
 * A handle contract's address derives from the **folded** bytes (`canonicalizeHandle` — trim, fold,
 * NFC). So the fold is not a display nicety: an engine that folds one allowed code point differently
 * derives an address the app can neither find nor bind, and the failure surfaces as *"that name is
 * free"* rather than as an error. Nothing else in the app would report it.
 *
 * ⚠️ **This is the wider half of a risk `foldLengthChanges()` only half covers.** That function
 * reports folds whose byte *length* changes, which a human can read straight off a screen — but the
 * commonest divergence keeps the width and changes the content (`А` U+0410 not folding to `а`
 * U+0430), or drops the fold entirely outside ASCII. Neither is visible in a length list, so this
 * module sweeps every allowed code point and digests the result.
 *
 * The sweep calls `canonicalizeHandle` itself rather than `toLowerCase`, because the address derives
 * from the whole canonicalisation. That folds NFC into the digest too — `unicode-nfc-probe.ts` is
 * what separates the two, so run both: NFC green with the sweep red points at the fold.
 *
 * Vectors are written as code-point arrays, never as literal strings — a literal is at the mercy of
 * whatever tool last touched this file, and a source-level fold or normalisation would quietly turn
 * a vector into the trivial one.
 *
 * @module
 */

import {sha256} from '@noble/hashes/sha2.js'
import {canonicalizeHandle} from '@pnyx/contract-client/handle'
import {allowedCodePointRanges} from '@pnyx/contract-client/handle-charset'

export type FoldVector = {
  readonly name: string
  readonly input: readonly number[]
  readonly expected: readonly number[]
  /** What a failure of this specific vector would mean. */
  readonly why: string
}

export const FOLD_VECTORS: readonly FoldVector[] = [
  {
    name: 'ASCII: A',
    input: [0x41],
    expected: [0x61],
    why: 'control — passes even on an ASCII-only fold, so it isolates the others',
  },
  {
    name: 'ASCII: I is dotted, not dotless',
    input: [0x49],
    expected: [0x69],
    why: 'proves the fold is not locale-sensitive here; a Turkish locale gives U+0131 and every I-bearing name derives a different address per device',
  },
  {
    name: 'Latin-1: E acute',
    input: [0x00c9],
    expected: [0x00e9],
    why: 'the first non-ASCII fold — French, Spanish and Portuguese handles start failing here',
  },
  {
    name: 'Latin Extended-A: L with stroke',
    input: [0x0141],
    expected: [0x0142],
    why: 'a separate table from Latin-1; central European handles',
  },
  {
    name: 'Latin Extended Additional: E circumflex acute',
    input: [0x1ebe],
    expected: [0x1ebf],
    why: 'the Vietnamese block, which is the largest allowed Latin range and the least likely to be in a trimmed Unicode build',
  },
  {
    name: 'Cyrillic: A',
    input: [0x0410],
    expected: [0x0430],
    why: 'same width, different bytes — the divergence class foldLengthChanges cannot see at all',
  },
  {
    name: 'Cyrillic: IE with grave',
    input: [0x0400],
    expected: [0x0450],
    why: 'the 0x0400-0x040F row folds by +80 rather than +32, a distinct rule from the main alphabet',
  },
  {
    name: 'capital sharp S shrinks',
    input: [0x1e9e],
    expected: [0x00df],
    why: 'three bytes fold to two — the only allowed code point that shortens, and it changes which price tier a name lands in',
  },
  {
    name: 'dotted capital I grows',
    input: [0x0130],
    expected: [0x0069, 0x0307],
    why: 'two bytes fold to three and introduce U+0307, which no group allows; this is why an Istanbul spelling with it is refused rather than stranded',
  },
  {
    name: 'Han passthrough',
    input: [0x4e00],
    expected: [0x4e00],
    why: 'CJK has no case — a fold that alters it would corrupt every Chinese, Japanese and Korean handle',
  },
  {
    name: 'Hangul passthrough',
    input: [0xac00],
    expected: [0xac00],
    why: 'precomposed syllables must survive fold and NFC together, since NFC is where a naive port decomposes them',
  },
]

export type FoldVectorResult = {
  readonly vector: FoldVector
  readonly actual: readonly number[]
  readonly ok: boolean
}

const codepoints = (s: string): readonly number[] => [...s].map((ch) => ch.codePointAt(0) as number)

export const runFoldVector = (vector: FoldVector): FoldVectorResult => {
  const actual = codepoints(canonicalizeHandle(String.fromCodePoint(...vector.input)))
  return {
    vector,
    actual,
    ok: actual.length === vector.expected.length && actual.every((cp, i) => cp === vector.expected[i]),
  }
}

export const runFoldVectors = (): readonly FoldVectorResult[] => FOLD_VECTORS.map(runFoldVector)

export type FoldBucketResult = {
  readonly index: number
  readonly first: number
  readonly last: number
  readonly codePoints: number
  /** Lower-case hex SHA-256 over `(code point, folded UTF-8)` for every allowed code point in the bucket. */
  readonly digest: string
  /** `null` when the bucket is absent from {@link FOLD_SWEEP_REFERENCE}, which means the constant is stale. */
  readonly expected: string | null
  readonly ok: boolean
}

export type FoldSweep = {
  readonly buckets: readonly FoldBucketResult[]
  readonly codePoints: number
  readonly diverged: readonly FoldBucketResult[]
}

/**
 * How many digests the sweep is split into.
 *
 * ⚠️ Buckets rather than one digest per declared range: the charset is a **deny** list now, so its
 * complement is ~780 ranges and pinning a digest for each would be a 50 KB constant. One digest tells
 * you only *that* the device disagrees; 64 tell you *where*, to within a few thousand code points,
 * which is the difference between a lead and a shrug.
 */
export const FOLD_SWEEP_BUCKETS = 64

const utf8 = new TextEncoder()

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Every allowed code point, ascending. Materialised once per sweep. */
const allowedCodePoints = (): number[] => {
  const out: number[] = []
  for (const [first, last] of allowedCodePointRanges()) {
    for (let cp = first; cp <= last; cp++) out.push(cp)
  }
  return out
}

/**
 * Digest one bucket. The code point goes into the stream alongside its fold so that a shifted mapping
 * — every letter folding to its neighbour — cannot produce the same digest as the correct one.
 */
const digestBucket = (codePoints: readonly number[]): string => {
  const bytes: number[] = []
  for (const cp of codePoints) {
    const folded = utf8.encode(canonicalizeHandle(String.fromCodePoint(cp)))
    bytes.push((cp >>> 24) & 0xff, (cp >>> 16) & 0xff, (cp >>> 8) & 0xff, cp & 0xff, folded.length)
    for (const b of folded) bytes.push(b)
  }
  return hex(sha256(new Uint8Array(bytes)))
}

/**
 * SHA-256 per bucket, as this repo's Node/ICU reference produces them.
 *
 * ⚠️ Regenerated by `handle-fold-probe.test.ts`, which recomputes and asserts — so a change to the
 * charset in `@pnyx/contract-client/handle-charset` fails that test rather than silently leaving the
 * device probe comparing against a set that no longer exists.
 */
export const FOLD_SWEEP_REFERENCE: readonly string[] = [
  'e19e66bc085eac7395c38df26e17e392251262b22e09f56129f22f1527646665',
  '3f1749dac5bf4f6e507ff3ddf7cf9d0daa6b1a05bf3dc57bb6d239df01da4c3d',
  '40cb950cbfd720dcd70f6c2257e27eb14743e1297f3181b9aed926b41d877aa4',
  'a9e2f6848ddc1a65b6f272d96e930fe4d225cb5fb83110e29110a8cbe57fe540',
  'eac86bb02439a249520d424ef0fbfd2756f0886070207fbbb8820ac6fd8c45a7',
  '4acc7b7f3e963f69734940bbb53530bfb26bd26095c08a88150fd55692ee074e',
  'a8c2adbcaf9942eb2d612f0817125679369f778e9f831ad500e5578a7bf0a1e5',
  '25c5446bb72bbc9334f562973e043a9db235b5fe46cda4f2a1dcdf224431bfae',
  '638fae9edc72acaf022143f15c289ac329566e34f8fdb5f2bc2d3383602a09a2',
  '965bf1a6fc381ad92461ee39c552468f1ecacf110415e6cee080482a5b40c029',
  '460aae0632a8fde14b714e46bfaf2fe0feca0c7eefed368edb94fa6426be1488',
  '76db727cd397fe20adf79772d2a14600a8b7ed3635bac30be690417ebc82c673',
  'e3a118792bc6f22e5a66d876220b075360a883c1499aafc2ea0bb0ae16441a9a',
  'efd9be73180e5f0a60eaee8a46f9d898f9ed5dae624008025db51c1fc42004f8',
  'b11d68e7f1881c6e689bd0d4afcc45168d1ab312acc6880045bb79b3e0dd37ff',
  '0b486f92dff1f4dc02e88d62f946c287f66fffed3e04630570aa5db6f7f59861',
  '0f9eeaa30c180bd9455b2388a3edc4f9d6e6cd974bc3c1f6891c6d49664ddea1',
  '912516065979655c2f1c601db6ce02c9d57e835ed4deb143ca8f6abf501c72f9',
  'a4d33328f1e6e4993d08dd5072f7de225cf2f5a1d4b3aee5d98cd3d64113616e',
  'fee674abe18259507b52c24dc7bdbd57c17625bb13f8ca7b7c3a1b41e7f3b270',
  'f3077b2e076786b0e2edd0410246fdd36785ae4e3d5f6d27a451867d1c176504',
  '798ccdbc49e968d55929d305f8726c85c9cb982ce5730c84db82b0fc80c6a335',
  '45538bd07156e3604ef2e11afeff9df3e8ed9a97029ce3c7e487e61bcbb1cbfb',
  '8dbc91c8bb5912cd9f36969287541d9923d334bdda735da85af9955be4916104',
  '5894e169f9efd329de36ea7d2ff5694741822df3fad7eeae0f12e935226d94b9',
  '2bec8e678052f572470954d6a47f1b5451529aa14992590b1d16305f6ce97075',
  'f5450d413e28124487b5b83b31b5cb595ca1c720a45dcd514f6a88a0dbcec8ab',
  'ad2ef64395b2276bc455ab7b45eaf12396cfcc53371e737e0b28a88c1e1ad08a',
  'd36c0c4cbd3114d5d80dd79a077c4119622daa41d7df40090de4f173dcbe4340',
  '596837b700121f6e11e653c3b547e912698c41a00b91d839b562b9ac047e318c',
  'bc2742d5470610ee2d561866a4c2262b29965fb0fb76258b67c3b3129c860ec6',
  '61c990169197322569a9cfc19f8b2c57a9ec57a4275f5c67c0c4a2f2d32d4fd4',
  '8c1b444dba935ac3d8d0bde89962279b6032e03646744923f8bbe2097e214a29',
  '16b621e8fd8f8bb9521b9da86948198aeb79e6ede232b880cf07efd87c8d60cf',
  'fa2326063fc6b2d152d9953a081bc03ceaac15ae629b079733f3ab097bd4a4ed',
  '6d36734e71914adb088acb2e90c966fcab703f6b5997203eb7eb08de66d3c8a2',
  '95313aff17afb77eea4ed25ca2d1fc0adc3696dc5ec6adb26c8816b30165cb85',
  '73cb33c71324baa61ee9063ae28a0ed25788389e0ee82fcbea2054a98b807165',
  'a69f4ee4461c0c4f166c6b3840ef934fa27aae233ebaf10f5ad06faf030ab2b6',
  'a5a51f7cb0f289e46b5153d1d75f570c49d76027daf273eefcee6c995dee2b0c',
  '52387e9c74788fd2a9e2452e6317a658887393484acfc59f93d4c55c72dbd502',
  'db645c3306edafd5ac01676751c8e1c36c440176f5e29590ac62ce8c7b0f383c',
  'd986b50a9530daa88f3fe95b64bde96880a2604991e98b48d13065fc93b1e9f2',
  '7f69e126fdb1e1afd6fd17bd33c46bd029cd0fac53728e232eac486a9ec099f2',
  '5c466be45269e6dd9673e255db13704620e70b7c64ce5f7c439211ff7a4ebb87',
  'd026392b5e57dc68056a25784750b30bde18d688f4515a8bd0149f9c66c9e4fe',
  '08f193a69f95831de0054fd8f82f351f14e4ab271a53873764244d4a5ba8e3eb',
  'a4f8c880b94ec481dcb51a4bccb218a9e15cc04c58e0fde19ac0bcffee44ed3c',
  '01971f23b897bdf8998c6e9ea9a39e78249a47efe570f15a24d7a81cc4d61dbb',
  '5e582ec2cb75cf9f5ea190ce9cdcf81a67fcb0a6bcdb86fdb721a418f7d24378',
  '7b83bf4f0a4aab01559689c62e20ea43c11945437ee1519be381e75c489f17b6',
  'd9b2c570f45b9e52c209169ae95f1f8612eaf42335ac443e0783be07ef55e550',
  '89fd4691342a710f9e220c3170fbc51d433e7e06b1302b7fc1b6647cd233ed5a',
  '5e58c29343e5b3ba552d4356e790571dfa104979cc1947a1fb811a4c52a9460a',
  'f39fe9918708cf6b4af2da642b479b1d8f56000600b2159865107cb46a8ebdb7',
  'b6ac25aee69a25aac65715d0a93038b17125f3e1124af66e6c1d9f03b8c35873',
  '3fc553fe12d4270a4d13ff857e4caa9fa43f672cecaf5bb5b4ffa19043a6c62e',
  '5aa9d81764b608a17df3988a682078b282b518277b2bd5cb2c6536f88a5f769f',
  '8a19ba5943358323bbe1ad590cc1e2f33492d21b36ffb7b1f7ca4f3e7191c029',
  '7d486db446173da0436171e5fa6c13995cc495442955749ec6e43cee667fb335',
  'f716f6325fd6c5afa2290da8e331471f5318ac837aa6427ccb7a79781a56bf16',
  'b6596cca524c5295f46f4b9764e65fead076985e0cce674b7684460041659a5f',
  '520c773cef5edaeeda694f6436ba7f7b9679428d1aaadb98a7e35e11ef0e52c8',
  '5cf1c7cb4cbe178ca6463859e07ba69006f73ec67701261fb791d34995e92f57',
]

export const runFoldSweep = (): FoldSweep => {
  const all = allowedCodePoints()
  const size = Math.ceil(all.length / FOLD_SWEEP_BUCKETS)
  const buckets: FoldBucketResult[] = []
  for (let index = 0; index * size < all.length; index++) {
    const slice = all.slice(index * size, (index + 1) * size)
    const digest = digestBucket(slice)
    const expected = FOLD_SWEEP_REFERENCE[index] ?? null
    buckets.push({
      index,
      first: slice[0] as number,
      last: slice[slice.length - 1] as number,
      codePoints: slice.length,
      digest,
      expected,
      ok: expected === digest,
    })
  }
  return {buckets, codePoints: all.length, diverged: buckets.filter((b) => !b.ok)}
}

/**
 * `'ok'` — vectors and every range match. `'ascii-only'` — the runtime folds ASCII and leaves
 * everything else alone, i.e. a Unicode-less build. `'diverges'` — it has case data and disagrees.
 *
 * The three have different fixes, which is why they are distinguished: an ASCII-only fold means we
 * ship our own case table before a non-ASCII handle can be claimed anywhere, while a divergence means
 * finding which code points moved and deciding whose answer is canonical.
 */
export type FoldVerdict = 'ok' | 'ascii-only' | 'diverges'

export const foldVerdict = (results: readonly FoldVectorResult[], sweep: FoldSweep): FoldVerdict => {
  if (results.every((r) => r.ok) && sweep.diverged.length === 0) return 'ok'
  const failed = results.filter((r) => !r.ok)
  const allPassThrough = failed.every(
    (r) =>
      r.vector.input.some((cp) => cp > 0x7f) &&
      r.actual.length === r.vector.input.length &&
      r.actual.every((cp, i) => cp === r.vector.input[i]),
  )
  return failed.length > 0 && allPassThrough ? 'ascii-only' : 'diverges'
}
