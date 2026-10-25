/**
 * Bridge from the fork's CIP-139 query layer to the handler's
 * {@link CardanoQueryContext}: supply the chain-access and datum-decoding layers once,
 * and normalize library failures to the wire error type.
 *
 * This exists so the wiring is written once rather than per call site, and so the wallet
 * rail can hand the handler a query surface in a single expression.
 *
 * Error mapping is deliberately flat: every `ProviderError` / `DecodeError` becomes
 * CIP-139's `InternalError` (-2), whose definition — "an error occurred during execution
 * of this API call" — is exactly what a backend or decode failure is. It is NOT
 * `InvalidRequest`: the dApp's request was well-formed, our fetch was not. Reasons are
 * passed through in the message because they name the endpoint and the missing field,
 * which is the difference between a debuggable report and "something went wrong".
 *
 * @module
 */

import {QueryLayer as Cip139} from '@evolution-sdk/cip139'
import type {Provider as EvProvider} from '@evolution-sdk/evolution'
import type {Decode} from '@evolution-sdk/review/Decode'
import {Effect, type Layer} from 'effect'
import {ApiErrorCode, WireError} from '../types.js'
import type {CardanoQueryContext} from './handler.js'

/**
 * The two services every CIP-139 read needs: chain access, and the datum decoder.
 *
 * ⚠️ `Decode` here is `@evolution-sdk/review`'s. The fork's query layer asks for that one
 * specifically; a same-named service from elsewhere satisfies the type nowhere and fails at the
 * first read with "Service not found".
 */
export type QueryLayers = Layer.Layer<EvProvider.ProviderEffect | Decode>

/** Anything the library's query layer can fail with carries a human-readable reason. */
const messageOf = (error: unknown): string => {
  const e = error as {reason?: unknown; message?: unknown; op?: unknown; _tag?: unknown}
  if (typeof e?.reason === 'string') return e.reason
  if (typeof e?.op === 'string' && typeof e?.message === 'string') return `decode ${e.op}: ${e.message}`
  if (typeof e?.message === 'string') return e.message
  return String(error)
}

/**
 * @param layers the chain-access provider plus a `Decode` implementation — the two
 *   things every CIP-139 read needs. UTxO reads decode inline datums, so a codec-less
 *   layer set would fail at the first script UTxO rather than at construction.
 */
export const makeCardanoQueryContext = (layers: QueryLayers): CardanoQueryContext => {
  const query = Cip139.makeQueryLayer()
  const experimental = Cip139.makeQueryExperimental()

  const run = <A>(effect: Effect.Effect<A, unknown, never>): Effect.Effect<A, WireError> =>
    effect.pipe(
      Effect.mapError((error) => new WireError({code: ApiErrorCode.InternalError, message: messageOf(error)})),
    )
  // ⚠️ No adaptation here any more: the caller hands us Evolution's `ProviderEffect` directly,
  // which is what the fork's query layer asks for. It used to receive the wallet-shaped port and
  // derive the typed one — a conversion that existed only because the two ends disagreed.

  // `as never` narrows the requirement channel after the layers are provided; each call
  // site below is otherwise identical, which is why this is one helper and not 22.
  const provided = <A>(effect: Effect.Effect<A, unknown, unknown>): Effect.Effect<A, WireError> =>
    run((effect as Effect.Effect<A, unknown, never>).pipe(Effect.provide(layers)) as Effect.Effect<A, unknown, never>)

  return {
    getUtxosByAddress: (address) => provided(query.getUtxosByAddress(address)),
    getUtxosByAsset: (assetName, policy) => provided(query.getUtxosByAsset(assetName, policy)),
    getUtxosByPaymentCredential: (credential) => provided(query.getUtxosByPaymentCredential(credential)),
    getUtxosByStakeCredential: (rewardAddress) => provided(query.getUtxosByStakeCredential(rewardAddress)),
    getUtxosByTransactionHash: (txHash) => provided(query.getUtxosByTransactionHash(txHash)),
    getProtocolParametersByLatest: () => provided(query.getProtocolParametersByLatest()),
    getProtocolParametersByEpoch: (epoch) => provided(query.getProtocolParametersByEpoch(epoch)),
    getVotesByDrepId: (id) => provided(query.getVotesByDrepId(id)),
    getVotesBySpoId: (id) => provided(query.getVotesBySpoId(id)),
    getVotesByCcId: (id) => provided(query.getVotesByCcId(id)),
    getVotesByProposalId: (id) => provided(query.getVotesByProposalId(id)),
    getAllDreps: () => provided(query.getAllDreps()),
    getDrepById: (id) => provided(query.getDrepById(id)),
    getDrepByStakeCredential: (rewardAddress) => provided(query.getDrepByStakeCredential(rewardAddress)),
    getAllCommitteeMembers: () => provided(query.getAllCommitteeMembers()),
    getCommitteeMemberById: (id) => provided(query.getCommitteeMemberById(id)),
    getAllPools: () => provided(query.getAllPools()),
    getPoolById: (id) => provided(query.getPoolById(id)),
    getAllProposals: () => provided(query.getAllProposals()),
    getProposalById: (id) => provided(query.getProposalById(id)),
    tip: provided(experimental.tip()),
    resolveOutpoints: (refs) => provided(experimental.resolveOutpoints(refs)),
  }
}
