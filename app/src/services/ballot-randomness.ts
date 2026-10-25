/**
 * The randomness a vote commits under, kept between the two legs of a ballot.
 *
 * `proposal.compact` is commit-reveal. `castVote` inserts
 * `persistentCommit<Uint<8>>(ballotOption(), ballotRand())` and `revealVote` has to reproduce the
 * *same* `ballotRand` to open it:
 *
 *     assert(commits.lookup(an) == persistentCommit<Uint<8>>(option, ballotRand()), …)
 *
 * ⚠️ **Losing this value makes the vote unrevealable, permanently.** The commit stays in the
 * contract, nothing can open it, and the tally never moves. That is why it is written *before* the
 * cast is submitted rather than after it confirms — a crash between building and submitting must not
 * be able to strand a commit whose randomness was never stored.
 *
 * Scoped per proposal contract, since that is what the reveal runs against, and per network, because
 * the same proposal id on another chain is a different contract entirely.
 *
 * **Not backed up.** Plan item 33 is the open question of whether ballot randomness should ride the
 * encrypted backup; until it is answered, a device wipe between casting and revealing loses the vote.
 * Recorded rather than silently accepted.
 *
 * @module
 */

import {hex, randomBytes} from '@pnyx/crypto'
import {Effect} from 'effect'
import {logger} from '../logger'
import {storage} from '../platform/storage'

const ORIGIN = 'ballot-randomness'

/** 32 bytes, matching the `Bytes<32>` the witness returns. */
const RAND_BYTES = 32

const keyFor = (network: string, proposalAddress: string): string => `pnyx:ballot:${network}:${proposalAddress}`

/**
 * The randomness this device committed under for `proposalAddress`, minting one on first use.
 *
 * Idempotent on purpose: a retried cast must commit under the *same* randomness, or the second
 * commit opens under a value the first one did not use.
 */
export const ballotRandomnessFor = async (network: string, proposalAddress: string): Promise<Uint8Array> => {
  const key = keyFor(network, proposalAddress)
  const held = await storage.get(key)
  if (held !== null) {
    const decoded = hex.decode(held)
    if (decoded._tag === 'Right' && decoded.right.length === RAND_BYTES) return decoded.right
    // Refuse rather than mint a replacement: a stored value we cannot read may still be the one a
    // commit was made under, and overwriting it would strand that commit for good.
    logger.error('stored ballot randomness is unreadable; the existing commit cannot be revealed', {
      origin: ORIGIN,
      proposalAddress,
    })
    throw new Error('this device holds unreadable ballot randomness for that proposal')
  }
  const minted = await Effect.runPromise(randomBytes(RAND_BYTES))
  await storage.set(key, hex.encode(minted))
  logger.debug('minted ballot randomness', {origin: ORIGIN, proposalAddress})
  return minted
}

/**
 * The randomness a reveal must open with, or `undefined` when this device never cast here.
 *
 * Separate from {@link ballotRandomnessFor} because a reveal must never *mint*: fresh randomness
 * would build a proof that fails the commit comparison in-circuit, which is a confusing way to
 * discover that the vote was cast on another device.
 */
export const storedBallotRandomness = async (
  network: string,
  proposalAddress: string,
): Promise<Uint8Array | undefined> => {
  const held = await storage.get(keyFor(network, proposalAddress))
  if (held === null) {
    logger.debug('no ballot randomness stored for this proposal', {origin: ORIGIN, proposalAddress})
    return undefined
  }
  const decoded = hex.decode(held)
  if (decoded._tag !== 'Right' || decoded.right.length !== RAND_BYTES) {
    logger.error('stored ballot randomness is unreadable', {origin: ORIGIN, proposalAddress})
    return undefined
  }
  return decoded.right
}
