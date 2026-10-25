/**
 * Keeps our MLS KeyPackage pool stocked, and accepts incoming conversation invites.
 *
 * Deliberately *not* inside `signInWithMidnight`. Generating packages needs only the
 * `forumRoot`-derived MLS identity, which the session carries, and it is the slow half — up to
 * twenty KeyPackages, each a keygen — so running it in the login path would make sign-in visibly
 * worse for no benefit.
 *
 * Failure is logged and dropped: an empty pool means peers see "out of one-time keys" and retry
 * later, which is a degraded feature, not a broken session.
 *
 * @module
 */

import {useEffect} from 'react'
import {logger} from '../logger'
// The context, not the provider: the provider's own chain imports this hook back.
import {useRealtime} from '../providers/realtime-context'
import {ensureKeyPackagePool} from '../services/dm-enrol'
import {acceptPendingInvites} from '../services/dm-invites'
import type {PnyxSession} from '../services/pnyx-session'

export const useDmKeyPackagePool = (session: PnyxSession | undefined): void => {
  useEffect(() => {
    // `forumRoot` is optional on the session; with no root there is no MLS identity to sign
    // packages with, so there is nothing to publish.
    if (session?.forumRoot === undefined) return
    let cancelled = false
    void (async () => {
      try {
        const added = await ensureKeyPackagePool({
          token: session.token,
          selfIdentity: session.identity,
          forumRoot: session.forumRoot as Uint8Array,
          network: session.network,
        })
        if (!cancelled && added > 0) {
          logger.info('dm key package pool topped up', {origin: 'useDmKeyPackagePool', added})
        }
      } catch (error) {
        logger.warn('dm key package pool top-up failed', {origin: 'useDmKeyPackagePool', error: String(error)})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session])
}

/**
 * Accepts incoming invites, so a peer who adds us actually gets a conversation.
 *
 * Driven by the realtime socket: a `dm-waiting` signal means something is queued for us, and every
 * (re)connect drains whatever accumulated while we were away. That reconnect drain is what replaces
 * the old 5s tick — `takeWelcomes` is destructive, so an invite nobody collects sits on the server, and
 * a socket that was down must not turn into a lost invitation.
 *
 * **No interval.** A 60 s poll is 1,440 Worker invocations per signed-in user per day whether or not
 * anything arrived, which on a request budget is the dominant cost of an idle app. It also duplicates
 * the reconnect loop: a socket that cannot connect retries at ≤30 s and drains on the next success, so a
 * timer buys nothing the client is not already doing for free.
 */
export const useDmInvites = (session: PnyxSession | undefined): void => {
  const {subscribe} = useRealtime()
  useEffect(() => {
    if (session?.forumRoot === undefined) return
    const root = session.forumRoot
    let stopped = false
    const drain = async (): Promise<void> => {
      if (stopped) return
      const joined = await acceptPendingInvites({token: session.token, forumRoot: root, network: session.network})
      if (joined.length > 0 && !stopped) {
        logger.info('dm invites accepted', {origin: 'useDmInvites', count: joined.length})
      }
    }
    // On mount (sign-in), on every (re)connect, and on a signal. The reconnect drain is what makes a
    // socket outage a delay rather than a lost invitation — `takeWelcomes` is destructive, so an invite
    // nobody collects stays queued on the server until someone does.
    void drain()
    const unsubscribe = subscribe({
      onOpen: () => {
        // A drain that finds nothing logs nothing, so without this a socket that never delivers looks
        // exactly like one whose every reconnect found an empty queue.
        logger.debug('draining invites on a realtime open', {origin: 'useDmInvites'})
        void drain()
      },
      onEvent: (event) => {
        if (event.kind === 'dm-waiting') void drain()
      },
    })
    return () => {
      stopped = true
      unsubscribe()
    }
  }, [session, subscribe])
}
