/**
 * Registry persistence for in-flight co-sign envelopes: a partially-signed
 * `TxEnvelope` is saved so it survives a restart and surfaces in the pending
 * inbox; once quorum is met it is removed (it will be submitted, not resumed).
 * The id is derived deterministically from the tx body so re-importing or
 * re-signing the same transaction is idempotent (same key, more witnesses).
 *
 * @module
 */

import {hex, sha256, utf8} from '@pnyx/crypto'
import type {Storage, StorageError} from '@pnyx/storage'
import type {Effect} from 'effect'
import {createProfileStorage} from '../../profile/profile-storage'
import {removeCosign, saveCosign} from './registry'
import type {TxEnvelope} from './types'

/** Deterministic id from the tx body — stable across re-import / re-sign of the same tx. */
export const stableCosignId = (envelope: TxEnvelope): string => hex.encode(sha256(utf8.encode(envelope.bodyHex)))

/**
 * Track an envelope in the registry. Idempotent on the body-derived id.
 * Best-effort — callers run this under `Effect.ignore` so a storage failure
 * never blocks signing.
 *
 * It used to *delete* a quorum-met envelope here, on the reasoning that it would
 * be submitted rather than resumed. That held only while the signature and the
 * submit happened in one call. Origination broke it: the send flow signs, files
 * the envelope, and hands off to the co-sign screen to submit — so for any
 * wallet whose own signature completes the quorum, the record was erased between
 * the two, and a signed transaction arrived at a screen that could not find it.
 *
 * Removal is now only ever explicit, via {@link platformForgetCosign} once the
 * transaction is actually broadcast.
 */
export const persistCosign = (
  storage: Storage,
  groupId: string,
  envelope: TxEnvelope,
): Effect.Effect<void, StorageError> => saveCosign(storage, {id: stableCosignId(envelope), groupId, envelope})

/** {@link persistCosign} bound to the platform storage instance (app runtime). */
export const platformPersistCosign = (groupId: string, envelope: TxEnvelope): Effect.Effect<void, StorageError> =>
  persistCosign(createProfileStorage(), groupId, envelope)

/** Remove an envelope from the platform registry by its body-derived id (post-submit). */
export const platformForgetCosign = (envelope: TxEnvelope): Effect.Effect<void, StorageError> =>
  removeCosign(createProfileStorage(), stableCosignId(envelope))
