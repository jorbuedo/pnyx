/**
 * Talking to the content service about agent pairings.
 *
 * ⚠️ **The token comes back exactly once**, in the create response. There is no read-back route by
 * design: one would put a live credential behind a session that may be months old. So a caller that
 * drops it has to revoke and issue another — which is why the screen shows it immediately and says so.
 *
 * @module
 */

import {logger} from '../../logger'
import {serviceUrl} from '../pnyx-session'

const ORIGIN = 'mcp-pairing-api'

export type McpPairing = {
  readonly pairingId: string
  readonly subject: string
  readonly label: string
  readonly createdAt: number
  readonly revokedAt: number | null
}

export class McpPairingError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'McpPairingError'
  }
}

const call = async <T>(path: string, token: string, init?: {method: 'POST' | 'DELETE'; body?: unknown}): Promise<T> => {
  const url = `${serviceUrl()}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      ...(init?.body === undefined ? {} : {body: JSON.stringify(init.body)}),
    })
  } catch (error) {
    // Logged as well as thrown: "unreachable" and "refused" look identical on screen otherwise, and
    // that ambiguity cost a debugging session once already.
    logger.warn('mcp pairing request failed to reach the service', {origin: ORIGIN, path, error: String(error)})
    throw new McpPairingError(undefined, `content service unreachable at ${url}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    logger.warn('mcp pairing response was not JSON', {origin: ORIGIN, path, error: String(error)})
    throw new McpPairingError(response.status, `invalid JSON from ${path}`)
  }
  if (!response.ok) {
    const served = (payload as {error?: string}).error ?? `request failed: ${response.status}`
    // ⚠️ **Only the router's own fallthrough means "this deployment does not have that route".** A 404
    // with anything else in the body came from a handler that ran and had a real answer — "no revoked
    // pairing with that id" — and overriding it would report a working deployment as unconfigured.
    //
    // This is exactly what happened the first time `Clear revoked` was pressed against a service that
    // did not yet have the DELETE route: every 404 was rewritten into "this deployment has no agent
    // pairing", on a screen that had just listed seven of them.
    const routeMissing = response.status === 404 && (served === 'not found' || served === `request failed: 404`)
    const message = routeMissing ? missingRouteMessage(path) : served
    logger.warn('mcp pairing request refused', {origin: ORIGIN, path, status: response.status, served})
    throw new McpPairingError(response.status, message)
  }
  return payload as T
}

/**
 * What a route the router does not know means, in the caller's terms.
 *
 * Two different deployments answer identically and need different things said: one has no agent
 * pairing at all, and one is simply older than the app talking to it. The path is what tells them
 * apart — the list route is the one every deployment with pairing has.
 */
const missingRouteMessage = (path: string): string =>
  path === '/mcp/pairings'
    ? `this deployment has no agent pairing (${serviceUrl()}) — it needs the MCP relay binding and a database`
    : `this deployment (${serviceUrl()}) is older than this app and does not serve ${path} yet — it needs redeploying`

export const listPairings = async (sessionToken: string): Promise<readonly McpPairing[]> =>
  (await call<{pairings: McpPairing[]}>('/mcp/pairings', sessionToken)).pairings

export const createPairing = async (
  sessionToken: string,
  label: string,
): Promise<{pairing: McpPairing; token: string}> =>
  call<{pairing: McpPairing; token: string}>('/mcp/pairings', sessionToken, {method: 'POST', body: {label}})

export const revokePairing = async (sessionToken: string, pairingId: string): Promise<void> => {
  await call<{revoked: boolean}>(`/mcp/pairings/${encodeURIComponent(pairingId)}/revoke`, sessionToken, {
    method: 'POST',
  })
}

/**
 * Forget a revoked pairing, so a list of dead rows can be cleared.
 *
 * ⚠️ The service refuses a **live** one: deleting it would stop that agent working, which is a revoke
 * under a different word. Revoke first, then forget.
 */
export const forgetPairing = async (sessionToken: string, pairingId: string): Promise<void> => {
  await call<{forgotten: boolean}>(`/mcp/pairings/${encodeURIComponent(pairingId)}`, sessionToken, {method: 'DELETE'})
}

/** The endpoint an agent is configured with. One per deployment, not per pairing. */
export const agentEndpoint = (): string => `${serviceUrl()}/mcp`

/**
 * What an MCP client should call this wallet, keyed by the identity it belongs to.
 *
 * ⚠️ **Not just `pnyx`.** A client's config is a map keyed by server name, so a person who pairs two
 * Pnyx identities with the same agent writes the second block over the first and silently ends up with
 * one wallet — the *wrong* one, from their point of view, with no error anywhere. The identity is what
 * distinguishes them, so the name carries it.
 *
 * The tail rather than the whole thing: a bech32m `pnyx_id` is far too long to read in a config file,
 * and its last characters are as distinguishing as any other slice for telling apart the two or three
 * wallets one person holds. It is a **label, not an identifier** — nothing looks a wallet up by it.
 */
export const agentServerName = (identity: string | undefined): string => {
  const tail = (identity ?? '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toLowerCase()
  return tail.length === 0 ? 'pnyx' : `pnyx_${tail}`
}

/**
 * The block a user pastes into an MCP client.
 *
 * Given whole rather than as fields to assemble: every client is configured by text on a desktop, and
 * a hand-assembled JSON object is the step where a token loses a character.
 */
export const agentConfigBlock = (token: string, identity?: string): string =>
  JSON.stringify(
    {
      mcpServers: {
        [agentServerName(identity)]: {
          type: 'http',
          url: agentEndpoint(),
          headers: {Authorization: `Bearer ${token}`},
        },
      },
    },
    null,
    2,
  )

/**
 * One string carrying endpoint and token, for the QR.
 *
 * ⚠️ Not the primary path — a desktop has no camera, so text is how this is normally moved. The QR is
 * free (the payload already exists) and is the only path when the agent runs on a second phone or
 * tablet.
 */
export const agentPairingUri = (token: string, identity?: string): string =>
  `pnyx-mcp:${agentEndpoint()}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(agentServerName(identity))}`
