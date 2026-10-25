/**
 * Subscribing to a `SubscriptionRef` as a fiber, and stopping by interrupting it.
 *
 * Separate from `useServiceState.ts` so it can be tested without a React renderer — the repo has no
 * `@testing-library/react-native`, and this is the part with behaviour worth pinning: that
 * unsubscribing actually stops the work, and that a broken subscription takes down nothing but itself.
 *
 * @module
 */

import {Effect, Fiber, Stream, type SubscriptionRef} from 'effect'

import {logger} from '../logger'

const ORIGIN = 'service-state-subscription'

/**
 * Run `onChange` whenever `ref` changes. Returns the unsubscribe.
 *
 * ⚠️ **`ref.changes` emits the ref's current value on subscribe**, before any change, so `onChange`
 * fires once immediately. That is harmless for `useSyncExternalStore` — it re-reads a snapshot that is
 * identical and does not re-render — but a caller using this directly must not treat the first call as
 * evidence that something changed.
 *
 * ⚠️ **Deduped by reference here, because `SubscriptionRef.set` emits unconditionally.** Storing a map
 * that is the same object still notifies, which would reproduce the defect this replaces: writing an
 * in-flight lock republished `midnight-unshielded` and made two hooks re-parse a blob that had not
 * moved. `Stream.changesWith(Object.is)` is what makes an unchanged write silent — so a writer that
 * wants listeners woken must store a **new** reference, which every store already does.
 *
 * A failed subscription is logged and ends **that subscription only**. The fiber writing the ref keeps
 * running, so the cost is a surface that stops updating rather than an app that tears down — the same
 * isolation `WalletProvider` applies to the scheduler's state stream.
 */
export const subscribeToRef = <A>(ref: SubscriptionRef.SubscriptionRef<A>, onChange: () => void): (() => void) => {
  const fiber = Effect.runFork(
    Stream.runForEach(ref.changes.pipe(Stream.changesWith(Object.is)), () => Effect.sync(onChange)).pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          logger.warn('a store subscription ended; this surface will stop updating', {
            origin: ORIGIN,
            cause: String(cause),
          })
        }),
      ),
    ),
  )
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}
