/**
 * Pure staking-state derivation + delegation-cert decision rule.
 *
 * The decision table names the user's INTENT; `delegation-certs.ts` turns it into certificates.
 * A change touches only what actually changed — re-issuing an unchanged vote delegation would be
 * harmless on-chain but misrepresents the action on the review screen.
 *
 * ⚠️ The combined Conway certificates (10–13) express four of these actions in one cert, and are
 * used for a software wallet only: CIP-21 forbids them in hardware-wallet transactions, so a
 * hardware or script signer gets the atomic certificates instead. See `delegation-certs.ts`.
 *
 * | registered | pool change | drep change | action              |
 * |------------|-------------|-------------|---------------------|
 * | no         | yes         | yes         | stake-vote-reg      |
 * | no         | yes         | no          | stake-reg           |
 * | no         | no          | yes         | vote-reg            |
 * | yes        | yes         | yes         | stake-vote          |
 * | yes        | yes         | no          | stake               |
 * | yes        | no          | yes         | vote                |
 * | *          | no          | no          | noop                |
 *
 * @module
 */

import type {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {type DRepTarget, drepTargetsMatch, parseDRepTarget} from '../../cardano-pool-drep/drep-id'

/** On-chain state of the wallet's stake account, canonicalized for decisions. */
export type StakeAccountState = {
  readonly registered: boolean
  /** `pool1…` bech32, lowercase. */
  readonly currentPool: string | null
  readonly currentDrep: DRepTarget | null
  readonly rewardsAvailable: bigint
  /** Deposit held by the registration, when the backend reports it. */
  readonly deposit: bigint | null
}

/**
 * Canonicalize a provider `AccountInfo` (or `null` — a stake address the chain
 * has never seen, which IS the unregistered empty state, not missing data).
 */
export const stakeStateFromAccountInfo = (info: EvolutionProvider.AccountInfo | null): StakeAccountState =>
  info === null
    ? {registered: false, currentPool: null, currentDrep: null, rewardsAvailable: 0n, deposit: null}
    : {
        registered: info.registered,
        currentPool: info.delegatedPool?.toLowerCase() ?? null,
        // Their spelling is `delegatedDRep`; read, never cast — a cast compiles and hands the
        // screen a field it sees as absent, which reads as "not delegated".
        currentDrep: info.delegatedDRep !== null ? parseDRepTarget(info.delegatedDRep) : null,
        rewardsAvailable: info.rewardsAvailable,
        // ⚠️ `undefined` on their side means the backend did not report a deposit, which is the
        // same fact this screen stores as `null`. Converted, not defaulted to zero.
        deposit: info.deposit ?? null,
      }

/** What the user picked. `null` = keep the current target unchanged. */
export type DelegationSelection = {
  /** `pool1…` bech32. */
  readonly pool: string | null
  readonly drep: DRepTarget | null
}

export type DelegationAction =
  | {readonly kind: 'stake-vote-reg'; readonly poolId: string; readonly drep: DRepTarget}
  | {readonly kind: 'stake-reg'; readonly poolId: string}
  | {readonly kind: 'vote-reg'; readonly drep: DRepTarget}
  | {readonly kind: 'stake-vote'; readonly poolId: string; readonly drep: DRepTarget}
  | {readonly kind: 'stake'; readonly poolId: string}
  | {readonly kind: 'vote'; readonly drep: DRepTarget}
  | {readonly kind: 'noop'}

/** Does this action register the stake key (and therefore pay the deposit)? */
export const actionRegisters = (action: DelegationAction): boolean =>
  action.kind === 'stake-vote-reg' || action.kind === 'stake-reg' || action.kind === 'vote-reg'

export const decideDelegation = (state: StakeAccountState, selection: DelegationSelection): DelegationAction => {
  const poolChanged = selection.pool !== null && selection.pool.toLowerCase() !== state.currentPool
  const drepChanged = selection.drep !== null && !drepTargetsMatch(selection.drep, state.currentDrep)
  const pool = poolChanged ? (selection.pool as string) : null
  const drep = drepChanged ? (selection.drep as DRepTarget) : null

  if (pool !== null && drep !== null) {
    return state.registered ? {kind: 'stake-vote', poolId: pool, drep} : {kind: 'stake-vote-reg', poolId: pool, drep}
  }
  if (pool !== null) return state.registered ? {kind: 'stake', poolId: pool} : {kind: 'stake-reg', poolId: pool}
  if (drep !== null) return state.registered ? {kind: 'vote', drep} : {kind: 'vote-reg', drep}
  return {kind: 'noop'}
}
