/**
 * Which endpoint URL wins, and whether a typed one is usable at all.
 *
 * Three sources can name an endpoint, and they are tried in this order:
 *
 * | source    | set by                                   | survives |
 * |-----------|------------------------------------------|----------|
 * | `user`    | Settings › Midnight endpoints            | until cleared |
 * | `remote`  | the control plane's `networks` matrix     | until the next fetch |
 * | `builtin` | the table compiled into the build         | forever |
 *
 * The user wins over the control plane deliberately: the person holding the device is the one who
 * can see that an endpoint is down, and a wallet that cannot be pointed somewhere else is a wallet
 * that waits for a release. The control plane wins over the build for the same reason at fleet
 * scale, which is the case that produced this module: an endpoint we had compiled in was
 * decommissioned, and every install kept calling it.
 *
 * Validation is strict about scheme because the failure it prevents is silent. A `wss://` indexer
 * or an `https://` websocket does not error at configuration time; it errors much later, inside a
 * sync, as a connection fault indistinguishable from the network being down.
 *
 * @module
 */

import {logger} from '../logger'

/** The three endpoints a Midnight network is reached through. */
export type EndpointKind = 'indexer' | 'node' | 'nodeWs'

/** Where the winning value came from. `none` means no source named one. */
export type EndpointSource = 'user' | 'remote' | 'builtin' | 'none'

export type ResolvedEndpoint = {
  readonly value: string | null
  readonly source: EndpointSource
}

/** Why a typed endpoint was rejected. Each maps to a sentence under `settings.endpoints.invalid.*`. */
export type EndpointRejection = 'malformed' | 'scheme' | 'noHost'

export type EndpointValidation =
  | {readonly ok: true; readonly url: string}
  | {readonly ok: false; readonly reason: EndpointRejection}

/** Schemes each kind accepts. A websocket endpoint that is not `ws`/`wss` cannot subscribe. */
const SCHEMES: Record<EndpointKind, readonly string[]> = {
  indexer: ['http:', 'https:'],
  node: ['http:', 'https:'],
  nodeWs: ['ws:', 'wss:'],
}

/**
 * Validate a URL a person typed.
 *
 * Surrounding whitespace is dropped: a pasted URL routinely carries it, and unlike a password it
 * cannot be part of the value. An empty string is *not* an error here — it is how the UI says
 * "clear this override" — so callers check for empty before validating.
 */
export const validateEndpoint = (kind: EndpointKind, raw: string): EndpointValidation => {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    // Expected while someone is still typing, so `debug` rather than `warn` — but never nothing:
    // "rejected because it does not parse" and "rejected because of its scheme" are different facts.
    logger.debug('endpoint rejected: does not parse as a URL', {kind, error: String(error)})
    return {ok: false, reason: 'malformed'}
  }
  if (!SCHEMES[kind].includes(parsed.protocol)) return {ok: false, reason: 'scheme'}
  if (parsed.hostname === '') return {ok: false, reason: 'noHost'}
  return {ok: true, url: trimmed}
}

/**
 * Pick the winning endpoint from the three sources.
 *
 * A blank string at any level is treated as absent rather than as an empty endpoint, so clearing a
 * field in the UI falls through to the next source instead of pointing the app at nothing.
 */
export const resolveEndpoint = (sources: {
  readonly user?: string | null | undefined
  readonly remote?: string | null | undefined
  readonly builtin?: string | null | undefined
}): ResolvedEndpoint => {
  const user = sources.user?.trim()
  if (user !== undefined && user !== '') return {value: user, source: 'user'}
  const remote = sources.remote?.trim()
  if (remote !== undefined && remote !== '') return {value: remote, source: 'remote'}
  const builtin = sources.builtin?.trim()
  if (builtin !== undefined && builtin !== '') return {value: builtin, source: 'builtin'}
  return {value: null, source: 'none'}
}

/**
 * The websocket form of an indexer's HTTP URL, as the Midnight indexer publishes it.
 *
 * Kept here rather than inlined at the call sites so a custom indexer gets the same derivation as
 * the built-in one.
 *
 * WARNING: `/ws` belongs before the query string, not after it. A provider that authenticates with
 * a query parameter (Blockfrost wants `?project_id=…`, its documented form for clients that cannot
 * set a header) turns naive concatenation into `…/api/v0?project_id=XXX/ws`, which the server
 * refuses. Measured against Blockfrost: `/api/v0/ws?project_id=…` opens, the other does not.
 */
export const indexerWebsocketUrl = (httpUrl: string): string => {
  const wsUrl = httpUrl.replace(/^http/, 'ws')
  let parsed: URL
  try {
    parsed = new URL(wsUrl)
  } catch (error) {
    // The UI validates before storing, but the built-in table and the control plane reach here too.
    // Fall back to the plain suffix rather than throwing inside a sync, and say which happened.
    logger.warn('indexer URL does not parse; deriving its websocket by suffix', {error: String(error)})
    return `${wsUrl.replace(/\/+$/, '')}/ws`
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/ws`
  return parsed.toString()
}
