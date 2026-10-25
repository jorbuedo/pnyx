/**
 * Slot ↔ wall-clock time, from one measured anchor.
 *
 * A transaction's TTL and validity-interval-start are absolute slot numbers. A
 * slot number tells a reader nothing — "expires at slot 152 741 887" is not an
 * answer to "when does this expire" — so the review resolves them to dates, and
 * a screen that asks for one lets the user pick a date instead.
 *
 * Within a Shelley-era-or-later network one slot is exactly one second, so a
 * single `(slot, time)` pair from any block converts every other slot in that
 * era: `time = anchor.timeSec + (slot - anchor.slot)`. That is not an
 * approximation. Measured against real mainnet blocks spanning height 100 →
 * 13.7M, the residual is exactly 0 for every block at or after the Shelley
 * boundary and grows to 85 million seconds below it, where Byron's 20-second
 * slots make the relation non-linear.
 *
 * Hence {@link ERA_START_SLOT}: the conversion refuses a slot below its
 * network's boundary rather than returning a date that is years wrong. Measured
 * per network, not recalled — mainnet's last Byron block sits at slot 4 492 289
 * and its first Shelley block at exactly 4 492 800; preprod's are 84 242 and
 * 86 400; preview has no Byron era at all.
 *
 * An anchor never goes stale: the relation is time-invariant, so a pair captured
 * once stays exact. Only a future era that changes slot duration would break it,
 * and that would need a per-era table rather than a fix here.
 *
 * @module
 */

import type {CardanoNetwork} from './config'

/** A `(slot, unix seconds)` pair from any block in the current era. */
export type SlotAnchor = {
  readonly slot: number
  readonly timeSec: number
}

/**
 * First absolute slot on each network for which one slot is one second — the
 * Shelley boundary. Below it the anchor's linear relation does not hold.
 *
 * Measured from real blocks (residual 0 at the boundary, non-zero one block
 * below it) rather than taken from genesis documentation.
 */
export const ERA_START_SLOT: Record<CardanoNetwork, number> = {
  mainnet: 4_492_800,
  preprod: 86_400,
  preview: 0,
}

/**
 * Wall-clock time of `slot`, or `null` when it cannot be established: no anchor
 * yet, a slot below the network's era boundary, or a non-finite input. Never
 * returns a guess — a wrong expiry date is worse than none.
 */
export const slotToDate = (network: CardanoNetwork, anchor: SlotAnchor | null, slot: number | bigint): Date | null => {
  if (anchor === null) return null
  const n = typeof slot === 'bigint' ? Number(slot) : slot
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null
  if (n < ERA_START_SLOT[network]) return null
  // The anchor itself must sit in the same linear era, or the offset it carries
  // is meaningless.
  if (anchor.slot < ERA_START_SLOT[network]) return null
  const timeSec = anchor.timeSec + (n - anchor.slot)
  if (timeSec <= 0) return null
  return new Date(timeSec * 1000)
}

/**
 * The slot a wall-clock time falls in — {@link slotToDate} backwards, for a user
 * choosing a time lock rather than reading one.
 *
 * `null` under the same conditions, plus a date whose slot would land below the
 * network's era boundary: such a lock is expressible as a slot number but the
 * date the user picked is not the date that slot means, and writing it into a
 * script would bind the wallet to a moment nobody chose.
 *
 * Truncates to whole seconds, so it round-trips exactly with {@link slotToDate}.
 */
export const dateToSlot = (network: CardanoNetwork, anchor: SlotAnchor | null, date: Date): number | null => {
  if (anchor === null) return null
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return null
  if (anchor.slot < ERA_START_SLOT[network]) return null
  const slot = anchor.slot + (Math.floor(ms / 1000) - anchor.timeSec)
  if (!Number.isSafeInteger(slot)) return null
  if (slot < ERA_START_SLOT[network]) return null
  return slot
}
