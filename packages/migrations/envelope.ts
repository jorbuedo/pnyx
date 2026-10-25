/**
 * Envelope parsing helpers.
 *
 * The on-disk shape is `{version: number, data: unknown}`. Anything else is
 * treated as unversioned "v0" legacy data, so that pre-framework writes can
 * be picked up and migrated on first read.
 *
 * @module
 */

import type {VersionedBlob} from './types.js'

/**
 * Return value for `parseEnvelope`.
 *
 * - `invalid-json`: the string wasn't valid JSON.
 * - `legacy`: parsed OK but doesn't look like an envelope — caller should
 *   run migrations from `from: 0` with the raw parsed value.
 * - `versioned`: a well-formed envelope.
 */
export type EnvelopeParse =
  | {readonly kind: 'invalid-json'; readonly error: unknown}
  | {readonly kind: 'legacy'; readonly raw: unknown}
  | {readonly kind: 'versioned'; readonly blob: VersionedBlob}

const isEnvelope = (value: unknown): value is VersionedBlob => {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  // Strict check: only treat as an envelope when it has a numeric `version`
  // *and* a `data` key. Any other shape (including objects that happen to
  // have a `version` field meaning something else — e.g. the wallet
  // snapshot's embedded `version: 3`) falls through to legacy handling,
  // which is intentional: the snapshot's version field has a different
  // meaning and its blob stays outside the framework.
  //
  // `version: 0` is explicitly NOT a valid envelope value — v0 is reserved
  // for the legacy-detection path (unwrapped pre-framework data). Rejecting
  // it here means `{version: 0, data: …}` takes the legacy path too, and
  // there's a single unambiguous v0 entry shape.
  return typeof obj.version === 'number' && Number.isInteger(obj.version) && obj.version >= 1 && 'data' in obj
}

export const parseEnvelope = (raw: string): EnvelopeParse => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {kind: 'invalid-json', error}
  }
  if (isEnvelope(parsed)) {
    return {kind: 'versioned', blob: parsed}
  }
  return {kind: 'legacy', raw: parsed}
}

export const serializeEnvelope = <T>(version: number, data: T): string => {
  const blob: VersionedBlob<T> = {version, data}
  return JSON.stringify(blob)
}
