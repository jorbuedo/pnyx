/**
 * Resolve the network's slot↔time anchor (see `slot-time.ts`), persisted per
 * network.
 *
 * Prefers the stored pair over the network, which is the opposite of how
 * protocol params are resolved and deliberate: params change every epoch, but
 * the slot↔time relation is time-invariant within an era, so a pair captured
 * once stays exactly as correct as one captured now. That makes this at most one
 * `/tip` request per install per network, and none at all on the common path.
 *
 * Fails silently to `null` — a review that cannot date a TTL shows the raw slot,
 * which is what it did before. This is not worth an error surface.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'
import {chainTip} from './chain-tip'
import type {CardanoRail} from './rail'
import type {SlotAnchor} from './slot-time'

const anchorStorageKey = (networkId: number): string => `@pnyx/cardano-slot-anchor/${networkId}`

const parseAnchor = (raw: string): SlotAnchor | null => {
  try {
    const v = JSON.parse(raw) as {slot?: unknown; timeSec?: unknown}
    return typeof v.slot === 'number' && typeof v.timeSec === 'number' && v.slot >= 0 && v.timeSec > 0
      ? {slot: v.slot, timeSec: v.timeSec}
      : null
  } catch (e) {
    logger.warn('Stored slot anchor did not parse; re-reading the tip', {
      origin: 'CardanoSlotAnchor',
      error: String(e),
    })
    return null
  }
}

/**
 * The stored anchor, else one read from the chain tip and stored. `null` when
 * neither can answer — the tip may report a slot without the block time that
 * pairs with it, and half an anchor is not an anchor.
 */
export const resolveCardanoSlotAnchor = (rail: CardanoRail): Effect.Effect<SlotAnchor | null> => {
  const key = anchorStorageKey(rail.config.networkId)
  return Effect.tryPromise({try: () => storage.get(key), catch: (e) => e})
    .pipe(
      Effect.catchAll((e) => {
        logger.warn('Slot-anchor read failed; falling back to the chain tip', {
          origin: 'CardanoSlotAnchor',
          error: String(e),
        })
        return Effect.succeed(null)
      }),
      Effect.map((raw) => (raw === null ? null : parseAnchor(raw))),
    )
    .pipe(
      Effect.flatMap((stored) =>
        stored !== null
          ? Effect.succeed(stored)
          : chainTip(rail.chain).pipe(
              Effect.map((tip): SlotAnchor | null =>
                tip.blockTime === undefined ? null : {slot: tip.slot, timeSec: tip.blockTime},
              ),
              Effect.tap((anchor) =>
                Effect.sync(() => {
                  if (anchor !== null)
                    void storage.set(key, JSON.stringify(anchor)).catch((e) => {
                      logger.warn('Failed to persist the slot anchor; the next read re-fetches the tip', {
                        origin: 'CardanoSlotAnchor',
                        error: String(e),
                      })
                    })
                }),
              ),
              Effect.catchAll((e) => {
                logger.warn('Chain tip unavailable; no slot anchor this read', {
                  origin: 'CardanoSlotAnchor',
                  error: String(e),
                })
                return Effect.succeed(null)
              }),
            ),
      ),
    )
}
