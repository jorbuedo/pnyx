/**
 * Telling a screen that a store it already read has changed.
 *
 * A wallet's caches are written by services — a sync, a send, a registration — and read by hooks that
 * run on mount. Nothing connects the two, so whichever surface mounted *after* a write shows the new
 * figure and every other one keeps the old until it happens to remount. That is why restarting the app
 * has been the app's invalidation mechanism, and why the wallet-home widget and the screen for the same
 * thing routinely disagree.
 *
 * `pending-send-store` already solved this for itself, with a listener set and a comment recording the
 * device session that found it. Three more stores need the same thing, so it lives here once instead of
 * four times.
 *
 * ## Deliberately coarse
 *
 * A topic is a store, not a wallet or an account. A change to one wallet therefore wakes readers of
 * another, which costs them a re-read of local storage and nothing else — while getting the scoping
 * wrong in the other direction costs a stale balance, which is the bug this exists to kill. Narrow it
 * only if a profiler says to.
 *
 * ## What this is not
 *
 * Not a sync trigger and not a data channel. Listeners are told *that* something changed, never what,
 * and re-read the store themselves — so a listener can never disagree with storage, which a payload
 * would eventually let it do.
 *
 * ## Why a callback set and not a `PubSub`
 *
 * Settled, not deferred. Every publisher is an `Effect` — hence {@link publishStoreChange} — but every
 * subscriber is a React `useEffect`, and finishing the Effect migration does not change that: hooks are
 * the edge the migration keeps on purpose, and the sync scheduler lives in `WalletProvider`. A `PubSub`
 * would make subscribing *worse* for the only consumers there are, since each would need
 * `Stream.runForEach` on a fiber it interrupts on unmount, in place of an unsubscribe function.
 * `SubscriptionRef` is ruled out by the paragraph above: it carries a value, and this deliberately
 * carries none. Revisit only if something outside React needs to react to a write — a scheduler moved
 * onto a fiber would be the case.
 *
 * @module
 */

import {Effect} from 'effect'

/** The stores that announce writes. One per cache that a screen renders. */
export type StoreChangeTopic =
  /** The unshielded UTxO set and its activity. */
  | 'midnight-unshielded'
  /** The shielded wallet state — coins and balances. */
  | 'midnight-shielded'
  /** The synced DUST state. */
  | 'midnight-dust'
  /** Sends submitted but not yet seen on chain. */
  | 'midnight-pending-sends'
  /**
   * The in-flight locks over unshielded UTxOs.
   *
   * Split from `midnight-unshielded` because a lock write does not change the cache — it changes what
   * may be *spent* from it. Sharing the topic meant writing a lock woke every reader of the UTxO set to
   * re-parse a blob that had not moved. The set's owner listens here and re-publishes with the overlay
   * applied, which is the only thing that actually has to happen.
   */
  | 'midnight-unshielded-locks'

const listeners = new Map<StoreChangeTopic, Set<() => void>>()

/**
 * Run `listener` whenever `topic` is written. Returns the unsubscribe.
 *
 * The listener takes no argument on purpose — see the module note on why there is no payload.
 */
export const onStoreChange = (topic: StoreChangeTopic, listener: () => void): (() => void) => {
  const existing = listeners.get(topic) ?? new Set<() => void>()
  existing.add(listener)
  listeners.set(topic, existing)
  return () => {
    existing.delete(listener)
    if (existing.size === 0) listeners.delete(topic)
  }
}

/**
 * Announce that `topic` was written.
 *
 * Iterates a copy: a listener that unsubscribes itself while being notified — a component unmounting in
 * response — would otherwise mutate the set mid-iteration and silently skip the next listener.
 */
export const notifyStoreChange = (topic: StoreChangeTopic): void => {
  const subscribed = listeners.get(topic)
  if (subscribed === undefined) return
  for (const listener of [...subscribed]) listener()
}

/**
 * {@link notifyStoreChange} as an `Effect`, for the stores that are ones.
 *
 * Every writer of every topic is an `Effect` now, so without this each one wraps the call in its own
 * `Effect.sync` — six copies of the same three tokens, and a side effect sitting outside the effect
 * that is supposed to describe it.
 */
export const publishStoreChange = (topic: StoreChangeTopic): Effect.Effect<void> =>
  Effect.sync(() => notifyStoreChange(topic))
