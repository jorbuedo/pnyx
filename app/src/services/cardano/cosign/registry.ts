/**
 * Persisted pending-cosign registry: in-flight `TxEnvelope`s awaiting more
 * signatures, keyed by id, stored via the platform storage layer (survives
 * app restarts — an improvement over an in-memory-only registry). Transport of
 * the envelope between devices is file export/import (see the co-sign screen);
 * this registry tracks what's locally pending.
 *
 * @module
 */

import type {Storage, StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {createProfileStorage} from '../../profile/profile-storage'
import {serializeEnvelope} from './envelope'
import type {TxEnvelope} from './types'

const PREFIX = 'cardano.cosign.'
const keyOf = (id: string): string => `${PREFIX}${id}`

/** A stored pending cosign: the envelope + a local id + the wallet group it belongs to. */
export type PendingCosign = {
  readonly id: string
  readonly groupId: string
  readonly envelope: TxEnvelope
}

const parse = (raw: string): PendingCosign | null => {
  try {
    return JSON.parse(raw) as PendingCosign
  } catch (e: unknown) {
    // `null` drops the envelope from the inbox, so a pending co-sign disappears rather than
    // showing as one that cannot be read.
    logger.warn('Pending co-sign record could not be parsed; it will not appear in the inbox', {
      origin: 'cosign/registry',
      error: String(e),
    })
    return null
  }
}

export const saveCosign = (storage: Storage, pending: PendingCosign): Effect.Effect<void, StorageError> =>
  storage.set(
    keyOf(pending.id),
    JSON.stringify({...pending, envelope: JSON.parse(serializeEnvelope(pending.envelope))}),
  )

export const getCosign = (storage: Storage, id: string): Effect.Effect<PendingCosign | null, StorageError> =>
  Effect.map(storage.get(keyOf(id)), (raw) => (raw === null ? null : parse(raw)))

export const removeCosign = (storage: Storage, id: string): Effect.Effect<void, StorageError> =>
  storage.remove(keyOf(id))

export const listCosigns = (
  storage: Storage,
  groupId?: string,
): Effect.Effect<readonly PendingCosign[], StorageError> =>
  Effect.gen(function* () {
    const keys = (yield* storage.keys()).filter((k) => k.startsWith(PREFIX))
    const out: PendingCosign[] = []
    for (const key of keys) {
      const raw = yield* storage.get(key)
      const pending = raw === null ? null : parse(raw)
      if (pending && (groupId === undefined || pending.groupId === groupId)) out.push(pending)
    }
    return out
  })

/** Bind the registry ops to the platform storage instance (app runtime). */
export const platformCosignRegistry = (): {
  readonly save: (p: PendingCosign) => Effect.Effect<void, StorageError>
  readonly get: (id: string) => Effect.Effect<PendingCosign | null, StorageError>
  readonly remove: (id: string) => Effect.Effect<void, StorageError>
  readonly list: (groupId?: string) => Effect.Effect<readonly PendingCosign[], StorageError>
} => {
  const storage = createProfileStorage()
  return {
    save: (p) => saveCosign(storage, p),
    get: (id) => getCosign(storage, id),
    remove: (id) => removeCosign(storage, id),
    list: (groupId) => listCosigns(storage, groupId),
  }
}
