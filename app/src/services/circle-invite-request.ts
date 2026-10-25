/**
 * Ask a circle's attestor for an invite, by proving control of a Cardano stake credential.
 *
 * A Compact circuit cannot read Cardano's ledger, so a gated circle's entry rule is checked off
 * chain and the attestor's *output is an invite* (`docs/BOUNDED_STATE_ARCHITECTURE.md` §"Gating a
 * circle is an **invite**"). This is the client half, in two parts either side of a consent:
 * {@link beginCircleInviteRequest} fetches the challenge, and {@link completeCircleInviteRequest}
 * exchanges the reviewed signature for a code.
 *
 * ⚠️ **Two calls, because a person consents in between.** The signature asserts a *funds wallet's*
 * stake credential, so it is produced on `TxReviewScreen` like every other funds signature rather
 * than here (`circle-invite-ceremony.ts`). Nothing in this module holds key material.
 *
 * ⚠️ **A funds wallet, not the identity.** This signed with the identity's own stake key until
 * 2026-09-11, which could never satisfy a real requirement: that key is derived from the identity
 * seed, is never delegated and holds nothing. The person picks which of their wallets to prove, and
 * the sheet shows them the requirements first so the choice is an informed one
 * (`circle-invite-eligibility.ts`).
 *
 * ⚠️ **What the service learns, and what the chain does not.** The attestor sees stake key ↔
 * `pnyx_id`, because it has to: it is checking a claim about a specific wallet on behalf of a
 * specific account. On chain there is only an invite commitment being spent and an unlinkable join
 * nullifier — the link stops at the service and never reaches the ledger.
 *
 * @module
 */

import {decodeCircleInvite} from '@pnyx/contract-client/circle-invite'
import {logger} from '../logger'
import type {InviteSignature} from './circle-invite-ceremony'
import {type InviteRequestFailure, inviteFailureFrom} from './circle-invite-failure'
import type {InviteRewardAddress} from './circle-invite-review'
import {pnyxApi} from './pnyx-api'

const ORIGIN = 'circle-invite-request'

export type {InviteRequestFailure}

/** A server-issued challenge: the exact bytes to sign, and the window they are good for. */
export type InviteChallenge = {
  readonly nonce: string
  readonly expiresAtMs: number
  readonly payload: string
}

export type InviteChallengeResult =
  | {readonly ok: true; readonly challenge: InviteChallenge}
  | {readonly ok: false; readonly failure: InviteRequestFailure}

export type InviteRequestResult =
  | {readonly ok: true; readonly invite: string; readonly reissued: boolean}
  | {readonly ok: false; readonly failure: InviteRequestFailure}

/**
 * Fetch the challenge to be signed.
 *
 * Asked **before** the review screen, so the bytes the person confirms are the ones the service
 * issued — a challenge fetched afterwards would mean confirming a payload that did not exist yet.
 *
 * Returns a typed failure rather than throwing: every branch is something the sheet has to say out
 * loud, and flattening them would tell someone whose wallet qualifies — but whose circle has not
 * delegated to us — that they do not qualify.
 */
export const beginCircleInviteRequest = async (params: {
  readonly token: string
  readonly circleId: string
}): Promise<InviteChallengeResult> => {
  try {
    return {ok: true, challenge: await pnyxApi.requestInviteChallenge(params.token, params.circleId)}
  } catch (e) {
    logger.warn('could not get an invite challenge', {origin: ORIGIN, circleId: params.circleId, error: String(e)})
    return {ok: false, failure: inviteFailureFrom(e)}
  }
}

/**
 * Exchange a reviewed signature for an invite code.
 *
 * The code is decoded here purely as a check: one that will not decode is one the join sheet would
 * refuse later with no explanation, and finding that out now is worth one hash.
 */
export const completeCircleInviteRequest = async (params: {
  readonly token: string
  readonly circleId: string
  readonly challenge: InviteChallenge
  readonly reward: InviteRewardAddress
  readonly signature: InviteSignature
}): Promise<InviteRequestResult> => {
  try {
    const claimed = await pnyxApi.claimCircleInvite(params.token, params.circleId, {
      nonce: params.challenge.nonce,
      expiresAtMs: params.challenge.expiresAtMs,
      stakeAddressBech32: params.reward.rewardBech32,
      stakeAddressHex: params.reward.rewardHex,
      signature: params.signature.signature,
      key: params.signature.key,
    })
    decodeCircleInvite(claimed.invite)
    logger.info('invite granted', {origin: ORIGIN, circleId: params.circleId, reissued: claimed.reissued})
    return {ok: true, invite: claimed.invite, reissued: claimed.reissued}
  } catch (e) {
    const failure = inviteFailureFrom(e)
    logger.warn('invite claim refused', {
      origin: ORIGIN,
      circleId: params.circleId,
      failure: failure.kind,
      // The service's own code for *which* rule bit refused. Without it a refusal is one
      // undiagnosable sentence, and "below the threshold" and "the chain has never seen this
      // stake key" send a founder and a requester to look in completely different places.
      ...(failure.kind === 'not-eligible' ? {reason: failure.reason} : {}),
      error: String(e),
    })
    return {ok: false, failure}
  }
}
