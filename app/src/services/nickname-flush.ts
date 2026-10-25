/**
 * Complete a nickname whose row write has not landed yet.
 *
 * **The background half of the onboarding nickname step.** Onboarding records the chosen name and
 * moves on ({@link module:./nickname-pending}); this is what finishes it, and it can run unprompted
 * because the only secret it needs comes from the session rather than the vault — `identitySk` is
 * derived from `forumRoot`, and `setPrimaryName` carries no unshielded input to sign. The permit
 * paths are the ones that need a biometric prompt, and a nickname has no permit.
 *
 * ⚠️ **Not a queue and not a worker.** It is a function that is safe to call whenever a session
 * exists, and it answers what it did so the caller can log it. Making it a background task with its
 * own schedule would add a second thing to reason about for a write that takes one transaction.
 *
 * @module
 */

import {identityCommitmentOf, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {logger} from '../logger'
import {identityContractAddressFor} from './identity-contract'
import {clearPendingNickname, countPendingAttempt, MAX_FLUSH_ATTEMPTS, readPendingNickname} from './nickname-pending'
import {writePrimaryName} from './primary-name-write'

const ORIGIN = 'nickname-flush'

/** One hour, matching what the claim chain uses: an absolute expiry, never a duration. */
const TTL_SECS = 3600

export type FlushOutcome =
  /** Nothing was owed. The common case, and not worth a log above `debug`. */
  | 'nothing-pending'
  /** The row now names it, and the record is cleared. */
  | 'written'
  /** It did not land. The record is kept, with one more attempt counted against it. */
  | 'retry-later'
  /** The attempt bound is spent. The record is kept so the ID screen can still offer to finish it. */
  | 'gave-up'
  /** No usable session or no derivable contract — nothing was attempted, nothing was counted. */
  | 'not-ready'

/**
 * Write any pending nickname to `identity(C).primaryName`.
 *
 * ⚠️ **Every outcome logs, including success.** A flush that writes nothing and a flush that never
 * ran look identical from the outside, and that ambiguity has cost this project a debugging session
 * before. `nothing-pending` logs at `debug` because it is the steady state; everything else is a
 * fact worth finding in a log.
 */
export const flushPendingNickname = async (params: {
  readonly forumRoot: Uint8Array
  readonly network: string
}): Promise<FlushOutcome> => {
  const pending = await readPendingNickname()
  if (pending === undefined) {
    logger.debug('no nickname is pending', {origin: ORIGIN})
    return 'nothing-pending'
  }

  // ⚠️ Checked before attempting, not after: a name the chain keeps refusing should stop costing a
  // sponsored relay on every foreground. The record is kept either way — it is what tells the ID
  // screen there is something left to finish.
  if (pending.attempts >= MAX_FLUSH_ATTEMPTS) {
    logger.warn('a pending nickname has used its attempts; leaving it for the user to finish', {
      origin: ORIGIN,
      nickname: pending.display,
      attempts: pending.attempts,
    })
    return 'gave-up'
  }

  const identitySk = identitySkFromForumRoot(params.forumRoot)
  const contractAddress = await identityContractAddressFor(identityCommitmentOf(identitySk)).catch((error: unknown) => {
    logger.warn('a pending nickname has no derivable identity contract', {origin: ORIGIN, error: String(error)})
    return undefined
  })
  // ⚠️ No attempt counted: nothing was tried, so this must not burn the bound. A device that is
  // briefly unable to derive an address would otherwise spend all five attempts without one reaching
  // the chain.
  if (contractAddress === undefined) return 'not-ready'

  const written = await writePrimaryName({
    display: pending.display,
    inputs: {
      identitySk,
      contractAddress,
      networkId: params.network,
      expiresAtSecs: Math.floor(Date.now() / 1000) + TTL_SECS,
    },
  })

  if (written.ok) {
    await clearPendingNickname()
    logger.info('a pending nickname landed on the identity row', {origin: ORIGIN, nickname: pending.display})
    return 'written'
  }

  await countPendingAttempt(pending)
  logger.warn('a pending nickname did not land; it stays pending', {
    origin: ORIGIN,
    nickname: pending.display,
    attempt: pending.attempts + 1,
    failure: written.failure.kind,
    reason: written.failure.kind === 'unavailable' ? written.failure.reason : written.failure.detail,
  })
  return 'retry-later'
}
