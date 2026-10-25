/**
 * Scrub secret-shaped values before a log entry can leave the process.
 *
 * Phase 16 item 44: with native custody rejected (item 42), *accidental*
 * exfiltration — a log line, an error `cause` chain, a Sentry breadcrumb, a
 * crash-report attachment — is what actually carries the key-material risk. It
 * is a control, not hygiene, which is why it lives at a chokepoint and is
 * covered by a test that fails when a secret reaches a transport rather than by
 * a reviewer's attention.
 *
 * ### Two mechanisms, and why not a third
 *
 * 1. **Key names** ({@link SECRET_KEY_PATTERN}) — the primary rule. Precise and
 *    predictable: a value under `mnemonic`, `xprv`, `password`… never reaches a
 *    transport.
 * 2. **Mnemonic shape** ({@link looksLikeMnemonic}) — belt and braces, for a
 *    phrase that lands under an innocuous key or inside an error message. The
 *    crown jewel is worth a second net.
 *
 * **Deliberately not a third: redacting long hex strings.** It would fire on
 * transaction CBOR, bodies, witness sets, addresses and hashes — exactly the
 * values this app debugs with. Reading the node's own words off a rejected
 * submission is what turned a day of guessing into a root cause on
 * 2026-07-28; a redactor that hid them would be a net loss. Hex secrets are
 * caught by key name instead, which is why the key list includes the
 * hex-carrying ones (`xprv`, `roleKey`, `personaSk`).
 *
 * ### What this does not do
 *
 * It is not a boundary. A caller that stringifies a mnemonic into a message
 * body under a name this does not recognise will still leak, and no amount of
 * pattern matching fixes that. It removes the accidental and the casual cases;
 * the durable control is not logging secrets in the first place.
 *
 * @module
 */

import type {LogMessage, LogMetadata} from './types.js'

/** Replacement text. Deliberately conspicuous — a redaction should be visible, not silent. */
export const REDACTED = '[redacted]'

/**
 * Keys whose values never reach a transport.
 *
 * Matched case-insensitively as a substring, so `walletMnemonic`,
 * `mnemonic_phrase` and `MNEMONIC` are all covered. Additions are cheap; the
 * cost of a miss is a seed in a crash report.
 */
export const SECRET_KEY_PATTERN =
  /mnemonic|passphrase|password|recovery.?phrase|seed(?!ed)|entropy|xprv|privatekey|private.?key|secretkey|secret.?key|signingkey|signing.?key|rolekey|role.?key|personask|persona.?sk|gatesecret|gate.?secret|ballotrand|witnesssecret|\bwif\b/i

/** Guards against a cyclic or pathologically deep metadata object — a real bug class here. */
const MAX_DEPTH = 8

const WORD_COUNTS = new Set([12, 15, 18, 21, 24])

/**
 * True when a string has the shape of a BIP-39 mnemonic.
 *
 * Tight on purpose, because a false positive silently destroys a log line. Two
 * discriminators do the work:
 *
 * - the word count is exactly one BIP-39 length (12 / 15 / 18 / 21 / 24);
 * - **every** word is 3–8 lowercase letters, which is the BIP-39 wordlist's
 *   range. English prose fails this almost immediately — it is full of one- and
 *   two-letter words (`a`, `to`, `is`, `of`), and any capital or punctuation
 *   rejects it outright.
 *
 * Residual, stated rather than hidden: a 12-word phrase whose words all happen
 * to be 3–8 lowercase letters and which is *not* a mnemonic will be redacted.
 * That is the right side of the trade.
 */
export const looksLikeMnemonic = (value: string): boolean => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  const words = trimmed.split(' ')
  if (!WORD_COUNTS.has(words.length)) return false
  return words.every((word) => /^[a-z]{3,8}$/.test(word))
}

const redactString = (value: string): string => (looksLikeMnemonic(value) ? REDACTED : value)

/**
 * Serialize an `Error` for logging with its `cause` chain redacted.
 *
 * The chain is explicitly in scope: item 44 names "no secrets through error
 * `cause` chains that get serialized", and a `VaultError` riding along as
 * `cause` is a real pattern in this codebase.
 */
const redactError = (error: Error, depth: number): Record<string, unknown> => ({
  name: error.name,
  message: redactString(error.message),
  ...(error.cause === undefined ? {} : {cause: redactValue(error.cause, depth + 1)}),
})

const redactValue = (value: unknown, depth: number): unknown => {
  if (depth > MAX_DEPTH) return '[truncated]'
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return redactError(value, depth)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1))
  return redactRecord(value as Record<string, unknown>, depth)
}

const redactRecord = (record: Record<string, unknown>, depth: number): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    // ⚠️ **A boolean carries no secret, and redacting one destroys a diagnostic.** The pattern
    // matches as a substring, so `hasMnemonic` — a value a caller deliberately coerced with
    // `Boolean(...)` precisely so nothing sensitive could reach a transport — was being replaced by
    // `[redacted]`. That hid the single bit needed to tell "the phrase never arrived" from "the
    // phrase arrived and creation failed", which is exactly what such a field exists to answer.
    const redactable = typeof value !== 'boolean'
    out[key] = redactable && SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(value, depth + 1)
  }
  return out
}

/** Redact a metadata object. Returns a new object; the caller's is untouched. */
export const redactMetadata = (metadata: LogMetadata): LogMetadata =>
  redactRecord(metadata as Record<string, unknown>, 0) as LogMetadata

/**
 * Redact a log message.
 *
 * An `Error` stays an `Error` so transports that special-case it (stack
 * capture, Sentry's exception grouping) keep working — only its message is
 * scrubbed, and only when it has mnemonic shape.
 */
export const redactLogMessage = (message: LogMessage): LogMessage => {
  if (typeof message === 'string') return redactString(message)
  if (message instanceof Error && looksLikeMnemonic(message.message)) {
    const scrubbed = new Error(REDACTED)
    scrubbed.name = message.name
    // `stack` is optional under exactOptionalPropertyTypes; only carry it when the
    // original had one, so a stackless error stays stackless rather than gaining
    // an `undefined` property that transports would serialize.
    if (message.stack !== undefined) scrubbed.stack = message.stack
    return scrubbed
  }
  return message
}
