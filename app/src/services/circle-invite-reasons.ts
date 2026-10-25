/**
 * A refused invite, rule by rule.
 *
 * ⚠️ **"You do not qualify" is not an answer when a circle has several rules.** The service
 * evaluates them as a set and returns one failure per rule, in the circle's own order, because the
 * useful answer is which of the several things to go and do — delegate to that DRep, move to that
 * pool, hold that much ADA. Collapsing them to one sentence throws that away at the last step.
 *
 * Its own module so it can be tested without a network or a stake key.
 *
 * @module
 */

import type {TranslationKey} from '../i18n/types'

/** The codes `services/content/src/circle-invite-policy.ts` can return, mapped to what to say. */
const KEYS: Readonly<Record<string, TranslationKey>> = {
  'stake-key-not-registered': 'forum.join.requestFailed.reasonNotRegistered',
  'not-delegated-to-that-drep': 'forum.join.requestFailed.reasonNotThatDrep',
  'not-in-that-pool': 'forum.join.requestFailed.reasonNotThatPool',
  'below-ada-threshold': 'forum.join.requestFailed.reasonBelowAda',
  'balance-unknown': 'forum.join.requestFailed.reasonBalanceUnknown',
}

export type InviteRefusalLine =
  /** A code this build knows. */
  | {readonly kind: 'known'; readonly key: TranslationKey}
  /**
   * A code it does not.
   *
   * ⚠️ **Rendered, never dropped** — the same rule an unrecognised *requirement* follows. A build
   * older than the service would otherwise show fewer reasons than the refusal had, and a person
   * would go and satisfy the ones they could see while the invisible one kept refusing them.
   */
  | {readonly kind: 'unknown'; readonly code: string}

/** One line per rule the wallet failed, in the order the service returned them. */
export const inviteRefusalLines = (reasons: readonly string[]): readonly InviteRefusalLine[] =>
  reasons.map((code) => {
    const key = KEYS[code]
    return key === undefined ? {kind: 'unknown' as const, code} : {kind: 'known' as const, key}
  })
