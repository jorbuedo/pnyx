/**
 * Which certificates a delegation action becomes, given who will sign it.
 *
 * Conway added four combined certificates (10–13) that fold registration, stake delegation and
 * vote delegation into one. They are smaller and cheaper, and this module still uses them — for a
 * software wallet.
 *
 * ⚠️ **They are unusable on hardware, and not because of a firmware gap.** CIP-21, the
 * hardware-wallet interoperability spec, lists `stake_vote_deleg_cert`, `stake_reg_deleg_cert`,
 * `vote_reg_deleg_cert` and `stake_vote_reg_deleg_cert` among the types that "are not supported
 * and must not be included". Both device converters in `@evolution-sdk/hardware-cardano` refuse
 * them, Ledger's as well as Trezor's, so no SDK bump or firmware release changes the answer. A
 * Trezor run on 2026-10-08 hit exactly this: a `stake-vote-reg` selection produced one
 * `stake_vote_reg_delegation` and the ceremony refused it before the device saw anything.
 *
 * So a hardware wallet gets the atomic certificates instead — `reg`, `stake_delegation`,
 * `vote_delegation` — which every signer accepts, at the cost of a few hundred lovelace for the
 * larger body.
 *
 * ⚠️ **A script wallet decomposes too**, even though no device signs the build itself: its
 * co-signers are whatever they are, and a shared wallet with one Trezor among its signers would
 * otherwise produce a transaction that cannot be completed — discovered at gather time, by
 * somebody who is not the person who built it.
 *
 * ⚠️ **Order is load-bearing.** Certificates apply in sequence within a transaction, so the
 * registration precedes the delegations that depend on it.
 *
 * @module
 */

import type {DRepTarget} from '../../cardano-pool-drep/drep-id'
import type {SignerKind} from '../signer-kind'
import type {DelegationAction} from './state'

/**
 * One certificate to build. Deliberately not the codec's argument shapes: this module decides
 * WHICH certificates a selection needs, and `staking-flow` knows how to encode each.
 */
export type DelegationCertStep =
  | {readonly kind: 'register'}
  | {readonly kind: 'delegate-stake'; readonly poolId: string}
  | {readonly kind: 'delegate-vote'; readonly drep: DRepTarget}
  | {readonly kind: 'register-delegate-stake'; readonly poolId: string}
  | {readonly kind: 'register-delegate-vote'; readonly drep: DRepTarget}
  | {readonly kind: 'delegate-stake-vote'; readonly poolId: string; readonly drep: DRepTarget}
  | {readonly kind: 'register-delegate-stake-vote'; readonly poolId: string; readonly drep: DRepTarget}

/**
 * Can this signer be handed a combined certificate?
 *
 * Only a software wallet. `null` — a watch-only group, or one whose source we could not read —
 * decomposes: the atomic form is valid for every signer, so an unknown signer gets the answer
 * that cannot be wrong.
 */
export const combinedCertsAllowed = (signer: SignerKind | null): boolean => signer === 'software'

/**
 * The certificates an action becomes, in application order.
 *
 * `noop` yields none — callers reject it before reaching here, and an empty list is honest about
 * what "nothing to do" means rather than inventing a certificate.
 */
export const delegationCertSteps = (
  action: DelegationAction,
  signer: SignerKind | null,
): readonly DelegationCertStep[] => {
  const combined = combinedCertsAllowed(signer)
  switch (action.kind) {
    case 'stake-vote-reg':
      return combined
        ? [{kind: 'register-delegate-stake-vote', poolId: action.poolId, drep: action.drep}]
        : [
            {kind: 'register'},
            {kind: 'delegate-stake', poolId: action.poolId},
            {kind: 'delegate-vote', drep: action.drep},
          ]
    case 'stake-reg':
      return combined
        ? [{kind: 'register-delegate-stake', poolId: action.poolId}]
        : [{kind: 'register'}, {kind: 'delegate-stake', poolId: action.poolId}]
    case 'vote-reg':
      return combined
        ? [{kind: 'register-delegate-vote', drep: action.drep}]
        : [{kind: 'register'}, {kind: 'delegate-vote', drep: action.drep}]
    case 'stake-vote':
      return combined
        ? [{kind: 'delegate-stake-vote', poolId: action.poolId, drep: action.drep}]
        : [
            {kind: 'delegate-stake', poolId: action.poolId},
            {kind: 'delegate-vote', drep: action.drep},
          ]
    case 'stake':
      return [{kind: 'delegate-stake', poolId: action.poolId}]
    case 'vote':
      return [{kind: 'delegate-vote', drep: action.drep}]
    case 'noop':
      return []
  }
}
