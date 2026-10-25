/**
 * Reading a Koios 429, and asking again.
 *
 * Koios refuses with 429 for two unrelated reasons, and only the response body
 * tells them apart — both were provoked against the live endpoint to be sure:
 *
 * - `Exceeded Burst Limit, count was 76` (plus a `deny-reason` header): the tier
 *   limiter, ~100 requests per 10s against *our* credential. The client-side pacer
 *   exists so this never happens; seeing it means something is spending the budget
 *   outside the pacer.
 * - HAProxy's default page, `You have sent too many requests in a given amount of
 *   time.`: an instance shedding load. Koios's own config denies with 429 when a
 *   source IP passes 500 requests per 10s (`http-request deny deny_status 429 if
 *   { sc_http_req_rate(0) gt 500 }` over a `http_req_rate(10s)` stick-table), and
 *   behind the public load balancer that counter is not ours alone. This is the one
 *   a device was refused by while ~20 calls into a paced walk — nothing we sent
 *   earned it, and asking again is the whole remedy.
 *
 * So every 429 is retried, briefly and a bounded number of times. What this cannot
 * detect is a tier's *daily* quota running out (5,000 requests on the public tier,
 * 50,000 on the authenticated one) — that refusal's shape is unknown to us, and a
 * retry would be pointless for hours. Bounding the attempts is what keeps that case
 * from turning into a hammer loop: it fails, loudly, three attempts later.
 *
 * @module
 */

import {Effect, Schedule} from 'effect'

export type KoiosRefusalKind =
  /** The tier limiter: our own credential over its ~100-per-10s window. */
  | 'burst'
  /** An instance shedding load by source IP — not necessarily our traffic. */
  | 'shed'
  /** A 429 whose body we have never seen. Still a "come back later". */
  | 'unclassified'

export type KoiosRefusal = {
  readonly kind: KoiosRefusalKind
  /** First line of the body, for the log. Bodies are HTML pages or one-liners. */
  readonly detail: string
}

/**
 * The refusal a provider error's message describes, or `null` when it is not one.
 *
 * The message is what the Koios adapter throws: `` `${status} ${body}` ``. Anything
 * that is not a 429 returns `null` — a 400 or a 503 is a different conversation and
 * must not be retried as if waiting would fix it.
 */
export const classifyKoiosRefusal = (message: string): KoiosRefusal | null => {
  const match = /^\s*429\b(.*)$/s.exec(message)
  if (match === null) return null
  const body = (match[1] ?? '').trim()
  const detail = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (/exceeded burst limit/i.test(body)) return {kind: 'burst', detail}
  if (/too many requests/i.test(body)) return {kind: 'shed', detail}
  return {kind: 'unclassified', detail}
}

/**
 * Waits before re-asking: 800ms, 1.6s, 3.2s, jittered.
 *
 * Jittered because a refusal arrives at every caller at once — a shed hits whatever
 * we had in flight — and unjittered backoff would re-send them as one burst.
 */
const BACKOFF = Schedule.intersect(Schedule.jittered(Schedule.exponential('800 millis', 2)), Schedule.recurs(3))

/**
 * Retry `effect` while it fails with a Koios 429, leaving every other failure alone.
 *
 * `reasonOf` reads the message out of the error type at hand (`ProviderError.reason`,
 * `Error.message`, …). `onRefusal` is where the caller logs: a retry that is invisible
 * is a wallet that just looks slow.
 */
export const retryKoiosRefusal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  opts: {
    readonly reasonOf: (error: E) => string
    readonly onRefusal?: (refusal: KoiosRefusal) => void
  },
): Effect.Effect<A, E, R> => {
  const {reasonOf, onRefusal} = opts
  const watched =
    onRefusal === undefined
      ? effect
      : Effect.tapError(effect, (error: E) =>
          Effect.sync(() => {
            const refusal = classifyKoiosRefusal(reasonOf(error))
            if (refusal !== null) onRefusal(refusal)
          }),
        )
  return Effect.retry(watched, {
    schedule: BACKOFF,
    while: (error: E) => classifyKoiosRefusal(reasonOf(error)) !== null,
  })
}
