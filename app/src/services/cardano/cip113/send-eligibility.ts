/**
 * Whether this wallet can move a given programmable token, decided before the user picks an amount.
 *
 * A CIP-113 transfer runs the issuer's own transfer-logic script, and we can only build one whose
 * witness we hold. On the live preview registry that is **one policy out of twelve** — every other
 * one delegates to a substandard nobody outside its issuer can satisfy. So "can I send this?" is
 * not a detail discovered at build time; for most tokens the answer is no, and it is knowable from
 * the registry the moment the token is selected.
 *
 * ⚠️ The three unhappy answers are deliberately distinct, because they are different facts about
 * the world and merging them would misinform in different directions:
 *
 * - **unregistered** — not a token of this deployment. Nothing here applies.
 * - **needs-issuer** — registered, real, and gated behind a script we have no witness for. The
 *   holder owns it and cannot move it *from this wallet*. That is not "broken" and must not read
 *   as an error.
 * - **unclassifiable** — the registry could not be read. Different from "you cannot", and saying
 *   "you cannot" would be a claim we have not earned.
 *
 * @module
 */

import type {Classify as Cip113Classify} from '@evolution-sdk/cip113'

export type SendEligibility =
  | {
      readonly kind: 'sendable'
      /** The substandard we hold a witness for. Named so the review can say which rules applied. */
      readonly transferLogicHashHex: string
      /**
       * Whether the issuer can seize this token, carried through to the send surface rather than
       * left in a detail view. `unknown` counts as a warning, never as safe.
       */
      readonly seizure: Cip113Classify.Seizure
    }
  /** Transfer is gated behind a signature rather than a script — we have no key for it. */
  | {readonly kind: 'needs-issuer'; readonly reason: 'substandard' | 'signature'; readonly detail: string}
  | {readonly kind: 'unregistered'}
  | {readonly kind: 'unclassifiable'; readonly detail: string}

/**
 * Decide from a classification the library produced.
 *
 * Takes the classification rather than computing one: which substandards we can witness is a fact
 * about *this wallet's* capabilities, and the library is deliberately incapable of knowing it. The
 * split is the same one the ownership verdict uses — the library classifies, we decide.
 */
export const sendEligibilityOf = (classification: Cip113Classify.Cip113Classification): SendEligibility => {
  if (classification.registration === 'unregistered') return {kind: 'unregistered'}

  const t = classification.transferability
  switch (t.kind) {
    case 'known-substandard':
      return {kind: 'sendable', transferLogicHashHex: t.scriptHashHex, seizure: classification.seizure}
    case 'unknown-substandard':
      return {
        kind: 'needs-issuer',
        reason: 'substandard',
        detail: `transfers of this token run a rule set this wallet cannot satisfy (${t.scriptHashHex.slice(0, 12)}…)`,
      }
    case 'signature-gated':
      return {
        kind: 'needs-issuer',
        reason: 'signature',
        detail: 'transfers of this token must be signed by its issuer',
      }
    // A registered policy whose transferability reads `not-programmable` is a contradiction in the
    // registry, not a token we may quietly try to move.
    case 'not-programmable':
      return {kind: 'unclassifiable', detail: 'the registry describes this token inconsistently'}
  }
}

/** Whether the send surface must show a seizure warning. `unknown` is not reassurance. */
export const showsSeizureWarning = (seizure: Cip113Classify.Seizure): boolean => seizure.kind !== 'disabled'
