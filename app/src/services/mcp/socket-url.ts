/**
 * Where the MCP host dials.
 *
 * The relay authenticates the wallet's socket exactly like `/realtime` does — a short-lived ticket
 * minted from the session token — so this is the realtime handshake pointed at a different path.
 *
 * ⚠️ **A fresh ticket per attempt, never a reused one.** A ticket lives 60 seconds, so a reconnect
 * after any real outage would present an expired one and be refused, which looks exactly like a
 * permission problem while actually being a stale credential. `realtime/client.ts` learned this first.
 *
 * ⚠️ **A 401 here is not "not now".** The session token this mints from lives an hour and nothing
 * renews it, so once it lapses every attempt is refused identically and retrying can never succeed —
 * which is why the answer distinguishes {@link SocketUrlResult} `expired` from `retry`. Reported as its
 * own outcome rather than as `null`, because the host's backoff is the wrong response to it and
 * "Connecting…" for ever is what the caller showed instead.
 *
 * @module
 */

import {logger} from '../../logger'
import {serviceUrl} from '../pnyx-session'

const ORIGIN = 'mcp-socket-url'

/** Turn a service base URL and a ticket into the relay socket URL. Pure, so the shape is testable. */
export const buildMcpSocketUrl = (base: string, ticket: string): string =>
  `${base.replace(/^http/, 'ws')}/mcp/socket?ticket=${encodeURIComponent(ticket)}`

export type SocketUrlResult =
  /** Dial this. */
  | {readonly kind: 'ready'; readonly url: string}
  /** Not now — the service was unreachable, or refused for a reason another attempt may not hit. */
  | {readonly kind: 'retry'}
  /** The session is over. No number of retries fixes it; only signing in again does. */
  | {readonly kind: 'expired'}

/**
 * Mint a realtime ticket and build the socket URL, or say why one cannot be had.
 *
 * Every path logs: a socket that never opens is otherwise indistinguishable from a relay that has
 * nothing to say.
 */
export const mcpSocketUrl = async (sessionToken: string): Promise<SocketUrlResult> => {
  const base = serviceUrl()
  let response: Response
  try {
    response = await fetch(`${base}/realtime/ticket`, {
      method: 'POST',
      headers: {authorization: `Bearer ${sessionToken}`},
    })
  } catch (error) {
    logger.warn('mcp could not reach the service for a socket ticket', {origin: ORIGIN, error: String(error)})
    return {kind: 'retry'}
  }
  if (response.status === 401) {
    logger.warn('mcp was refused a socket ticket: the session has expired', {origin: ORIGIN, status: 401})
    return {kind: 'expired'}
  }
  if (!response.ok) {
    logger.warn('mcp was refused a socket ticket', {origin: ORIGIN, status: response.status})
    return {kind: 'retry'}
  }
  let ticket: unknown
  try {
    ticket = ((await response.json()) as {ticket?: unknown}).ticket
  } catch (error) {
    logger.warn('mcp ticket response was not JSON', {origin: ORIGIN, error: String(error)})
    return {kind: 'retry'}
  }
  if (typeof ticket !== 'string' || ticket === '') {
    logger.warn('mcp ticket response carried no ticket', {origin: ORIGIN})
    return {kind: 'retry'}
  }
  return {kind: 'ready', url: buildMcpSocketUrl(base, ticket)}
}
