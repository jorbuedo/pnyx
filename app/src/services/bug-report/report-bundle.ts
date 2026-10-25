/**
 * Assemble a bug report, and decide what fits.
 *
 * Pure — no React, no filesystem, no network — so the size rules and the redaction
 * boundary are things a test pins rather than things the screen happens to do.
 *
 * ## Why the log trail is safe to ship, and where that stops
 *
 * `logger.trail` is scrubbed at the logger's own chokepoint (`packages/logger/redact.ts`),
 * before an entry can reach any transport *or* the trail — that module's header calls the
 * trail an exfiltration surface for exactly this reason. So the trail carried here has
 * already had mnemonic- and key-shaped values replaced. That is a control against the
 * accidental case, not a boundary: a caller that formats a secret into a message under a
 * name the redactor does not know still leaks, and no amount of work here fixes that.
 *
 * ⚠️ **The user's own description is not scrubbed and must not be.** It is prose they chose
 * to send; running a secret-shaped matcher over it would mangle legitimate text (an address,
 * a tx hash, a policy id — the values this app is debugged with) while doing nothing about a
 * determined paste. What protects them is that they typed it knowingly.
 *
 * @module
 */

import type {LogEntry} from '@pnyx/logger'
import Constants from 'expo-constants'
import {Platform} from 'react-native'

/**
 * The logger's trail capacity, mirrored so a manifest can say whether it was truncated.
 *
 * ⚠️ Must track `DEFAULT_TRAIL_MAX_SIZE` in `packages/logger/logger.ts`. It is not exported
 * there, and importing the logger module here would pull its transports into a pure module; the
 * cost of the copy is one stale number, and what it buys is `logsTruncated` meaning anything at
 * all. `report-bundle.test.ts` takes the capacity as a parameter so the rule stays testable
 * independently of this constant's value.
 */
export const LOG_TRAIL_CAPACITY = 1000

/** Hard ceiling on one report's uploaded body. The worker enforces the same number. */
export const MAX_REPORT_BYTES = 8 * 1024 * 1024

/**
 * Ceiling on the attachments alone, leaving room for the logs.
 *
 * ⚠️ **Logs are the part that cannot be dropped.** They are why a report is worth having,
 * and the user cannot judge their size — so attachments, which the user *chose* and can
 * reconsider, yield first. Sizing them against the whole budget instead would let five
 * screenshots silently squeeze out the diagnostic payload.
 */
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024

/** Ceiling on any single attachment, so one large video cannot consume the whole budget. */
export const MAX_SINGLE_ATTACHMENT_BYTES = 4 * 1024 * 1024

/** How many attachments one report may carry. */
export const MAX_ATTACHMENTS = 5

/** Longest description we accept. Generous — the cost of prose is nil next to a screenshot. */
export const MAX_DESCRIPTION_CHARS = 4000

export type ReportAttachment = {
  readonly name: string
  /** MIME type as the picker reported it, or `null` when it did not. Never guessed. */
  readonly mimeType: string | null
  readonly sizeBytes: number
  /** Local URI to read at upload time. Contents are not held here. */
  readonly uri: string
}

/** Why an attachment was refused. Each maps to its own message — "too big" is not one error. */
export type AttachmentRejection = 'too-many' | 'single-too-large' | 'would-exceed-budget' | 'unknown-size'

export type AttachmentDecision = {
  readonly accepted: readonly ReportAttachment[]
  readonly rejected: readonly {readonly attachment: ReportAttachment; readonly reason: AttachmentRejection}[]
  readonly acceptedBytes: number
}

/**
 * Decide which of `incoming` may join `existing`, in order.
 *
 * Order matters and is the caller's: a user adding files one at a time expects the first to
 * survive and the last to be refused, not a re-shuffle that drops something they already saw
 * accepted. Each rejection carries its own reason so the screen can say which rule bit —
 * "too many" and "too large" call for different actions.
 *
 * A file whose size the picker could not report is refused rather than assumed small. An
 * unknown size that turns out to be 40 MB is a failed upload after the user has waited.
 */
export const decideAttachments = (
  existing: readonly ReportAttachment[],
  incoming: readonly ReportAttachment[],
): AttachmentDecision => {
  const accepted = [...existing]
  const rejected: {attachment: ReportAttachment; reason: AttachmentRejection}[] = []
  let bytes = existing.reduce((sum, a) => sum + a.sizeBytes, 0)

  for (const attachment of incoming) {
    if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes < 0) {
      rejected.push({attachment, reason: 'unknown-size'})
      continue
    }
    if (accepted.length >= MAX_ATTACHMENTS) {
      rejected.push({attachment, reason: 'too-many'})
      continue
    }
    if (attachment.sizeBytes > MAX_SINGLE_ATTACHMENT_BYTES) {
      rejected.push({attachment, reason: 'single-too-large'})
      continue
    }
    if (bytes + attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
      rejected.push({attachment, reason: 'would-exceed-budget'})
      continue
    }
    accepted.push(attachment)
    bytes += attachment.sizeBytes
  }

  return {accepted, rejected, acceptedBytes: bytes}
}

/** Environment facts worth having on every report, gathered by the caller that can read them. */
export type ReportContext = {
  readonly appVersion: string
  /**
   * `dev` | `preview` | `prod` — the normalised environment `app.config.js` exposes as
   * `extra.appEnv`.
   *
   * ⚠️ Read `appEnv`, **not** `buildVariant`. `extra` exports `appEnv` and `isDevelopment` and
   * has never exported `buildVariant` — the first version of this read it anyway and every
   * report from the device came back `unknown-variant`, which is a fallback firing rather than a
   * build we could not identify.
   */
  readonly appEnv: string
  readonly platform: string
  readonly osVersion: string
  readonly network: string
  /** The reporter's identity, when signed in. `null` is a real state, not a blank. */
  readonly identity: string | null
  /** Wall-clock at composition, passed in so this module stays pure and testable. */
  readonly createdAtIso: string
}

/**
 * One attachment as it is stored — metadata plus its bytes.
 *
 * ⚠️ `content` was missing entirely until 2026-09-10. The manifest recorded name, type and size
 * and nothing read the file, so every attachment arrived as a description of a file that was
 * never sent — while the screen showed it accepted and two comments in this feature claimed the
 * bytes rode along as base64. The first real one (a 177 KB screenshot, report `1ebc5ac0`) is how
 * it was found.
 */
export type ReportManifestAttachment = {
  readonly name: string
  readonly mimeType: string | null
  readonly sizeBytes: number
  /** Base64 of the file. `null` only when the read failed — never when it was skipped. */
  readonly content: string | null
  /** Why `content` is null, so an absent file is never confused with an empty one. */
  readonly readError: string | null
}

/** The JSON document, attachments included. */
export type ReportManifest = {
  readonly schema: 1
  readonly description: string
  readonly context: ReportContext
  readonly logs: readonly LogEntry[]
  readonly attachments: readonly ReportManifestAttachment[]
  /** Entries the trail had already discarded, when we can tell. */
  readonly logsTruncated: boolean
}

/**
 * Build the manifest.
 *
 * `logs` is passed in rather than read from the module-level logger so a test can supply a
 * trail, and so the caller decides *when* the snapshot is taken — a trail read after the
 * upload starts would include the upload's own lines.
 */
export const buildReportManifest = (params: {
  readonly description: string
  readonly context: ReportContext
  readonly logs: readonly LogEntry[]
  /**
   * Attachments **with their bytes already read** — see {@link readAttachmentContents}.
   *
   * ⚠️ This took `ReportAttachment` (which carries a `uri` and no content) and mapped it to the
   * metadata triple, which is how attachments shipped as descriptions of themselves. Taking the
   * read result instead makes the omission unspellable rather than merely fixed.
   */
  readonly attachments: readonly ReportManifestAttachment[]
  /** The trail's capacity, so a full trail can be reported as "older lines are gone". */
  readonly trailCapacity: number
}): ReportManifest => ({
  schema: 1,
  description: params.description,
  context: params.context,
  logs: params.logs,
  attachments: params.attachments,
  // A trail at capacity has been dropping its oldest entry per line since it filled, so the
  // report does not begin where the session did. Saying so is the difference between a
  // reader trusting the first line as the start and knowing to distrust it.
  logsTruncated: params.logs.length >= params.trailCapacity,
})

/**
 * The environment facts, read from the platform.
 *
 * Impure by necessity — it reads `Constants` and `Platform` — and kept at the bottom so
 * everything above it stays a pure function a test can drive. `network` comes from the caller
 * because the config provider owns it.
 */
export const reportContextNow = (params: {
  readonly network: string
  /**
   * The signed-in identity, or `null`.
   *
   * ⚠️ Taken from the caller rather than defaulted here. The first version hardcoded `null` with
   * a comment saying the caller would fill it, and no caller ever did — so every report from the
   * device arrived unattributable beyond its signing address. A parameter cannot be forgotten
   * the way a comment can.
   */
  readonly identity: string | null
}): ReportContext => ({
  appVersion: Constants.expoConfig?.version ?? 'unknown-version',
  // `unknown-env` rather than an empty string: a report whose build we cannot identify must say
  // so, because "" reads as a field somebody forgot to fill in.
  appEnv: (Constants.expoConfig?.extra?.appEnv as string | undefined) ?? 'unknown-env',
  platform: Platform.OS,
  osVersion: String(Platform.Version),
  network: params.network,
  identity: params.identity,
  createdAtIso: new Date().toISOString(),
})

/** Whether a description is substantial enough to be worth a reader's time. */
export const descriptionIsSubmittable = (description: string): boolean => {
  // Not trimmed for storage — only measured. What the user typed is what gets filed; this
  // asks whether they typed anything at all, and whitespace is not anything.
  const meaningful = description.trim()
  return meaningful.length > 0 && description.length <= MAX_DESCRIPTION_CHARS
}
