/**
 * Field elements, and the two conversions the generated drivers lean on hardest.
 *
 * ⚠️ **These are pure JS on purpose.** `bigIntToValue` / `valueToBigInt` are WASM in the upstream
 * runtime, but the encoding is just **little-endian bytes with trailing zeros trimmed** — measured
 * against the real module rather than assumed (`0n` → empty, `256n` → `0001`, `2^64` →
 * `000000000000000001`). Keeping them in JS takes two round trips per descriptor conversion off the
 * bridge, and `compact-hermes.test.ts` pins them against the upstream module in Node.
 *
 * @module
 */

/** The BLS12-381 scalar field modulus minus one — `ocrt.maxField()`, a property of the curve. */
export const MAX_FIELD = 52435875175126190479447740508185965837690552500527637822603658699938581184512n

const FIELD_MODULUS = MAX_FIELD + 1n

/** A `bigint` as the runtime's `Value`: one atom, little-endian, trailing zeros trimmed. */
export const bigIntToValue = (x: bigint): Uint8Array[] => {
  if (x < 0n) throw new Error('a field element is not negative')
  const bytes: number[] = []
  let rest = x
  while (rest > 0n) {
    bytes.push(Number(rest & 0xffn))
    rest >>= 8n
  }
  return [new Uint8Array(bytes)]
}

export const valueToBigInt = (value: Uint8Array[]): bigint => {
  const atom = value[0] ?? new Uint8Array(0)
  let out = 0n
  for (let i = atom.length - 1; i >= 0; i--) out = (out << 8n) | BigInt(atom[i] ?? 0)
  return out
}

/** Hex for the bridge — the same little-endian, trailing-trimmed form. */
export const fieldToHex = (x: bigint): string => bytesToHex(bigIntToValue(x)[0] ?? new Uint8Array(0))

export const hexToField = (hex: string): bigint => valueToBigInt([hexToBytes(hex)])

export const bytesToHex = (b: Uint8Array): string => {
  let out = ''
  for (const byte of b) out += byte.toString(16).padStart(2, '0')
  return out
}

export const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Field arithmetic — pure BigInt upstream too, so these are copied rather than bridged.
 * Inputs are assumed to be in `[0, FIELD_MODULUS)`, which is the same contract upstream states.
 */
export const addField = (x: bigint, y: bigint): bigint => {
  const t = x + y
  return t < FIELD_MODULUS ? t : t - FIELD_MODULUS
}

export const subField = (x: bigint, y: bigint): bigint => {
  const t = x - y
  return t >= 0n ? t : t + FIELD_MODULUS
}

export const mulField = (x: bigint, y: bigint): bigint => (x * y) % FIELD_MODULUS
