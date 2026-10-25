/**
 * Last-known Pnyx identity persistence.
 *
 * Only {pnyxId, network} are stored here.
 *
 * ⚠️ **The JWT is stored too now, but not by this module** — see `./session-store`, which reversed
 * the rule this comment used to state ("never the content-service JWT"). The objection was right and
 * still is: a token on disk does outlive the enclave gate that produced it. What changed is the
 * bound. A stored token is usable for half an hour and is then discarded (`./session-restore`), and
 * the seed-derived half of a session is still never written, so a restored session can spend the
 * remainder of that window and sign nothing new.
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import {logger} from '../logger'
import {storage} from '../platform/storage'

const IDENTITY_KEY = 'pnyx:identity'

export type PnyxIdentity = {
  /** The `pnyx_id` this device last signed in as. */
  readonly pnyxId: string
  readonly network: string
}

const parse = (raw: string | null): PnyxIdentity | undefined => {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as Partial<PnyxIdentity>
    if (typeof value.pnyxId === 'string' && typeof value.network === 'string') {
      // ⚠️ Decoded, not just typed. An id written before `pnyx_id` lost its network (`pnyx_id_preprod1…`)
      // still parses as a string, and every consumer that decodes it throws — uncaught, because several
      // of them are `void`-ed. An id this build cannot read is not an identity, so it reads as signed
      // out and the device re-registers, rather than rendering an ID tab that throws on every read.
      try {
        decodePnyxId(value.pnyxId)
      } catch (error) {
        logger.warn('[PnyxIdentity] the stored id is not readable by this build; treating as signed out', {
          origin: 'PnyxIdentity',
          error: String(error),
        })
        return undefined
      }
      return {pnyxId: value.pnyxId, network: value.network}
    }
    logger.debug('[PnyxIdentity] the stored record is not an identity', {origin: 'PnyxIdentity'})
  } catch (error) {
    logger.warn('[PnyxIdentity] the stored identity could not be parsed; treating as signed out', {
      origin: 'PnyxIdentity',
      error: String(error),
    })
  }
  // A record from a build that stored an `mn_addr` reads as signed out rather than as an identity:
  // the two are not interchangeable, and the Id tab must never label an address as an Pnyx id.
  return undefined
}

/** Synchronous read (MMKV) used to seed the provider's initial state. */
export const readPnyxIdentitySync = (): PnyxIdentity | undefined => parse(storage.getSync(IDENTITY_KEY))

export const writePnyxIdentity = async (identity: PnyxIdentity): Promise<void> => {
  try {
    await storage.set(IDENTITY_KEY, JSON.stringify(identity))
  } catch (error) {
    logger.warn('[PnyxIdentity] failed to persist identity', {origin: 'PnyxIdentity', error: String(error)})
  }
}

export const clearPnyxIdentity = async (): Promise<void> => {
  try {
    await storage.remove(IDENTITY_KEY)
  } catch (error) {
    logger.warn('[PnyxIdentity] failed to clear identity', {origin: 'PnyxIdentity', error: String(error)})
  }
}
