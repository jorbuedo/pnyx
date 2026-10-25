/**
 * The seed an Pnyx identity's avatar is drawn from.
 *
 * **The canonical bytes of `C`, not the `pnyx_id` text.** Multiavatar hashes whatever string it is
 * given, and bech32m is case-insensitive by design: `decodePnyxId` accepts the uppercase form of
 * an id and returns the same `C`, and `pnyxIdEquals` calls the two equal — but seeding on the text
 * would draw them two different faces. The avatar has to be a function of the identity, and the
 * identity is the 32 bytes; the encoding is presentation.
 *
 * Nothing in the app produces a non-canonical id today (`encodePnyxId` only emits lowercase, and
 * `classifyPeerInput` re-encodes pasted or scanned input), so this is about not depending on that
 * remaining true at every future call site.
 *
 * There is no network anywhere in this: an id names a person, not a chain, and `C` is the same on
 * every deployment. That is what makes the avatar a user picks at onboarding the avatar they still
 * have after the preprod→mainnet migration.
 *
 * @module
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {logger} from '../logger'

/**
 * `null` for anything that is not an `pnyx_id`, so the caller renders its placeholder.
 *
 * Deliberately not "seed from the raw string instead": an undecodable value has no `C`, and drawing
 * a face for it would put an identity-shaped badge on something that is not an identity. Callers
 * that legitimately hold a pseudonym (`AuthorAvatar`) already branch before reaching here.
 */
export const identityAvatarSeed = (pnyxId: string): string | null => {
  try {
    return hex.encode(decodePnyxId(pnyxId).identity)
  } catch (e: unknown) {
    // `null` renders no avatar, which is also what an identity with none looks like.
    logger.debug('pnyx_id could not be decoded for an avatar seed', {
      origin: 'identity-avatar-seed',
      error: String(e),
    })
    return null
  }
}
