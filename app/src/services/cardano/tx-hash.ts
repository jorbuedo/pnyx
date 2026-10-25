/**
 * What counts as a Cardano transaction id.
 *
 * A tx id is a 32-byte blake2b hash, so exactly 64 hex characters. The rule lives
 * here rather than in a screen because two callers need it: the lookup field that
 * gates its own button, and the link classifier, which must refuse a hash it
 * cannot open — a card offering to show a transaction that will 404 is a card
 * promising something that does not happen.
 *
 * @module
 */

const TX_HASH_RE = /^[0-9a-f]{64}$/

/** True for a 64-character hex tx id. Case-insensitive; callers store lowercase. */
export const isTxHash = (value: string): boolean => TX_HASH_RE.test(value.trim().toLowerCase())

/** The canonical (lowercase, trimmed) form, or `null` when it is not a tx id. */
export const txHashOf = (value: string): string | null => {
  const hash = value.trim().toLowerCase()
  return TX_HASH_RE.test(hash) ? hash : null
}
