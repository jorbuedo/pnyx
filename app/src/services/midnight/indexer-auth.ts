/**
 * The indexer credential, and the two ways it is allowed to travel.
 *
 * Midnight's own preprod indexer answers 410, and Blockfrost's replacement needs a key
 * (`docs/CHAIN_ENDPOINTS.md`). It accepts that key **either** as a `project_id` header or as a
 * `?project_id=` query parameter — both measured, including the WebSocket handshake.
 *
 * ⚠️ **The header is the default, because a URL travels.** A URL with the key in it reaches every
 * log line (`dev-fetch` printed one on every request until 2026-10-13), every error string, and —
 * through the connector's `configuration` — every dApp the wallet connects to. A header reaches the
 * one request it is attached to.
 *
 * The query form survives in exactly one place: the WebSocket handshake, where the browser's
 * `WebSocket` cannot set a header at all. That is a platform limit rather than a choice, and the
 * socket URL is never logged or handed out.
 *
 * ⚠️ **The credential is matched by host, not by exact URL.** The socket URL, the probe and the state
 * query are all different URLs on the same indexer, and an API key belongs to a host.
 *
 * Scope: the key configured for this build. A URL arriving from the control plane or a device
 * override still carries whatever credential it was published with — unchanged behaviour, and the
 * reason {@link splitIndexerCredential} tolerates a combined URL rather than rejecting it.
 *
 * @module
 */

import {preprodIndexerOverride, preprodIndexerProjectId} from '../../config/env'

/** Blockfrost's header name, lowercase with an underscore. `Project-Id` is a different header and 403s. */
const PROJECT_ID = 'project_id'

export type IndexerCredential = {
  /** The endpoint with no credential in it, safe to log, store and hand to a dApp. */
  readonly url: string
  /** The key, when the URL carried one. */
  readonly projectId?: string
}

/**
 * Split a `?project_id=` credential off a URL.
 *
 * Tolerates the combined form because that is how the key was first configured, and an env file is
 * not something a release can migrate.
 */
export const splitIndexerCredential = (url: string): IndexerCredential => {
  const cut = url.indexOf('?')
  if (cut === -1) return {url}
  const kept: string[] = []
  let projectId: string | undefined
  for (const pair of url.slice(cut + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq !== -1 && pair.slice(0, eq).toLowerCase() === PROJECT_ID) {
      projectId = pair.slice(eq + 1)
      continue
    }
    if (pair !== '') kept.push(pair)
  }
  const base = url.slice(0, cut)
  const rest = kept.length === 0 ? base : `${base}?${kept.join('&')}`
  return projectId === undefined ? {url: rest} : {url: rest, projectId}
}

/** Host and port, without parsing: `new URL` throws on the loopback forms the local chain uses. */
const hostOf = (url: string): string | undefined => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)
  return match?.[1]?.toLowerCase()
}

/**
 * The credential this build is configured with, as `{host, projectId}` — read once, because the two
 * sources are both build-time.
 *
 * The key may arrive already inside `EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD`, or beside it in
 * `EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD_PROJECT_ID`. The separate variable is preferred: it keeps the
 * URL clean in every place the URL is read, including this module's own input.
 */
const configured = ((): {host: string; projectId: string} | undefined => {
  const raw = preprodIndexerOverride()
  if (raw === undefined || raw.trim() === '') return undefined
  const split = splitIndexerCredential(raw.trim())
  const projectId = preprodIndexerProjectId() ?? split.projectId
  const host = hostOf(split.url)
  if (projectId === undefined || projectId === '' || host === undefined) return undefined
  return {host, projectId}
})()

/**
 * Auth headers for a request to `url` — empty for an indexer that needs no key, like ours on mainnet.
 *
 * Spread into the headers of every indexer request. A transport that forgets gets a 403, which is
 * loud; the alternative (the key in the URL) is quiet and permanent.
 */
export const indexerAuthHeaders = (url: string): Record<string, string> =>
  configured !== undefined && hostOf(url) === configured.host ? {[PROJECT_ID]: configured.projectId} : {}

/**
 * The same URL with the credential as a query parameter — **for a WebSocket handshake only**, where
 * no header can be set. Returns the URL unchanged when the host needs no key, or already carries one.
 */
export const authorizeIndexerWsUrl = (url: string): string => {
  if (configured === undefined || hostOf(url) !== configured.host) return url
  if (splitIndexerCredential(url).projectId !== undefined) return url
  return `${url}${url.includes('?') ? '&' : '?'}${PROJECT_ID}=${encodeURIComponent(configured.projectId)}`
}
