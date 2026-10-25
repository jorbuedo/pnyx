/**
 * Cardano protocol params, resilient to a throttled or offline provider: fetch +
 * persist on success, fall back to the last persisted copy when the fetch fails.
 * Params change per epoch, so a slightly-stale copy is still the right answer for
 * a local read (rendering stored history, sizing an output) — far better than
 * blanking the surface under rate limiting. Fails only when neither the network
 * nor a stored copy can answer; never substitutes made-up values.
 *
 * @module
 */

import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import type {CardanoRail} from './rail'

/** The plan engine's protocol-params shape, derived so we don't depend on its export path. */
export type CardanoParams = Effect.Effect.Success<CardanoRail['protocolParams']>

export class CardanoParamsError extends Data.TaggedError('CardanoParamsError')<{readonly reason: string}> {}

const paramsStorageKey = (networkId: number): string => `@pnyx/cardano-params/${networkId}`

// ProtocolParams are all bigints — tag them for JSON round-trips.
const paramsToJson = (p: CardanoParams): string =>
  JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? {$b: v.toString()} : v))

const paramsFromJson = (s: string): CardanoParams =>
  JSON.parse(s, (_k, v) =>
    v !== null && typeof v === 'object' && typeof (v as {$b?: unknown}).$b === 'string'
      ? BigInt((v as {$b: string}).$b)
      : v,
  ) as CardanoParams

/** Fetch-then-cache protocol params for the rail's network. */
export const resolveCardanoParams = (rail: CardanoRail): Effect.Effect<CardanoParams, CardanoParamsError> => {
  const key = paramsStorageKey(rail.config.networkId)
  const fromStore = Effect.tryPromise({
    try: () => storage.get(key),
    catch: () => new CardanoParamsError({reason: 'protocol params unavailable'}),
  }).pipe(
    Effect.flatMap((s) =>
      s === null
        ? Effect.fail(new CardanoParamsError({reason: 'protocol params unavailable'}))
        : Effect.try({
            try: () => paramsFromJson(s),
            catch: () => new CardanoParamsError({reason: 'protocol params corrupt'}),
          }),
    ),
  )
  return rail.protocolParams.pipe(
    Effect.tap((p) =>
      Effect.sync(
        () =>
          void storage.set(key, paramsToJson(p)).catch((e) => {
            logger.warn('Failed to cache protocol params; the next read hits the provider', {
              origin: 'CardanoParams',
              error: String(e),
            })
          }),
      ),
    ),
    Effect.catchAll((e) => {
      logger.warn('Protocol params fetch failed; falling back to the cached copy', {
        origin: 'CardanoParams',
        error: String(e),
      })
      return fromStore
    }),
  )
}
