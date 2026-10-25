/**
 * Reading a consent refusal off a failed DM request.
 *
 * ⚠️ **A block and a closed inbox answer identically**, by design: a sender must not be able to
 * learn they were blocked specifically, which is information the blocker never agreed to disclose.
 * Only `permit-required` is distinguishable, because an honest sender needs to know that asking for
 * a permit would help (`docs/ABUSE_MITIGATION.md` §5).
 *
 * Its own module so the mapping can be tested without a network, and so a new refusal shape has one
 * place to be added.
 *
 * @module
 */

import {DmApiError} from './dm-api'

/** How a refused conversation is reported, or `undefined` when the error was something else. */
export type ConsentRefusal = 'peer-refuses' | 'permit-required'

/**
 * Classify an error thrown by a DM request.
 *
 * Only a 403 is a refusal. A 401 is our own session expiring, a 409 is an empty key-package pool,
 * and an unreachable service is neither — reading any of those as "they refuse you" would tell the
 * user something false about another person.
 */
export const consentRefusalOf = (error: unknown): ConsentRefusal | undefined => {
  if (!(error instanceof DmApiError) || error.status !== 403) return undefined
  return /permit/i.test(error.message) ? 'permit-required' : 'peer-refuses'
}
