/**
 * Chrome MV3 manifest `version` validation.
 *
 * Chrome requires the manifest version to be 1–4 dot-separated integers, each
 * in 0–65535. This guard turns a missing or malformed version into a hard build
 * failure rather than a manifest Chrome silently refuses to load.
 *
 * @module
 */

const MAX_SEGMENT = 65535

/**
 * Validate and return a Chrome manifest version string.
 *
 * @throws Error if `raw` is not a non-empty string, has more than 4 segments,
 *   or contains a segment that is not an integer in 0–65535.
 */
export function parseChromeVersion(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('manifest version is missing or not a non-empty string')
  }
  const segments = raw.split('.')
  if (segments.length > 4) {
    throw new Error(`Invalid Chrome manifest version "${raw}": expected 1–4 dot-separated integers`)
  }
  for (const segment of segments) {
    if (!/^\d+$/.test(segment) || Number(segment) > MAX_SEGMENT) {
      throw new Error(`Invalid Chrome manifest version "${raw}": each segment must be an integer in 0–${MAX_SEGMENT}`)
    }
  }
  return raw
}
