/**
 * A URL safe to put in a log line.
 *
 * ⚠️ **A query string can be a credential.** The preprod Midnight indexer authenticates by
 * `?project_id=…`, so logging the URL of a request to it publishes the key to every transport the
 * logger has. The parameter *names* are kept: "this request carried a project_id" is the diagnostic
 * value, and the value never is.
 *
 * Deliberately string-only, with no `new URL` and no try/catch: this runs inside the logger, where a
 * throw cannot be reported, and a relative URL has a query string to protect too.
 *
 * @module
 */

/** Query parameters whose value is a secret. Matched case-insensitively against the whole name. */
const SECRET_PARAM =
  /(^|[_\-.])(key|apikey|api_key|token|secret|password|passwd|auth|credential|project_id|projectid|sig|signature)([_\-.]|$)/i

export const REDACTED = '<redacted>'

/** The same URL with every secret-shaped query value replaced by {@link REDACTED}. */
export const redactUrl = (url: string): string => {
  const cut = url.indexOf('?')
  if (cut === -1) return url
  const hash = url.indexOf('#', cut)
  const query = hash === -1 ? url.slice(cut + 1) : url.slice(cut + 1, hash)
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) return pair
      return SECRET_PARAM.test(pair.slice(0, eq)) ? `${pair.slice(0, eq)}=${REDACTED}` : pair
    })
    .join('&')
  return `${url.slice(0, cut)}?${redacted}${hash === -1 ? '' : url.slice(hash)}`
}
