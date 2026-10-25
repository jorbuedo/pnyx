/**
 * Why the Create button is not available yet.
 *
 * A disabled button that says nothing is the shape this app keeps getting wrong:
 * the user is left comparing their form against a rule nobody wrote down. The
 * decision is a pure function of the form's state so the screen can *say* the
 * reason, and so the reason can be tested without a form.
 *
 * Ordered deliberately — the first missing thing, not all of them. A form with
 * no co-signers and an unreachable quorum should ask for a co-signer, because
 * adding one is what makes the quorum question meaningful.
 *
 * @module
 */

import type {BuildProblem} from '../../../services/cardano/multisig'
import type {CoSignerRef} from '../../../services/cardano/multisig/types'

export type CreateBlocker =
  /** The name was cleared. It is pre-filled, so this only happens deliberately. */
  | 'no-name'
  /** Every co-signer row was removed. */
  | 'no-cosigners'
  /** A row is missing a name or holds something that is not a co-signer key. */
  | 'incomplete-cosigner'
  /** The quorum or the time window cannot be satisfied as entered. */
  | 'policy'
  /** A validated wallet-level problem — a duplicate key, a tag with no roster row. */
  | 'problems'

export type CreateReadiness = {readonly kind: 'ready'} | {readonly kind: 'blocked'; readonly reason: CreateBlocker}

export const createReadiness = (input: {
  readonly name: string
  readonly draftCount: number
  /** `null` when any row is unusable — see `draftsToRoster`. */
  readonly roster: readonly CoSignerRef[] | null
  /** `null` when the quorum or the time bounds do not compile to a template. */
  readonly templateValid: boolean
  readonly problems: readonly BuildProblem[]
}): CreateReadiness => {
  if (input.name.trim() === '') return {kind: 'blocked', reason: 'no-name'}
  if (input.draftCount === 0) return {kind: 'blocked', reason: 'no-cosigners'}
  if (input.roster === null) return {kind: 'blocked', reason: 'incomplete-cosigner'}
  if (!input.templateValid) return {kind: 'blocked', reason: 'policy'}
  if (input.problems.length > 0) return {kind: 'blocked', reason: 'problems'}
  return {kind: 'ready'}
}

const REASON_KEY = {
  'no-name': 'multisig.create.blockedNoName',
  'no-cosigners': 'multisig.create.blockedNoCoSigners',
  'incomplete-cosigner': 'multisig.create.blockedIncomplete',
  policy: 'multisig.create.blockedPolicy',
  /**
   * Deliberately silent: a wallet-level problem already has its own callout above
   * the form, naming the co-signer involved. Repeating it under the button would
   * be the same sentence twice, in less detail.
   */
  problems: null,
} as const satisfies Record<CreateBlocker, string | null>

/** The message for a blocker, or `null` when the screen already says it elsewhere. */
export const blockerMessageKey = (reason: CreateBlocker): (typeof REASON_KEY)[CreateBlocker] => REASON_KEY[reason]
