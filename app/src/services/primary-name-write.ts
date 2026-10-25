/**
 * Write `identity(C).primaryName` — the one field that decides what name an identity shows.
 *
 * **Its own module because two callers need it and only one of them is the handle vertical.** A
 * nickname is just this write; a handle claim is a permit, a shell deploy, a `bind` and then this
 * same write. The handle paths are flagged off for the mainnet launch, so leaving the writer inside
 * `handle-claim.ts` would have made the nickname depend on dormant machinery — and copying it would
 * have given the one field two writers to drift apart.
 *
 * ⚠️ **The display spelling, not the canonical one.** `bind` seals the folded form, which is what
 * makes `Alice` and `alice` one name; the row carries the case its owner chose, and a reader folds it
 * before comparing. Writing the canonical form here would silently lose the capitalisation the user
 * typed — and it would do it invisibly, because the name would still render, just wrong.
 *
 * @module
 */

import {encodeDisplayName} from '@pnyx/contract-client/handle'
import {hex} from '@pnyx/crypto'
import {buildSetPrimaryNameProvenTx} from '@pnyx/midnight-native'
import {logger} from '../logger'
import {ensureCircuitArtifacts} from './pnyx-artifacts'
import {readPnyxContractState} from './pnyx-contract-state'
import {relaySponsoredTx} from './sponsored-relay'

const ORIGIN = 'primary-name-write'

/** Why a row write did not land. Narrower than the claim chain's, which has permits to fail at. */
export type PrimaryNameFailure =
  /** The identity contract could not be read, so there is no state to build against. */
  | {readonly kind: 'unavailable'; readonly reason: 'registry-unreachable'}
  /** The transaction could not be built or proven. */
  | {readonly kind: 'unavailable'; readonly reason: 'not-shown'}
  /** Built and proven, but the relay refused it. */
  | {readonly kind: 'relay'; readonly detail: string}

export type PrimaryNameResult = {readonly ok: true} | {readonly ok: false; readonly failure: PrimaryNameFailure}

/** What the write needs, and nothing more — notably no permit, no group and no account index. */
export type PrimaryNameInputs = {
  readonly identitySk: Uint8Array
  readonly contractAddress: Uint8Array
  readonly networkId: string
  /** Absolute unix-second expiry — a duration writes Timestamp(3600) and the node rejects it. */
  readonly expiresAtSecs: number
}

/**
 * Point `identity(C).primaryName` at `display`.
 *
 * Returns a failure rather than throwing: both callers have something sensible to do with one — the
 * claim path says "bound but not shown", and the nickname path keeps the intent and retries later.
 */
export const writePrimaryName = async (params: {
  readonly display: string
  readonly inputs: PrimaryNameInputs
}): Promise<PrimaryNameResult> => {
  const addressHex = hex.encode(params.inputs.contractAddress)
  const state = await readPnyxContractState(addressHex)
  if (state === null) {
    logger.warn('the identity row could not be read, so its name was not written', {
      origin: ORIGIN,
      address: addressHex,
    })
    return {ok: false, failure: {kind: 'unavailable', reason: 'registry-unreachable'}}
  }
  let tx: Uint8Array
  try {
    tx = await buildSetPrimaryNameProvenTx({
      artifacts: await ensureCircuitArtifacts('setPrimaryName', 'identity'),
      contractState: state,
      contractAddress: params.inputs.contractAddress,
      identitySk: params.inputs.identitySk,
      name: encodeDisplayName(params.display),
      networkId: params.inputs.networkId,
      ttlSecs: params.inputs.expiresAtSecs,
    })
  } catch (error) {
    logger.warn('setPrimaryName could not be built', {origin: ORIGIN, error: String(error)})
    return {ok: false, failure: {kind: 'unavailable', reason: 'not-shown'}}
  }
  try {
    await relaySponsoredTx(tx)
  } catch (error) {
    logger.warn('setPrimaryName was built but the relay refused it', {origin: ORIGIN, error: String(error)})
    return {ok: false, failure: {kind: 'relay', detail: error instanceof Error ? error.message : String(error)}}
  }
  logger.info('the identity row now points at the name', {origin: ORIGIN, name: params.display})
  return {ok: true}
}
