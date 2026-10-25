/**
 * Koios requests the provider has no method for.
 *
 * Two call sites reach Koios directly, because the adapter exposes nothing for what
 * they need: CIP-26 asset metadata (`/asset_info`, projected to drop the base64
 * logos) and ADA Handle resolution (`/asset_nft_address`). Going around the adapter
 * also went around its pacing budget and its bearer token, which is two problems:
 * the requests were unaccounted for — so a volume report would under-state exactly
 * the traffic hardest to see — and, without the token, they were charged to the
 * anonymous per-IP bucket, a fifth the size of the authenticated one.
 *
 * They share the server's budget, so they share the client's.
 *
 * @module
 */

import {RequestBudget} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {KOIOS_REQUEST_BUDGET} from './koios-provider'
import {getKoiosToken} from './koios-token'

/**
 * Bearer header for the authenticated tier, if a token is configured.
 *
 * Withheld from a non-https endpoint, exactly as the adapter does — a token on the
 * wire in cleartext is worse than the anonymous tier. Loopback is allowed so a local
 * Koios stands in during development.
 */
export const koiosAuthHeaders = (network: string, baseUrl: string): Record<string, string> => {
  const token = getKoiosToken(network)
  if (token === undefined) return {}
  const secure = /^https:/i.test(baseUrl) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl)
  return secure ? {authorization: `Bearer ${token}`} : {}
}

/**
 * `fetch`, paced and reported like every request the adapter makes.
 *
 * Shaped as the `FetchLike` those call sites already inject, so they keep their test
 * seam and only their default changes.
 */
export const pacedKoiosFetch = async (
  url: string,
  init?: {method?: string; headers?: Record<string, string>; body?: string},
): Promise<Response> => {
  // Idempotent, and here rather than only in the rail: this function can run before any
  // provider has been built, and an unconfigured host is counted without ever being held
  // back — which is the one state that looks metered and is not.
  RequestBudget.configure(url, KOIOS_REQUEST_BUDGET)
  const method = init?.method ?? 'GET'
  const waitedMs = await Effect.runPromise(RequestBudget.acquire(url))
  const sentAt = Date.now()
  const report = (status: number, refusalBody?: string): void =>
    RequestBudget.report({
      host: RequestBudget.hostKey(url),
      path: RequestBudget.requestPath(url),
      method,
      status,
      waitedMs,
      ms: Date.now() - sentAt,
      inWindow: RequestBudget.windowCount(url),
      ...(refusalBody !== undefined ? {refusalBody} : {}),
    })
  const response = await fetch(url, init as RequestInit).catch((e: unknown) => {
    report(0)
    throw e
  })
  // The body is read here only when it is a refusal, and a body can be read once — so
  // the meter reads a clone and the caller still gets an unconsumed response.
  if (!response.ok) {
    let body: string | undefined
    try {
      body = await response.clone().text()
    } catch (e) {
      // Left ABSENT, not empty: an empty body is one the server sent, and a reader that
      // cannot tell them apart will blame the endpoint for our own failure to read it.
      logger.debug('a Koios refusal body could not be read for the meter', {
        origin: 'koios-request',
        status: response.status,
        error: String(e),
      })
    }
    report(response.status, body)
    return response
  }
  report(response.status)
  return response
}
