/**
 * DRep target canonicalization. Delegation targets arrive in four spellings —
 * CIP-129 ids (`drep1…`, 29-byte header‖hash), legacy CIP-105 ids (`drep1…` /
 * `drep_script1…`, bare 28-byte hash), Koios literals
 * (`drep_always_abstain` / `drep_always_no_confidence`), and user paste of any
 * of the above — and "already delegated to this DRep" detection is only correct
 * on the canonical form. CIP-105 and CIP-129 share the `drep` hrp, so matching
 * on the raw string silently fails across the two encodings.
 *
 * @module
 */

import {Cip129} from '@evolution-sdk/cips'
import {bech32} from '@pnyx/crypto'
import {logger} from '../../logger'
import {bytesToHex} from './http'

export type DRepTarget =
  | {readonly kind: 'abstain'}
  | {readonly kind: 'no_confidence'}
  | {readonly kind: 'key' | 'script'; readonly hashHex: string}

const ABSTAIN_LITERALS = new Set(['drep_always_abstain', 'always_abstain', 'abstain'])
const NO_CONFIDENCE_LITERALS = new Set([
  'drep_always_no_confidence',
  'always_no_confidence',
  'no_confidence',
  'no-confidence',
])

/** CIP-105 legacy id: bare 28-byte hash under `drep` / `drep_script`. */
const parseCip105 = (s: string): DRepTarget | null => {
  let prefix: string
  let bytes: Uint8Array
  try {
    const decoded = bech32.decode(s as `${string}1${string}`, 1023)
    prefix = decoded.prefix
    bytes = bech32.fromWords(decoded.words)
  } catch (e: unknown) {
    logger.debug('DRep id failed bech32 decode', {origin: 'drep-id', error: String(e)})
    return null
  }
  if (bytes.length !== 28) return null
  if (prefix === 'drep') return {kind: 'key', hashHex: bytesToHex(bytes)}
  if (prefix === 'drep_script') return {kind: 'script', hashHex: bytesToHex(bytes)}
  return null
}

/**
 * Parse any DRep target spelling to its canonical form. Returns `null` for
 * anything unparseable — never a guessed target.
 */
export const parseDRepTarget = (raw: string): DRepTarget | null => {
  const s = raw.toLowerCase()
  if (ABSTAIN_LITERALS.has(s)) return {kind: 'abstain'}
  if (NO_CONFIDENCE_LITERALS.has(s)) return {kind: 'no_confidence'}

  const cip129 = Cip129.parseCredential(raw)
  if (cip129 !== undefined) {
    if (cip129.keyType !== 'drep') return null
    return {kind: cip129.isScript ? 'script' : 'key', hashHex: bytesToHex(cip129.hash)}
  }
  return parseCip105(raw)
}

/** Canonical equality across all spellings. */
export const drepTargetsMatch = (a: DRepTarget | null, b: DRepTarget | null): boolean => {
  if (a === null || b === null) return false
  if (a.kind !== b.kind) return false
  return a.kind === 'key' || a.kind === 'script' ? a.hashHex === (b as {hashHex: string}).hashHex : true
}

const hexToBytesLocal = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** CIP-129 bech32 id for a key/script target; `null` for the system targets
 * (abstain / no-confidence have no on-chain id). */
export const drepTargetBech32 = (target: DRepTarget): string | null =>
  target.kind === 'key' || target.kind === 'script'
    ? Cip129.drepBech32(hexToBytesLocal(target.hashHex), target.kind === 'script')
    : null
