/**
 * Which sentence a {@link DmStartFailure} gets.
 *
 * Pure and shared, because two screens now start conversations — the new-DM screen and a thread
 * offering to re-establish a session it cannot open — and these five outcomes are worded differently
 * on purpose: "this build has no chain access" is our problem, "they have never published" is theirs,
 * and "the package did not match their anchor" is a security event. A second copy of the mapping is
 * how one of those three quietly becomes "something went wrong".
 *
 * @module
 */

import type {TranslationKey} from '../i18n/types'
import type {DmStartFailure} from './dm-start'

/** The `forum.dm.*` key for this failure. Total over the union, so a new kind is a type error here. */
export const dmStartFailureKey = (failure: DmStartFailure): TranslationKey => {
  switch (failure.kind) {
    case 'chain-unavailable':
      return 'forum.dm.startChainUnavailable'
    case 'peer-not-published':
      return 'forum.dm.startPeerNotPublished'
    case 'peer-no-key-packages':
      return 'forum.dm.startPeerNoPackages'
    case 'key-package-rejected':
      return 'forum.dm.startKeyPackageRejected'
    // ⚠️ One string for a block and for a closed inbox, because the service answers them
    // identically — a sender must not learn they were blocked specifically. The copy therefore says
    // what is true of both and guesses at neither.
    case 'peer-refuses':
      return 'forum.dm.startPeerRefuses'
    case 'permit-required':
      return 'forum.dm.startPermitRequired'
    // Reached only if a caller renders this arm instead of routing to the notes thread, which is
    // what it is for. Worded as our bug rather than as something about the peer.
    case 'self-conversation':
      return 'forum.dm.startFailed'
    default:
      return 'forum.dm.startFailed'
  }
}
