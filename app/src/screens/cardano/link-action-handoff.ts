/**
 * In-memory handoff from a scanned or deep link to the link-action sheet.
 *
 * The sheet's subject is a tagged union carrying `bigint` amounts and a
 * `DRepTarget`, none of which survives a route param — params are strings. So the
 * subject is registered here and the route carries only an opaque id.
 *
 * Same discipline as the two prefill registries it sits beside: single-consumer
 * and evicted on claim, so a re-mount cannot silently re-apply something the user
 * already abandoned. And the same reason for the indirection — what crosses it is
 * *untrusted input*, and one registry keeps one answer to "where did this come
 * from".
 *
 * A card tapped in a thread does not go through here: it has the subject in hand
 * and opens the sheet inline. This exists for the entry points that have no card
 * to tap.
 *
 * @module
 */

import type {LinkActionSubject} from './LinkActionSheet'

const subjects = new Map<string, LinkActionSubject>()
let counter = 0

/** Register a subject; returns the id to pass as the `subject` route param. */
export const registerLinkActionSubject = (subject: LinkActionSubject): string => {
  counter += 1
  const id = `lnk_${counter}`
  subjects.set(id, subject)
  return id
}

/** Take the subject, removing it. */
export const claimLinkActionSubject = (id: string): LinkActionSubject | undefined => {
  const subject = subjects.get(id)
  subjects.delete(id)
  return subject
}
