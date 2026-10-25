/**
 * Reading the issuer out of a permit, without pretending to verify it.
 *
 * ⚠️ **This is a decode, not a check.** A permit is signed by the content service and *the service*
 * is what validates it — the app cannot, and must not appear to: it holds no key, and a client-side
 * "valid" would be a claim nobody checked. What the app needs is narrower and safe to take from an
 * unverified payload: **which identity to file the permit under**, so that writing to that person
 * later presents it. If the value is wrong the permit simply will not work, which is exactly what a
 * forged one should do.
 *
 * Nothing here is shown to the user as a *name*. A screen that named the issuer from this would be
 * asserting an identity on the strength of a string anyone can write.
 *
 * ⚠️ Both failure paths log at `debug` rather than staying silent. The absence is the expected
 * answer for a hand-edited or truncated link — but "this link is not a permit" and "this link is a
 * permit we failed to read" look identical to the user, and only the log tells them apart.
 *
 * @module
 */

import {logger} from '../logger'

const ORIGIN = 'dm-permit-issuer'

/** Decode base64url, which is what a JWT segment is. */
const decodeSegment = (segment: string): string | undefined => {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const full = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  try {
    return atob(full)
  } catch (error) {
    // Not base64 at all — a link someone hand-edited, or not a permit.
    logger.debug('a permit segment was not base64url', {origin: ORIGIN, error: String(error)})
    return undefined
  }
}

/**
 * The `pnyx_id` a permit was issued by, or `undefined` when the token is not one we can read.
 *
 * Deliberately strict about shape: three segments, a JSON middle, and a string `sub`. A permissive
 * reader would file a permit under a nonsense key and leave the user unable to message anyone, with
 * nothing to see.
 */
export const permitIssuer = (token: string): string | undefined => {
  const segments = token.split('.')
  if (segments.length !== 3) return undefined
  const payload = decodeSegment(segments[1] ?? '')
  if (payload === undefined) return undefined
  try {
    const parsed = JSON.parse(payload) as {sub?: unknown; aud?: unknown}
    // The audience is the one field that distinguishes a permit from a session token signed by the
    // same key. Checking it here is not verification — it stops a *correctly formed* token of the
    // wrong kind being filed as a permit and silently never working.
    if (parsed.aud !== 'pnyx-dm-permit') return undefined
    return typeof parsed.sub === 'string' && parsed.sub.length > 0 ? parsed.sub : undefined
  } catch (error) {
    logger.debug('a permit payload was not readable JSON', {origin: ORIGIN, error: String(error)})
    return undefined
  }
}
