/**
 * The realtime socket client: one connection per signed-in identity, delivering invalidation signals.
 *
 * The socket says *something changed*; the app refetches through the endpoints it already uses. So this
 * module owns no view state and caches nothing — it is a subscription bus over a connection that may
 * come and go.
 *
 * **Refetch-on-connect is the catch-up.** Every `onOpen` subscriber is expected to refetch, which is
 * what makes a missed signal harmless and why there is no cursor or replay here (see the service's
 * `realtime.ts`). A reconnect is therefore not an error path to paper over; it is the resync.
 *
 * @module
 */

import {logger} from '../../logger'
import {serviceUrl} from '../pnyx-session'
import {reconnectDelayMs, shouldReconnect} from './backoff'

const ORIGIN = 'realtime'

/**
 * How often the client sends `ping`.
 *
 * ⚠️ **Not for the service.** The hub hibernates and times nothing out; this is for everything in
 * between, where a carrier NAT drops an idle mapping in well under a minute. That is why the socket
 * flapped every 30–90 s on a real device and never once on the emulator, which has no NAT to lose.
 * The hub answers from the runtime's auto-responder, so a heartbeat costs no wake.
 */
const HEARTBEAT_INTERVAL_MS = 25_000

/**
 * Ticks with no `pong` before the socket is treated as dead and replaced.
 *
 * ⚠️ **Counted only once a `pong` has come back on this connection.** A service that does not answer
 * must look quiet, not broken — otherwise a deploy older than the heartbeat would have every client
 * renewing on a timer forever, which is a worse flap than the one this fixes.
 */
const MISSED_PONGS_BEFORE_RENEW = 2

/** Mirrors the service's `RealtimeEvent`. Unknown kinds are dropped by {@link decodeEvent}. */
export type RealtimeEvent =
  | {readonly kind: 'community-changed'; readonly communityId: string}
  | {readonly kind: 'proposal-changed'; readonly communityId: string; readonly proposalId: string}
  | {readonly kind: 'chain-settled'; readonly communityId: string}
  | {readonly kind: 'dm-waiting'}

/**
 * Parse a frame. `undefined` for anything unrecognised — a client that treated an unknown kind as "some
 * refetch" would fire whole-view reloads for screens it does not have, and the service can ship a new
 * kind long before an app update reaches a store.
 */
export const decodeEvent = (raw: string): RealtimeEvent | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: unknown) {
    // `undefined` here is indistinguishable from "a kind this build does not know", which is the
    // ordinary forward-compatible case — but a frame that is not JSON at all is a broken peer.
    logger.warn('Realtime frame was not JSON; dropping it', {
      origin: 'realtime/client',
      error: String(e),
    })
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const {v, event} = parsed as {v?: unknown; event?: unknown}
  if (v !== 1 || typeof event !== 'object' || event === null) return undefined
  const e = event as {kind?: unknown; communityId?: unknown; proposalId?: unknown}
  const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined)
  switch (e.kind) {
    case 'dm-waiting':
      return {kind: 'dm-waiting'}
    case 'community-changed':
    case 'chain-settled': {
      const communityId = str(e.communityId)
      return communityId === undefined ? undefined : {kind: e.kind, communityId}
    }
    case 'proposal-changed': {
      const communityId = str(e.communityId)
      const proposalId = str(e.proposalId)
      return communityId === undefined || proposalId === undefined
        ? undefined
        : {kind: 'proposal-changed', communityId, proposalId}
    }
    default:
      return undefined
  }
}

export type RealtimeListener = {
  /** A signal arrived. */
  readonly onEvent?: (event: RealtimeEvent) => void
  /** The socket (re)connected — refetch whatever this subscriber renders. */
  readonly onOpen?: () => void
  /**
   * The socket went away (a reconnect is already scheduled unless it closed permanently).
   *
   * Exists so a subscriber can *know* it is disconnected. Without it "connected" latches true on the
   * first open and never returns, which makes it useless for anything that has to behave differently
   * while the signal stream is down.
   */
  readonly onClose?: () => void
}

type Deps = {
  /** Injected for tests; defaults to the platform WebSocket. */
  readonly makeSocket?: (url: string) => WebSocket
  readonly fetchTicket?: (token: string) => Promise<string | null>
  readonly setTimeoutImpl?: typeof setTimeout
  readonly setIntervalImpl?: typeof setInterval
  readonly clearIntervalImpl?: typeof clearInterval
  readonly random?: () => number
}

const defaultFetchTicket = async (token: string): Promise<string | null> => {
  try {
    const res = await fetch(`${serviceUrl()}/realtime/ticket`, {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
    })
    if (!res.ok) return null
    const {ticket} = (await res.json()) as {ticket?: string}
    return ticket ?? null
  } catch (e: unknown) {
    // `null` also means "the service said no", and the caller cannot connect either way — but
    // only one of the two is our own network failing.
    logger.warn('Realtime ticket request failed; the socket will not be opened', {
      origin: 'realtime/client',
      error: String(e),
    })
    return null
  }
}

export type RealtimeConnection = {
  subscribe(listener: RealtimeListener): () => void
  /** Tear down and stop reconnecting. */
  close(): void
  /**
   * Drop the current socket and open a new one, whatever state this one claims to be in.
   *
   * ⚠️ **For a socket that is dead without saying so.** A process suspended in the background comes
   * back holding a connection the OS has already dismantled: no `close` event ever fires, so `open`
   * stays true, no reconnect is scheduled, and no `onOpen` reaches the subscribers whose refetch *is*
   * the catch-up. The app then looks connected and receives nothing — which is how a DM that arrived
   * as a push left no unread dot behind it.
   */
  renew(): void
  /** For tests and diagnostics. */
  isOpen(): boolean
}

/**
 * Open a realtime connection for a session, reconnecting until closed.
 *
 * A fresh ticket is fetched per attempt rather than reused: it lives 60 seconds, so a reconnect after
 * any real outage would present an expired one and be refused — which would look exactly like a
 * permission problem while actually being a stale credential.
 */
export const connectRealtime = (sessionToken: string, deps: Deps = {}): RealtimeConnection => {
  const makeSocket = deps.makeSocket ?? ((url: string) => new WebSocket(url))
  const fetchTicket = deps.fetchTicket ?? defaultFetchTicket
  const schedule = deps.setTimeoutImpl ?? setTimeout
  const setPeriodic = deps.setIntervalImpl ?? setInterval
  const clearPeriodic = deps.clearIntervalImpl ?? clearInterval
  const listeners = new Set<RealtimeListener>()

  let socket: WebSocket | undefined
  let attempt = 0
  let closed = false
  let open = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let pongSeen = false
  let unanswered = 0

  const emitOpen = () => {
    for (const listener of listeners) listener.onOpen?.()
  }
  const emitEvent = (event: RealtimeEvent) => {
    for (const listener of listeners) listener.onEvent?.(event)
  }
  const emitClose = () => {
    for (const listener of listeners) listener.onClose?.()
  }

  const scheduleReconnect = () => {
    if (closed) return
    attempt += 1
    const delay = reconnectDelayMs(attempt, deps.random)
    logger.debug('realtime reconnecting', {origin: ORIGIN, attempt, delay})
    schedule(() => void connect(), delay)
  }

  const stopHeartbeat = () => {
    if (heartbeat === undefined) return
    clearPeriodic(heartbeat)
    heartbeat = undefined
  }

  /**
   * Drop the current socket and open a new one. See {@link RealtimeConnection.renew}, which exposes
   * this; the heartbeat calls it directly for a socket that stopped answering.
   */
  const renewConnection = (why: string) => {
    if (closed) return
    const current = socket
    socket = undefined
    const wasOpen = open
    open = false
    stopHeartbeat()
    if (current !== undefined) {
      // Detach first: this close is deliberate, and letting the handler run would schedule a
      // *second* connect on top of the one below.
      current.onclose = null
      current.onmessage = null
      current.onerror = null
      try {
        current.close()
      } catch (error) {
        logger.debug('realtime renew: closing the old socket threw', {origin: ORIGIN, error: String(error)})
      }
    }
    if (wasOpen) emitClose()
    attempt = 0
    logger.debug('realtime renewing the connection', {origin: ORIGIN, wasOpen, why})
    void connect()
  }

  const startHeartbeat = (ws: WebSocket) => {
    stopHeartbeat()
    pongSeen = false
    unanswered = 0
    heartbeat = setPeriodic(() => {
      if (pongSeen && unanswered >= MISSED_PONGS_BEFORE_RENEW) {
        logger.warn('realtime heartbeat went unanswered', {origin: ORIGIN, unanswered})
        renewConnection('heartbeat unanswered')
        return
      }
      try {
        ws.send('ping')
        unanswered += 1
      } catch (error) {
        // A send that throws is a socket already gone; the close event may never come.
        logger.warn('realtime heartbeat could not be sent', {origin: ORIGIN, error: String(error)})
        renewConnection('heartbeat send failed')
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  const connect = async (): Promise<void> => {
    if (closed) return
    const ticket = await fetchTicket(sessionToken)
    if (ticket === null) {
      // Could not even get a ticket — the service is unreachable or the session is gone. Same backoff:
      // distinguishing them here would mean guessing, and the next attempt finds out for free.
      scheduleReconnect()
      return
    }
    if (closed) return

    const url = `${serviceUrl().replace(/^http/, 'ws')}/realtime?ticket=${encodeURIComponent(ticket)}`
    let ws: WebSocket
    try {
      ws = makeSocket(url)
    } catch (error) {
      logger.warn('realtime socket could not be created', {origin: ORIGIN, error: String(error)})
      scheduleReconnect()
      return
    }
    socket = ws

    ws.onopen = () => {
      open = true
      attempt = 0
      logger.debug('realtime connected', {origin: ORIGIN})
      startHeartbeat(ws)
      // Every subscriber refetches here. This is the catch-up: anything that happened while the socket
      // was down is picked up by the same read the screen would do anyway.
      emitOpen()
    }
    ws.onmessage = (message: {data?: unknown}) => {
      if (typeof message.data !== 'string') return
      if (message.data === 'pong') {
        // The only frame that is an answer rather than a signal: it is what arms the watchdog and
        // what clears it.
        pongSeen = true
        unanswered = 0
        return
      }
      const event = decodeEvent(message.data)
      if (event === undefined) {
        logger.debug('realtime dropped an unrecognised frame', {origin: ORIGIN})
        return
      }
      emitEvent(event)
    }
    ws.onerror = () => {
      // Errors arrive before a close on every platform we run on; the close handler owns the retry so
      // a single failure does not schedule two reconnects.
      logger.debug('realtime socket error', {origin: ORIGIN})
    }
    ws.onclose = (event: {code?: number}) => {
      const wasOpen = open
      open = false
      socket = undefined
      stopHeartbeat()
      if (wasOpen) emitClose()
      const code = event.code ?? 1006
      if (!shouldReconnect(code)) {
        logger.warn('realtime closed permanently', {origin: ORIGIN, code})
        closed = true
        return
      }
      scheduleReconnect()
    }
  }

  void connect()

  return {
    renew: () => renewConnection('caller asked'),
    subscribe: (listener) => {
      listeners.add(listener)
      // A subscriber that arrives after the socket is already open still needs its first read.
      if (open) listener.onOpen?.()
      return () => listeners.delete(listener)
    },
    close: () => {
      closed = true
      listeners.clear()
      stopHeartbeat()
      try {
        socket?.close(1000)
      } catch (e: unknown) {
        logger.debug('Realtime socket close threw; it was already gone', {
          origin: 'realtime/client',
          error: String(e),
        })
      }
      socket = undefined
      open = false
    },
    isOpen: () => open,
  }
}
