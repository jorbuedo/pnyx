/**
 * Pure formatting helpers for the tx-review renderer: bech32 id encoding
 * (pool / DRep / committee / gov-action), hash truncation, and the i18n leaf
 * keys for operation + governance labels. No React, no async — unit-tested.
 *
 * @module
 */

import {Cip129} from '@evolution-sdk/cips'
import {bech32} from '@pnyx/crypto'
import type {ReviewedDRep, ReviewedGovAction, ReviewedOperation, ReviewedVote} from '@pnyx/tx-review'
import {logger} from '../../../logger'
import {truncateMiddle} from '../../../utils/truncate'

export {truncateMiddle}

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** `pool1…` (CIP-5): plain bech32 of the 28-byte pool key hash. */
export const poolBech32 = (poolKeyHashHex: string): string => {
  try {
    return bech32.encode('pool', bech32.toWords(hexToBytes(poolKeyHashHex)))
  } catch (e: unknown) {
    // Falling back to hex is right — better the raw value than a wrong one — but the reader is
    // then asked to check a pool id in a form no explorer shows.
    logger.warn('Pool id could not be bech32-encoded; the review shows raw hex', {
      origin: 'review/format',
      poolKeyHashHex,
      error: String(e),
    })
    return poolKeyHashHex
  }
}

/** `drep1…` / abstain / no-confidence label for a vote-delegation DRep (CIP-129). */
export const drepLabel = (
  drep: ReviewedDRep,
): {readonly kind: 'id' | 'abstain' | 'noConfidence'; readonly id?: string} => {
  switch (drep.type) {
    case 'key_hash':
      return {kind: 'id', id: safe(() => Cip129.drepBech32(hexToBytes(drep.keyHashHex), false), drep.keyHashHex)}
    case 'script_hash':
      return {kind: 'id', id: safe(() => Cip129.drepBech32(hexToBytes(drep.scriptHashHex), true), drep.scriptHashHex)}
    case 'abstain':
      return {kind: 'abstain'}
    case 'no_confidence':
      return {kind: 'noConfidence'}
  }
}

/** bech32 id for a governance voter (drep / cc_hot / pool). */
export const voterId = (voter: ReviewedVote['voter']): string => {
  switch (voter.role) {
    case 'drep':
      return safe(
        () => Cip129.drepBech32(hexToBytes(voter.credential.hashHex), voter.credential.type === 'script'),
        voter.credential.hashHex,
      )
    case 'committee_hot':
      return safe(
        () => Cip129.ccHotBech32(hexToBytes(voter.credential.hashHex), voter.credential.type === 'script'),
        voter.credential.hashHex,
      )
    case 'pool':
      return poolBech32(voter.keyHashHex)
  }
}

/** `gov_action1…` id for a proposal / vote target. */
export const govActionId = (txHashHex: string, index: number): string =>
  safe(() => Cip129.govActionBech32(hexToBytes(txHashHex), index), `${txHashHex}#${index}`)

const safe = (f: () => string, fallback: string): string => {
  try {
    return f()
  } catch (e: unknown) {
    // Same bargain as `poolBech32`: the fallback is the raw value, so the review stays truthful
    // while becoming unreadable. Which of the two happened must not be a guess.
    logger.warn('Review identifier could not be encoded; showing the raw value', {
      origin: 'review/format',
      fallback,
      error: String(e),
    })
    return fallback
  }
}

/** `txReview.operations.*` leaf key for an operation kind. */
export const operationLabelKey = (op: ReviewedOperation): string => {
  switch (op.kind) {
    case 'stake-registration':
      return 'stakeRegistration'
    case 'stake-deregistration':
      return 'stakeDeregistration'
    case 'stake-delegation':
      return 'stakeDelegation'
    case 'vote-delegation':
      return 'voteDelegation'
    case 'stake-vote-delegation':
      return 'stakeVoteDelegation'
    case 'stake-reg-delegation':
      return 'stakeRegDelegation'
    case 'vote-reg-delegation':
      return 'voteRegDelegation'
    case 'stake-vote-reg-delegation':
      return 'stakeVoteRegDelegation'
    case 'committee-hot-auth':
      return 'committeeHotAuth'
    case 'committee-cold-resign':
      return 'committeeColdResign'
    case 'drep-registration':
      return 'drepRegistration'
    case 'drep-deregistration':
      return 'drepDeregistration'
    case 'drep-update':
      return 'drepUpdate'
    case 'pool-registration':
      return 'poolRegistration'
    case 'pool-retirement':
      return 'poolRetirement'
    case 'reward-withdrawal':
      return 'rewardWithdrawal'
    case 'minting':
      return op.burns ? 'burning' : 'minting'
    case 'voting-procedures':
      return 'votingProcedures'
    case 'proposal-procedures':
      return 'proposalProcedures'
    case 'contract-execution':
      return 'contractExecution'
    case 'unknown-certificate':
      return 'unknownCertificate'
  }
}

/** `txReview.govActions.*` leaf key for a proposal's action. */
export const govActionLabelKey = (action: ReviewedGovAction): string => {
  switch (action.type) {
    case 'parameter_change':
      return 'parameterChange'
    case 'hard_fork':
      return 'hardFork'
    case 'treasury_withdrawals':
      return 'treasuryWithdrawals'
    case 'no_confidence':
      return 'noConfidence'
    case 'update_committee':
      return 'updateCommittee'
    case 'new_constitution':
      return 'newConstitution'
    case 'info':
      return 'info'
  }
}
