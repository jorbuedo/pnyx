/**
 * Making *ourselves* reachable: keeping the KeyPackage pool stocked.
 *
 * The mirror image of `dm-start.ts`. Nobody can start a conversation with us until both halves
 * exist — our anchor on chain so our packages can be verified, and packages in the pool so there is
 * something to claim. A peer hitting either gap sees "they have not enabled DMs" or "refill needed".
 *
 * The anchor half is no longer here: it lives in the identity row, published by
 * {@link module:./identity-publish} at sign-in (`docs/PNYX_IDENTITY_PLAN.md`). That is why this
 * module needs no signing key and can run outside the login path.
 *
 * The one thing that must not be got wrong: **private halves are stored before the public halves
 * are published.** Publish first and a peer could claim a package whose private half we never
 * saved, leaving us in a group we cannot join.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {dmApi} from './dm-api'
import {
  deriveMlsIdentity,
  dmCiphersuite,
  encodeDmKeyPackageRecord,
  encodeMlsKeyPackage,
  makeDmKeyPackage,
} from './dm-mls'
import {deriveDmStoreKey, keyPackageId, listPrivateHalfIds, savePrivateHalf} from './dm-session'

/**
 * Pool sizes. Each package is single-use, so the pool drains at one per incoming conversation.
 * Twenty is a few weeks of ordinary use; refilling under five keeps us reachable without publishing
 * hundreds of packages nobody claims.
 */
const ORIGIN = 'dm-enrol'

const POOL_TARGET = 20
const POOL_REFILL_BELOW = 5

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

export type DmEnrolInput = {
  readonly token: string
  /** Our own `pnyx_id` — the credential identity every published KeyPackage carries. */
  readonly selfIdentity: string
  readonly forumRoot: Uint8Array
  readonly network: string
}

/**
 * Top the pool up if it has run low.
 *
 * Returns how many were added — `0` is the normal steady state, not a failure. Safe to call on every
 * sign-in: publishing is idempotent by content hash, so a retry after a dropped response cannot
 * inflate the pool.
 */
export const ensureKeyPackagePool = async (input: DmEnrolInput): Promise<number> => {
  let available = await dmApi.availableKeyPackages(input.token)

  /**
   * ⚠️ **A device that has lost its private halves has a pool that looks perfectly healthy.**
   *
   * The public halves stay published; only the local halves go. So `available` reads ~20, this
   * function publishes nothing, and every peer who claims one seals a Welcome to a package that can
   * never be opened — an invite that dies on arrival, silently, on *their* side. That is precisely
   * how the conversation this rail was debugged against broke.
   *
   * Holding **zero** halves while the server reports a pool is unambiguous: this device did not
   * publish what is up there, or no longer can use it. Retire the lot and republish.
   *
   * Not reachable for a device that holds any halves at all, so a normal refill never trips it.
   */
  if (available > 0 && (await run(listPrivateHalfIds())).length === 0) {
    const {retired} = await dmApi.retireAllKeyPackages(input.token)
    logger.warn('dm pool: retired packages this device can no longer open', {
      origin: ORIGIN,
      retired,
      available,
    })
    available = 0
  }

  if (available >= POOL_REFILL_BELOW) return 0

  const cs = await run(dmCiphersuite())
  const identity = await run(deriveMlsIdentity(input.forumRoot))
  const storeKey = await run(deriveDmStoreKey(input.forumRoot))

  const encoded: Uint8Array[] = []
  for (let i = 0; i < POOL_TARGET - available; i++) {
    const pair = await run(makeDmKeyPackage(identity, input.selfIdentity, cs))
    const publicBytes = encodeMlsKeyPackage(pair.publicPackage)
    // Private half first: a package published without its private half stored is a group we could
    // be added to and never join.
    await run(savePrivateHalf(storeKey, keyPackageId(publicBytes), encodeDmKeyPackageRecord(pair)))
    encoded.push(publicBytes)
  }
  const result = await dmApi.publishKeyPackages(input.token, encoded)
  return result.added
}
