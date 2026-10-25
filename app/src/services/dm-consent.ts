/**
 * Driving the consent layer from the device: presenting permits, capturing them, muting, blocking.
 *
 * The rules live on the service (`docs/ABUSE_MITIGATION.md` §5). What is here is the bookkeeping
 * that makes them usable: which permit to present when writing to someone, which id to revoke when
 * muting, and keeping the local mirror in step.
 *
 * ⚠️ **Capturing is not optional.** A permit the service mints and hands back on a first message is
 * the *only* copy — it is stateless, so the service has no record to re-issue from. Dropping it
 * costs the conversation its muteability, and under a peer's `permit` policy costs the ability to
 * write to them at all.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {type DmPolicyChoice, dmApi} from './dm-api'
import {
  type DmIssuedInvite,
  type DmPermitBook,
  EMPTY_PERMIT_BOOK,
  forgetConversationPermits,
  forgetIssuedInvite,
  grantedPermitFor,
  heldPermitFor,
  liveIssuedInvites,
  rememberGrantedPermit,
  rememberHeldPermit,
  rememberIssuedInvite,
  setConversationMuted,
} from './dm-permit-book'
import {type DmStoreKey, loadPermitBook, savePermitBook} from './dm-session'

const ORIGIN = 'dm-consent'

/** Read, change, write. Every mutation goes through here so the record is never half-updated. */
const updateBook = (
  storeKey: DmStoreKey,
  change: (book: DmPermitBook) => DmPermitBook,
): Effect.Effect<DmPermitBook, never> =>
  loadPermitBook(storeKey).pipe(
    Effect.map(change),
    Effect.tap((next) => savePermitBook(storeKey, next)),
    Effect.catchAll((error) => {
      // A corrupt or unwritable book is recoverable — the service still enforces everything, and the
      // next capture rebuilds what is missing — but it is never silent: a lost permit reads to the
      // user as "I cannot message this person" with no other trace.
      logger.warn('the permit book could not be updated', {origin: ORIGIN, error: String(error)})
      return Effect.succeed(EMPTY_PERMIT_BOOK)
    }),
  )

/** The permit to present when writing to `peer`, or `undefined` when we hold none. */
export const permitToPresent = (storeKey: DmStoreKey, peer: string): Effect.Effect<string | undefined, never> =>
  loadPermitBook(storeKey).pipe(
    Effect.map((book) => heldPermitFor(book, peer)),
    Effect.catchAll((error) => {
      logger.warn('the permit book could not be read; writing without a permit', {
        origin: ORIGIN,
        error: String(error),
      })
      return Effect.succeed(undefined)
    }),
  )

/**
 * Keep a permit the service just handed us.
 *
 * Called with whatever `permit` came back from a delivery — usually `undefined`, because the service
 * only mints one when we had none and the peer's policy is `open`.
 */
export const capturePermit = (
  storeKey: DmStoreKey,
  peer: string,
  token: string | undefined,
): Effect.Effect<void, never> => {
  if (token === undefined) return Effect.void
  logger.debug('kept a permit issued by a peer', {origin: ORIGIN})
  return updateBook(storeKey, (book) => rememberHeldPermit(book, peer, token)).pipe(Effect.asVoid)
}

/**
 * Keep the id of the permit a peer is reaching us with, read off a delivered row.
 *
 * ⚠️ A *new* id clears the conversation's mute, because the service treats a permit minted after a
 * revocation as a deliberate unmute — so the conversation really is buzzing again and the menu must
 * not still offer "unmute".
 */
export const captureGrantedPermit = (
  storeKey: DmStoreKey,
  convId: string,
  jti: string | undefined,
): Effect.Effect<void, never> => {
  if (jti === undefined) return Effect.void
  return updateBook(storeKey, (book) => rememberGrantedPermit(book, convId, jti)).pipe(Effect.asVoid)
}

export type MuteOutcome = 'muted' | 'unmuted' | 'no-permit'

/**
 * Mute or unmute one conversation.
 *
 * `no-permit` is a real outcome, not a failure: a conversation this device has never seen a permit
 * id for cannot be muted, which happens when every message in it was read and acked on another
 * device. The caller should say so rather than showing a generic error.
 */
export const setConversationMute = (
  sessionToken: string,
  storeKey: DmStoreKey,
  convId: string,
  muted: boolean,
): Effect.Effect<MuteOutcome, never> =>
  Effect.gen(function* () {
    const book = yield* loadPermitBook(storeKey).pipe(
      Effect.catchAll((error) => {
        logger.warn('the permit book could not be read for a mute', {origin: ORIGIN, error: String(error)})
        return Effect.succeed(undefined)
      }),
    )
    const jti = book === undefined ? undefined : grantedPermitFor(book, convId)
    if (jti === undefined) {
      logger.warn('no permit id is known for this conversation, so it cannot be muted', {origin: ORIGIN, convId})
      return 'no-permit' as const
    }
    yield* Effect.tryPromise({
      try: () => (muted ? dmApi.revokePermit(sessionToken, jti) : dmApi.unrevokePermit(sessionToken, jti)),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((error) => {
        logger.warn('the mute could not be applied on the service', {origin: ORIGIN, muted, error: String(error)})
        return Effect.fail(error)
      }),
    )
    yield* updateBook(storeKey, (b) => setConversationMuted(b, convId, muted))
    logger.info(muted ? 'muted a conversation' : 'unmuted a conversation', {origin: ORIGIN})
    return muted ? ('muted' as const) : ('unmuted' as const)
  }).pipe(
    Effect.catchAll(() =>
      // The service refused or was unreachable. The local mirror is deliberately NOT moved: it would
      // then claim a mute that is not in force, which is the one wrong thing to tell someone who
      // asked not to be disturbed.
      Effect.succeed('no-permit' as const),
    ),
  )

/** Forget a deleted conversation's permit id and mute. The held permit stays: it is keyed by peer. */
export const forgetConversationConsent = (storeKey: DmStoreKey, convId: string): Effect.Effect<void, never> =>
  updateBook(storeKey, (book) => forgetConversationPermits(book, convId)).pipe(Effect.asVoid)

/** My policy, or `undefined` when the service could not be reached. */
export const readMyPolicy = (sessionToken: string): Effect.Effect<DmPolicyChoice | undefined, never> =>
  Effect.tryPromise({try: () => dmApi.readPolicy(sessionToken), catch: (cause) => cause}).pipe(
    Effect.catchAll((error) => {
      logger.warn('the message policy could not be read', {origin: ORIGIN, error: String(error)})
      return Effect.succeed(undefined)
    }),
  )

// ── Invitations we issued ──
// Kept here and nowhere else: see `DmIssuedInvite` for why the service cannot help.

/** Keep an invitation this device just minted, so it can be re-shared and withdrawn later. */
export const rememberInvite = (
  storeKey: DmStoreKey,
  invite: DmIssuedInvite,
  nowSeconds: number,
): Effect.Effect<void, never> =>
  updateBook(storeKey, (book) => rememberIssuedInvite(book, invite, nowSeconds)).pipe(Effect.asVoid)

/**
 * The invitations still live, newest first — or `undefined` when the book could not be read.
 *
 * ⚠️ The two are **not** the same answer and must not be collapsed. "You have issued none" invites
 * the user to create one; "we could not read what you issued" means links may be out there with no
 * way to withdraw them, which they need to know rather than be reassured about.
 */
export const listIssuedInvites = (
  storeKey: DmStoreKey,
  nowSeconds: number,
): Effect.Effect<readonly DmIssuedInvite[] | undefined, never> =>
  loadPermitBook(storeKey).pipe(
    Effect.map((book) => liveIssuedInvites(book, nowSeconds)),
    Effect.catchAll((error) => {
      logger.warn('the issued invitations could not be read', {origin: ORIGIN, error: String(error)})
      return Effect.succeed(undefined)
    }),
  )

/**
 * Withdraw an invitation: the service first, this device only once it agreed.
 *
 * ⚠️ The order is the whole point. Forgetting locally on a failed call would leave a live invitation
 * with its id erased from the only place that held it — the exact defect this record exists to fix.
 * A refusal keeps the row so the user can try again.
 */
export const revokeIssuedInvite = (
  sessionToken: string,
  storeKey: DmStoreKey,
  jti: string,
): Effect.Effect<boolean, never> =>
  Effect.tryPromise({try: () => dmApi.revokePermit(sessionToken, jti), catch: (cause) => cause}).pipe(
    Effect.flatMap(() => updateBook(storeKey, (book) => forgetIssuedInvite(book, jti))),
    Effect.as(true),
    Effect.catchAll((error) => {
      logger.warn('an invitation could not be revoked', {origin: ORIGIN, error: String(error)})
      return Effect.succeed(false)
    }),
  )
