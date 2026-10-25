/**
 * Read the reason out of a signing-ceremony failure.
 *
 * Every error on that path carries its cause as a `reason` string —
 * `SigningBroadcastError` holds the node's own rejection text — but a multi-leg
 * ceremony wraps it in `SigningSequenceError`, whose `message` is empty because
 * `Data.TaggedError` only populates `message` when the payload has one. So a
 * caller that reads `String(error)` or `error.message` gets nothing, which is
 * how a node rejection reached the user as an unqualified "Transaction failed".
 *
 * @module
 */

import {logger} from '../../logger'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null

/**
 * The innermost reason a ceremony failed, or `null` when the error carries none.
 *
 * Never invents text: an error shape this does not recognise reads as `null` so
 * callers keep their own generic wording rather than showing `[object Object]`.
 */
export const ceremonyFailureReason = (error: unknown): string | null => {
  const record = asRecord(error)
  if (record === null) return null
  // A sequence error's `failure` is the one that actually happened.
  const inner = asRecord(record.failure)
  if (inner !== null) {
    const nested = ceremonyFailureReason(inner)
    if (nested !== null) return nested
  }
  const reason = nonEmpty(record.reason)
  // A node rejection arrives as `submit rejected (400): <json>`. The sentence
  // inside is what a person can act on; the envelope around it is not.
  if (reason !== null) return submitRejectionReason(reason) ?? reason
  // `SigningWitnessError` reports the coverage gap instead of a reason.
  const missing = record.missingKeyHashes
  if (Array.isArray(missing) && missing.length > 0) return `missing signatures: ${missing.join(', ')}`
  const message = nonEmpty(record.message)
  return message === null ? null : (submitRejectionReason(message) ?? message)
}

/**
 * Which step of the ceremony failed, so the surface can name it correctly.
 *
 * ⚠️ **Because "the network rejected this transaction" was shown for all of
 * them.** A BLE Trezor the app failed to reach produced *"The network rejected
 * this transaction: Failed to create Trezor transport: No Trezor devices
 * found"* — a sentence about a transaction that was never built, let alone
 * submitted, and it is what a real bug report (2026-10-07) described as the
 * send having been rejected. A user declining on the device got the same
 * wording, which blames the network for the user's own choice.
 *
 * `'other'` for a shape this does not recognise, so the caller keeps neutral
 * wording rather than attributing the failure to a step it cannot confirm.
 */
export type CeremonyFailureStage = 'broadcast' | 'device' | 'declined' | 'locked' | 'other'

export const ceremonyFailureStage = (error: unknown): CeremonyFailureStage => {
  const record = asRecord(error)
  if (record === null) return 'other'
  // A sequence error's `failure` is the one that actually happened; the wrapper
  // has no stage of its own.
  const inner = asRecord(record.failure)
  if (inner !== null) return ceremonyFailureStage(inner)
  if (record._tag === 'SigningBroadcastError') return 'broadcast'
  if (record._tag === 'SigningDeviceError') {
    // `'locked'` before `'device'`: both are device failures, but only one of them the user can
    // clear by picking the thing up, so it gets its own wording instead of "the device failed".
    if (record.deviceLocked === true) return 'locked'
    return record.userRejected === true ? 'declined' : 'device'
  }
  return 'other'
}

/**
 * The node's own sentence, pulled out of a submit rejection.
 *
 * `submitTx` reports a rejection as `submit rejected (400): <body>`, and the
 * body is the submit API's nested error JSON. Shown raw that is a wall of tags
 * and braces the toast truncates mid-token — technically the reason, and
 * unreadable, which is the same as having none.
 *
 * The one part written for a person is the `error` array, several levels down:
 *
 *   {"contents":{"contents":{"contents":{"era":…,"error":[
 *     "ConwayMempoolFailure \"All inputs are spent. …\""],…
 *
 * Found by searching for that key at any depth rather than by walking a fixed
 * path, because the nesting differs by era and by which validation stage
 * refused. Entries are unwrapped from their `SomeFailure "…"` constructor when
 * they have one; a constructor with no quoted text is kept as-is, since the tag
 * is then the whole message.
 *
 * `null` when this is not a submit rejection or carries no readable error —
 * never a guess, so the caller keeps its own wording.
 */
export const submitRejectionReason = (raw: string): string | null => {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start))
  } catch (e: unknown) {
    // This is the reader that turns a node's rejection into something a person can act on, so
    // a body it cannot parse means the user is told a submit failed and not why.
    logger.warn('Submit failure body could not be parsed; the reason cannot be reported', {
      origin: 'cardano/submit-failure',
      error: String(e),
    })
    return null
  }
  const errors = findErrorStrings(parsed)
  if (errors.length === 0) return null
  return errors.map(unwrapFailure).join('; ')
}

/** Every string in an `error` array, at any depth. */
const findErrorStrings = (node: unknown): readonly string[] => {
  const record = asRecord(node)
  if (record === null) return []
  const own = Array.isArray(record.error) ? record.error.filter((e): e is string => typeof e === 'string') : []
  if (own.length > 0) return own
  for (const value of Object.values(record)) {
    const nested = findErrorStrings(value)
    if (nested.length > 0) return nested
  }
  return []
}

/**
 * `ConwayMempoolFailure "All inputs are spent."` → `All inputs are spent.`
 *
 * Only when the constructor wraps one quoted string and nothing else. A nested
 * failure like `ConwayUtxowFailure (MissingScriptWitnessesUTXOW (… [ScriptHash
 * "73e4…"]))` also contains a quoted token, and taking it would answer a
 * question about missing witnesses with a bare hash — the structure around it
 * is the meaning, so those are kept whole.
 */
const unwrapFailure = (entry: string): string => {
  const plutus = plutusFailureReason(entry)
  if (plutus !== null) return plutus
  const whole = entry.match(/^[A-Za-z0-9_]+\s+"((?:[^"\\]|\\.)*)"$/)
  return whole?.[1] === undefined ? entry : whole[1].replace(/\\"/g, '"')
}

/**
 * A script failure, condensed to the three facts a person can act on.
 *
 * ⚠️ **Because this entry is tens of kilobytes and every other rejection is a sentence.** A
 * `PlutusFailure` carries the whole base64 script, the whole `TxInfo` dump and the redeemer blob inside
 * one `error` string, so the generic path above hands all of it to a one-line red callout — which is
 * "technically the reason, and unreadable, which is the same as having none", the same defect this module
 * was written for, one layer down. Observed 2026-08-28 on a real mainnet rejection: ~40 KB in a Callout.
 *
 * What survives is the script hash (which script), the evaluation error (why), and the cause line when
 * there is one. What is dropped is only ever *bulk* — nothing here is a summary of something that had
 * meaning. The full text is still available to copy; see `ScriptFailureCallout`.
 *
 * `null` when the entry is not a script failure, so the caller keeps its own handling.
 */
/** How the ledger names each script purpose, in the words the rest of the app uses. */
const PURPOSE: Readonly<Record<string, string | undefined>> = {
  Spending: 'spend',
  Minting: 'mint',
  Certifying: 'certificate',
  Rewarding: 'withdrawal',
  Voting: 'vote',
  Proposing: 'proposal',
}

/**
 * The whole rejection, unescaped, for a person to copy.
 *
 * ⚠️ **Because a condensed reason is not a diagnosis.** The summary names which script refused and why,
 * which is what belongs on screen; pinning *which check* failed needs the `TxInfo` dump, the datums and
 * the redeemer — tens of kilobytes that cannot be read in a callout and must not be thrown away either.
 * So the callout carries the summary and this carries the rest, behind a copy action.
 *
 * Only the doubled JSON escaping is undone — no reordering, no truncation, nothing dropped. A detail
 * this returns is a detail the node sent.
 */
/**
 * The node's own text, before any condensing — what a copy action hands over.
 *
 * Walks the same `reason` / `failure` / `message` chain {@link ceremonyFailureReason} does and stops at
 * the first string, *without* summarising it. `null` when the error carries no text, so a caller can tell
 * "nothing more to give" from "the same thing again".
 */
export const rawFailureText = (error: unknown): string | null => {
  const record = asRecord(error)
  if (record === null) return null
  const inner = asRecord(record.failure)
  if (inner !== null) {
    const nested = rawFailureText(inner)
    if (nested !== null) return nested
  }
  return nonEmpty(record.reason) ?? nonEmpty(record.message)
}

export const submitFailureDetail = (raw: string): string =>
  raw.replace(/\\+n/g, '\n').replace(/\\+"/g, '"').replace(/\\\\/g, '\\')

export const plutusFailureReason = (entry: string): string | null => {
  if (!entry.includes('PlutusFailure')) return null
  // The strings are doubly escaped by the time they arrive (JSON inside JSON), so both forms appear.
  const unescaped = entry.replace(/\\+n/g, '\n').replace(/\\+"/g, '"')
  const version = unescaped.match(/The (Plutus[A-Za-z0-9]*) script failed/)?.[1] ?? 'Plutus'
  const hash = unescaped.match(/ScriptHash\s+"?([0-9a-fA-F]{56})"?/)?.[1]
  /**
   * Which handler refused, from `ScriptInfo`.
   *
   * ⚠️ Load-bearing on a multi-purpose validator, where one script hash serves the mint and the spend:
   * "the mint refused" and "the spend refused" send you to different code, and the hash alone says
   * neither.
   */
  const purpose = PURPOSE[unescaped.match(/ScriptInfo:\s*([A-Za-z]+)Script/)?.[1] ?? '']
  /**
   * The evaluation reason.
   *
   * ⚠️ **`Caused by: error` is not the reason** — it is the name of the builtin that raised, and taking
   * it produced "caused by: error", which says nothing. The sentence after `CekError` is the one written
   * for a person, so it is preferred; a `Caused by:` that is more than the bare word is appended.
   */
  const machine = unescaped.match(/(The machine terminated because of[^\n]+)/)?.[1]?.trim()
  const evaluation = unescaped.match(/The plutus evaluation error is:\s*([^\n]+)/)?.[1]?.trim()
  const causedBy = unescaped.match(/Caused by:\s*([^\n]+)/)?.[1]?.trim()
  const which = hash === undefined ? `a ${version} script` : `the ${version} script ${hash.slice(0, 12)}…`
  const doing = purpose === undefined ? 'refused this transaction' : `refused this ${purpose}`
  const why = machine ?? evaluation ?? 'the node gave no evaluation error'
  const cause = causedBy === undefined || causedBy === 'error' ? '' : ` Caused by: ${causedBy}`
  return `${which} ${doing} — ${why}${cause}`
}
