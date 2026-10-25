/**
 * Dev-only HTTP tracing on React Native. CORS doesn't apply here, so this file carries the thing that
 * does: a record of what the app fetches and how big the answer is.
 *
 * ⚠️ **Why the request is logged before it is sent, not after it returns.** React Native's own network
 * inspector base64-encodes every response body into a Java String to report it to the debugger
 * (`NetworkEventUtil.onDataReceived`). On a large body that allocation is enormous, and on 2026-08-27 a
 * read-only mainnet wallet load reproducibly killed the app with
 * `OutOfMemoryError: Failed to allocate a 137239608 byte allocation` — the same byte count every time,
 * so a deterministic response of about 51 MB. The process dies *while receiving*, so nothing that runs
 * after `await fetch(...)` can ever name the URL: the response handler is never reached. Logging at
 * request time means the last line before the crash is the culprit.
 *
 * That crash is dev-instrumentation-only — a release build has no inspector — but the response is real,
 * and a body that size still has to be parsed by JS on a phone.
 *
 * @module
 */

import {logger} from '../logger'
import {isLocalStreamEndpoint} from '../logger/local-stream-transport'
import {redactUrl} from '../logger/redact-url'

const ORIGIN = 'dev-fetch'

/** Short enough for a log line, and with any credential in the query string removed first. */
const logUrl = (url: string): string => redactUrl(url).slice(0, 300)

/**
 * Big enough to be worth a warning on its own.
 *
 * A response over this is worth knowing about whatever the network inspector does with it: it is
 * seconds of parse time on a mid-range device and, on the dev build, the allocation above.
 */
const LARGE_RESPONSE_BYTES = 4 * 1024 * 1024

const urlOf = (input: unknown): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (typeof input === 'object' && input !== null && 'url' in input) return String((input as {url: unknown}).url)
  return '(unknown url)'
}

const methodOf = (input: unknown, init?: RequestInit): string => {
  if (init?.method !== undefined) return init.method.toUpperCase()
  if (typeof input === 'object' && input !== null && 'method' in input) {
    return String((input as {method: unknown}).method).toUpperCase()
  }
  return 'GET'
}

/**
 * Hosts whose request bodies may be logged.
 *
 * ⚠️ **Allow-list, not a filter.** A body can carry a bearer token, a signed transaction or a
 * challenge response; the point of tracing is to find out what we asked a public indexer for, not to
 * put our own credentials in logcat. Koios takes addresses and hashes, which are already public.
 */
const BODY_LOGGABLE = /(^|\.)koios\.rest$/

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch (error) {
    // An unparseable URL is not fatal here — it only means the body stays unlogged, which is the safe
    // direction. Said out loud because a silent empty host would read as "not an allow-listed host".
    logger.debug('a request url could not be parsed for host matching', {origin: ORIGIN, error: String(error)})
    return ''
  }
}

const bodyPreview = (url: string, init?: RequestInit): Record<string, unknown> => {
  const body = init?.body
  if (typeof body !== 'string') return {}
  const size = {bodyBytes: body.length}
  return BODY_LOGGABLE.test(hostOf(url)) ? {...size, body: body.slice(0, 400)} : size
}

const original = globalThis.fetch
let sequence = 0

// Transparent by construction: same arguments through, same response back, the rejection rethrown. A
// wrapper that changed any of those would be a dev-only difference in behaviour, which is worse than no
// tracing at all.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = urlOf(input)
  // Tracing the log sink would log four lines that ship as the next request. See isLocalStreamEndpoint.
  if (isLocalStreamEndpoint(url)) return original(input as never, init)
  const id = ++sequence
  logger.debug('fetch started', {
    origin: ORIGIN,
    id,
    method: methodOf(input, init),
    url: logUrl(url),
    ...bodyPreview(url, init),
  })
  try {
    const response = await original(input as never, init)
    // `content-length` rather than reading the body: consuming it here would leave the caller an
    // already-read stream. Absent on a chunked response, and absence is reported as such.
    const header = response.headers.get('content-length')
    const bytes = header === null ? null : Number(header)
    if (bytes !== null && Number.isFinite(bytes) && bytes >= LARGE_RESPONSE_BYTES) {
      logger.warn('a very large HTTP response arrived', {
        origin: ORIGIN,
        id,
        megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10,
        status: response.status,
        url: logUrl(url),
      })
    } else {
      logger.debug('fetch finished', {origin: ORIGIN, id, status: response.status, bytes})
    }
    return response
  } catch (error) {
    logger.warn('fetch failed', {origin: ORIGIN, id, url: logUrl(url), error: String(error)})
    throw error
  }
}) as typeof globalThis.fetch

/**
 * The same tracing for `XMLHttpRequest`, because not every request is a `fetch`.
 *
 * ⚠️ **This is the half that mattered.** React Native's `fetch` is a polyfill *over* XHR, so wrapping
 * `fetch` catches only the callers that use it — a library that drives `XMLHttpRequest` directly is
 * invisible to it while still going through the same `NetworkingModule` that base64s the response and
 * dies. On 2026-08-27 that gap cost an hour: every `fetch` the app made during a crashing wallet load
 * measured small, because the ~51 MB response was never a `fetch` at all.
 */
type TracedXhr = XMLHttpRequest & {__traceId?: number; __traceUrl?: string}

const xhrProto = XMLHttpRequest.prototype as XMLHttpRequest & {
  open: XMLHttpRequest['open']
  send: XMLHttpRequest['send']
}
const originalOpen = xhrProto.open
const originalSend = xhrProto.send

xhrProto.open = function open(this: TracedXhr, method: string, requestUrl: string, ...rest: unknown[]) {
  const traced = !isLocalStreamEndpoint(String(requestUrl))
  if (!traced) return (originalOpen as (...args: unknown[]) => void).call(this, method, requestUrl, ...rest)
  this.__traceId = ++sequence
  this.__traceUrl = String(requestUrl)
  logger.debug('xhr opened', {origin: ORIGIN, id: this.__traceId, method, url: logUrl(this.__traceUrl)})
  return (originalOpen as (...args: unknown[]) => void).call(this, method, requestUrl, ...rest)
} as XMLHttpRequest['open']

xhrProto.send = function send(this: TracedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
  const id = this.__traceId
  if (id === undefined) return (originalSend as (...args: unknown[]) => void).call(this, body)
  const url = this.__traceUrl ?? '(unknown url)'
  this.addEventListener('load', () => {
    // `responseText.length` is the decoded size the JS side will hold — the figure worth knowing, and
    // the one `content-length` cannot give for a chunked response.
    let size: number | null = null
    try {
      size = typeof this.responseText === 'string' ? this.responseText.length : null
    } catch (error) {
      // `responseText` throws for a non-text `responseType`. Reported rather than dropped: "no size"
      // and "the size could not be read" are different facts, and this whole module exists because a
      // response nobody could measure killed the app.
      logger.debug('an xhr response size could not be read', {origin: ORIGIN, id, error: String(error)})
      size = null
    }
    if (size !== null && size >= LARGE_RESPONSE_BYTES) {
      logger.warn('a very large XHR response arrived', {
        origin: ORIGIN,
        id,
        megabytes: Math.round((size / 1024 / 1024) * 10) / 10,
        status: this.status,
        url: logUrl(url),
      })
    } else {
      logger.debug('xhr finished', {origin: ORIGIN, id, status: this.status, bytes: size})
    }
  })
  this.addEventListener('error', () =>
    logger.warn('xhr failed', {origin: ORIGIN, id, url: logUrl(url), status: this.status}),
  )
  return (originalSend as (...args: unknown[]) => void).call(this, body)
} as XMLHttpRequest['send']
