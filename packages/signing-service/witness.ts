/**
 * Pure witness bookkeeping: dedup by verification key and coverage checks
 * against a tx's required key hashes.
 *
 * @module
 */

import type {Tx} from '@pnyx/cardano-core'

type VkeyWitnessHex = Tx.VkeyWitnessHex

/** Drop duplicate witnesses (same vkey), keeping first occurrence order. */
export const dedupeWitnesses = (witnesses: readonly VkeyWitnessHex[]): readonly VkeyWitnessHex[] => {
  const seen = new Set<string>()
  const out: VkeyWitnessHex[] = []
  for (const w of witnesses) {
    if (seen.has(w.vkeyHex)) continue
    seen.add(w.vkeyHex)
    out.push(w)
  }
  return out
}

/**
 * Required key hashes not covered by the given witness key hashes. Order of
 * `required` is preserved; comparison is case-insensitive hex.
 */
export const missingKeyHashes = (
  witnessKeyHashes: readonly string[],
  required: readonly string[],
): readonly string[] => {
  const have = new Set(witnessKeyHashes.map((h) => h.toLowerCase()))
  const out: string[] = []
  for (const r of required) {
    const key = r.toLowerCase()
    if (!have.has(key) && !out.includes(key)) out.push(key)
  }
  return out
}

const HARDENED = 0x80000000

/**
 * Parse a BIP-32 path string (`m/1852'/1815'/0'/0/0`, `'` or `h` hardened)
 * into component numbers. Throws on malformed input.
 */
export const parsePath = (path: string): readonly number[] => {
  const trimmed = path.startsWith('m/') ? path.slice(2) : path
  if (trimmed.length === 0) throw new Error(`empty derivation path: ${path}`)
  return trimmed.split('/').map((part) => {
    const hardened = part.endsWith("'") || part.endsWith('h')
    const digits = hardened ? part.slice(0, -1) : part
    if (!/^\d+$/.test(digits)) throw new Error(`malformed derivation path component "${part}" in ${path}`)
    const value = Number(digits)
    if (value >= HARDENED) throw new Error(`derivation index out of range in ${path}`)
    return hardened ? (value | HARDENED) >>> 0 : value
  })
}
