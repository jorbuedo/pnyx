/**
 * Owns the single realtime connection for the signed-in identity.
 *
 * One socket per app, not per screen: a phone should hold one connection regardless of how many
 * components care about it, so screens subscribe to this rather than each opening their own.
 *
 * The connection's lifetime is the session's. Signing out closes it; signing in as someone else opens a
 * new one, because the ticket — and therefore the hub — is bound to the identity.
 *
 * @module
 */

import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AppState} from 'react-native'
import {logger} from '../logger'
import {connectRealtime, type RealtimeConnection, type RealtimeListener} from '../services/realtime/client'
import {createListenerRegistry} from '../services/realtime/listener-registry'
import {usePnyxSession} from './PnyxSessionProvider'
import {RealtimeContext, type RealtimeContextValue, useRealtime} from './realtime-context'

const ORIGIN = 'RealtimeProvider'

export function RealtimeProvider({children}: {readonly children: ReactNode}) {
  const {session} = usePnyxSession()
  const connectionRef = useRef<RealtimeConnection | undefined>(undefined)
  /** Subscribers outlive any one connection — see `listener-registry` for the ordering this fixes. */
  const registryRef = useRef(createListenerRegistry())
  const [isConnected, setIsConnected] = useState(false)

  /**
   * Stable for the provider's lifetime: it reads refs rather than closing over the connection, so a
   * consumer's effect is not re-run every time the socket flaps.
   */
  const subscribe = useCallback((listener: RealtimeListener) => {
    if (connectionRef.current === undefined) {
      logger.debug('a realtime subscriber is queued until the connection exists', {origin: ORIGIN})
    }
    return registryRef.current.add(listener)
  }, [])

  /**
   * Come back from the background on a live socket, not a corpse.
   *
   * ⚠️ Android tears down a suspended process's sockets without delivering a `close`, so on resume
   * the client believes it is connected, schedules no reconnect, and every subscriber's catch-up
   * refetch — which only runs on `onOpen` — never happens. A DM that arrived as a push while the app
   * was away then left no unread dot behind it, because nothing re-read anything.
   *
   * Renewing unconditionally is cheap (a ticket plus a socket) and is the only way to be sure: a
   * half-open socket is indistinguishable from a healthy one until something is sent.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return
      connectionRef.current?.renew()
    })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (session === undefined) {
      connectionRef.current?.close()
      connectionRef.current = undefined
      registryRef.current.detachAll()
      setIsConnected(false)
      return
    }
    const connection = connectRealtime(session.token)
    connectionRef.current = connection
    // Whatever subscribed before this point — which, by effect order, is everything below us.
    registryRef.current.attachAll(connection)
    logger.debug('realtime connection created', {origin: ORIGIN, queued: registryRef.current.size()})
    // Tracked through the same subscription screens use, so "connected" cannot drift from what they see.
    const unsubscribe = connection.subscribe({
      onOpen: () => setIsConnected(true),
      onClose: () => setIsConnected(false),
    })
    return () => {
      unsubscribe()
      connection.close()
      connectionRef.current = undefined
      // The connection is gone, so its registrations are too; the listeners stay, to be re-attached
      // to whatever connection replaces it.
      registryRef.current.detachAll()
      setIsConnected(false)
    }
  }, [session])

  const value = useMemo<RealtimeContextValue>(() => ({subscribe, isConnected}), [subscribe, isConnected])

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

// Re-exported from where it has always been imported; it lives in `realtime-context.ts`, which no
// provider imports back. See that module for the cycle it breaks.
export {useRealtime}
