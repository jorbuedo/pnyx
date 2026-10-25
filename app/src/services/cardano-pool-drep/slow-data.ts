/**
 * Fetch for slow-changing lists (DReps, stake pools). R2 is the ONLY source.
 *
 * The data worker (services/data-worker) keeps `${dataUrl}/${key}.json` warm on
 * a cron and it is served R2-direct (free, no Worker invocation). The blob is
 * `{updatedAt, data}` where `data` is a field-projected subset of the upstream
 * JSON kept in the upstream's shape — so callers parse `data` exactly as they'd
 * parse a direct upstream response.
 *
 * There is NO direct-upstream fallback. If R2 is unreachable, or `dataUrl` is
 * undefined (a network we don't publish lists for — these features are
 * mainnet-only), this throws and the caller surfaces the picker as unavailable.
 * We never make a per-client third-party call.
 *
 * @module
 */

import type {FetchLike} from './http'

type SlowBlob = {readonly data?: unknown}

/** Fetch a slow list's payload from the R2 blob. Throws on any failure. */
export const fetchSlowData = async (
  dataUrl: string | undefined,
  key: 'dreps' | 'pools',
  fetchImpl: FetchLike,
): Promise<unknown> => {
  if (dataUrl === undefined) throw new Error(`${key} unavailable (no data source for this network)`)
  const r = await fetchImpl(`${dataUrl}/${key}.json`, {headers: {Accept: 'application/json'}})
  if (!r.ok) throw new Error(`${key} r2 ${r.status}`)
  const blob = (await r.json()) as SlowBlob
  if (blob.data === undefined) throw new Error(`${key} r2 malformed`)
  return blob.data
}
