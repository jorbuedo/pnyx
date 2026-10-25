/**
 * Transaction metadata for display.
 *
 * Metadata is `label → arbitrary JSON`, and the review rendered it with
 * `String(value)` — so anything that was not already a string arrived on screen as
 * `[object Object]`. The common case is CIP-20 (label `674`), whose value is
 * `{msg: [...]}`: a human message the sender wrote, which is exactly the part worth
 * reading (`{"674":{"msg":["Dexhunter Trade","Partner VESPRDAPPBROWSER"]}}`).
 *
 * Pure — no React, no i18n; the caller owns labels.
 *
 * @module
 */

/** CIP-20 transaction message. */
import {logger} from '../../../logger'

const CIP20_LABEL = '674'

export type MetadataEntry = {
  /** Labels this entry was assembled from, when a value was split across several. */
  readonly joinedLabels?: readonly string[]
  /** True when the assembled value parses as hex bytes (so it can be called data). */
  readonly isHex?: boolean
  /** The metadata label as it appears on chain, e.g. `"674"`. */
  readonly key: string
  /** True for a CIP-20 message, which the UI titles rather than showing a number. */
  readonly isMessage: boolean
  /** Lines to render, in order. Never empty (an entry with nothing to show is dropped). */
  readonly lines: readonly string[]
}

const asLines = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(asLines)
  if (value === null || value === undefined) return []
  try {
    // Pretty rather than compact: metadata is read, not parsed, by whoever opens it.
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2).split('\n')
  } catch (e: unknown) {
    // No lines renders as a metadata entry with no content, which is a thing real metadata does.
    logger.warn('Metadata value could not be rendered; the entry shows nothing', {
      origin: 'metadata/entries',
      error: String(e),
    })
    return []
  }
}

/**
 * CIP-20's `msg` array is used for two different things, and the standard does not
 * distinguish them: a long message *split* across entries because a metadata
 * string cannot exceed 64 bytes, and genuinely separate lines (a real payload:
 * `["Dexhunter Trade", "Partner VESPRDAPPBROWSER"]`).
 *
 * Rendering every entry as its own line breaks a split message mid-word; joining
 * them all glues distinct lines together. So infer: an encoder only splits at the
 * cap, which means an entry within one multi-byte character of 64 bytes is a
 * continuation, and anything shorter was a deliberate line — a short line could
 * have held more and wasn't split.
 *
 * It is an inference, not a fact the encoding preserves; it gets the two shapes
 * above right, and its worst failure is cosmetic.
 */
const CIP20_CHUNK_LIMIT = 64
/** Below this, an encoder splitting at 64 bytes would still have had room. */
const CONTINUATION_MIN_BYTES = CIP20_CHUNK_LIMIT - 3

const joinChunks = (parts: readonly string[]): readonly string[] => {
  const encoder = new TextEncoder()
  const lines: string[] = []
  let current = ''
  for (const part of parts) {
    current += part
    // A part that did not fill the cap ends its line; one that did continues.
    if (encoder.encode(part).length < CONTINUATION_MIN_BYTES) {
      lines.push(current)
      current = ''
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/** The CIP-20 `msg` lines, or `null` when this is not a well-formed CIP-20 value. */
const messageLines = (value: unknown): readonly string[] | null => {
  if (value === null || typeof value !== 'object') return null
  const msg = (value as {msg?: unknown}).msg
  if (msg === undefined) return null
  // Only a flat array of strings can be chunked text; anything else keeps the
  // generic rendering.
  const lines =
    Array.isArray(msg) && msg.every((m) => typeof m === 'string') ? joinChunks(msg as string[]) : asLines(msg)
  return lines.length > 0 ? lines.filter((l) => l.length > 0) : null
}

/**
 * The CIP-20 message a sender attached, or `null` when there is none.
 *
 * Exposed separately because a message is the one piece of metadata that belongs
 * on the Overview: it is addressed to the reader, and burying it behind a tab
 * hides the sender's own explanation of the transaction. Details renders every
 * *other* label, so the two never duplicate.
 */
export const metadataMessageLines = (metadata: Record<string, unknown>): readonly string[] | null =>
  messageLines(metadata[CIP20_LABEL])

/**
 * A value too long for one metadatum is also split across *consecutive integer
 * labels*, not only within an array — a marketplace sale carries one Plutus datum
 * across labels 50…56. The signal is the same one CIP-20 gives: an encoder splits
 * only at the 64-byte cap, so a run of at-cap labels ends at the first short one.
 *
 * Returns the runs found, keyed by their first label.
 */
const chunkRuns = (metadata: Record<string, unknown>): Map<string, {labels: string[]; joined: string}> => {
  const encoder = new TextEncoder()
  const numeric = Object.keys(metadata)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b)
  const atCap = (k: number): string | null => {
    const v = metadata[String(k)]
    return typeof v === 'string' && encoder.encode(v).length >= CONTINUATION_MIN_BYTES ? v : null
  }
  const runs = new Map<string, {labels: string[]; joined: string}>()
  const consumed = new Set<number>()
  for (const start of numeric) {
    if (consumed.has(start) || atCap(start) === null) continue
    const labels = [start]
    let joined = atCap(start) as string
    let next = start + 1
    // Walk while the labels stay consecutive and each one is at the cap.
    while (atCap(next) !== null) {
      labels.push(next)
      joined += atCap(next) as string
      next += 1
    }
    // The short label that terminates the run belongs to it.
    const tail = metadata[String(next)]
    if (typeof tail === 'string') {
      labels.push(next)
      joined += tail
    }
    if (labels.length < 2) continue
    for (const l of labels) consumed.add(l)
    runs.set(String(start), {labels: labels.map(String), joined})
  }
  return runs
}

/** Hex bytes, tolerating one trailing separator (seen on chain: `…43ff,`). */
const HEX_RE = /^[0-9a-fA-F]+$/
const asHexBytes = (s: string): string | null => {
  const trimmed = s.replace(/[,;\s]+$/, '')
  return trimmed.length % 2 === 0 && HEX_RE.test(trimmed) ? trimmed : null
}

/**
 * The whole metadata payload as text, for copying out.
 *
 * Every label, whatever the display did with it: entries are collapsed on screen, a
 * chunked value is reassembled, and a reader who wants the raw thing wants all of it
 * to paste into whatever interprets that protocol. Keyed by label so the shape
 * survives the trip.
 */
export const metadataRawText = (metadata: Record<string, unknown>): string => {
  try {
    return JSON.stringify(metadata, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  } catch (e: unknown) {
    logger.warn('Metadata could not be serialised; the copy button yields nothing', {
      origin: 'metadata/entries',
      error: String(e),
    })
    // A cycle cannot come off chain, but the display path guards this too and a copy
    // button that throws is worse than one that copies nothing.
    return ''
  }
}

/**
 * Displayable metadata entries, in the order the labels appear. Entries with
 * nothing to show are dropped rather than rendered empty; a value split across
 * consecutive labels is reassembled into one entry.
 */
export const metadataEntries = (metadata: Record<string, unknown>): readonly MetadataEntry[] => {
  const runs = chunkRuns(metadata)
  const inRun = new Set([...runs.values()].flatMap((r) => r.labels))
  const out: MetadataEntry[] = []
  for (const [key, value] of Object.entries(metadata)) {
    const run = runs.get(key)
    if (run !== undefined) {
      // Only *claim* it is data when it parses as bytes; otherwise it is still the
      // joined text, presented without a claim about its shape.
      const hex = asHexBytes(run.joined)
      out.push({
        key,
        isMessage: false,
        lines: [hex ?? run.joined],
        joinedLabels: run.labels,
        ...(hex !== null ? {isHex: true} : {}),
      })
      continue
    }
    if (inRun.has(key)) continue
    const message = key === CIP20_LABEL ? messageLines(value) : null
    const lines = message ?? asLines(value)
    if (lines.length === 0) continue
    out.push({key, isMessage: message !== null, lines})
  }
  return out
}
