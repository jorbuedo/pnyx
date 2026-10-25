/**
 * Reading an Effect `SubscriptionRef` from React.
 *
 * The binding `docs/REACT_INTEGRATION.md` has specified for a long time and nothing implemented. It
 * replaces the shape every data hook currently hand-rolls — `useState` + a `useEffect` that runs a
 * one-shot read + a `let cancelled` flag + a subscription to a callback bus — with a subscription to
 * the value itself. Written once here rather than 40 times.
 *
 * ## Why `useSyncExternalStore` and not `useState` + an effect
 *
 * A value that changes between a component's mount and its first paint is torn: the component renders
 * what it read, and only a second render corrects it. `useSyncExternalStore` exists for exactly this
 * and is already the house answer for external state (`useShowUnverified`, `useManualLock`,
 * `ProfileGate`) — those subscribe to plain callback pairs; this one subscribes to a `SubscriptionRef`.
 *
 * ## ⚠️ The selector must return the **stored** value
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders until two agree, so a
 * `getSnapshot` that builds a fresh object every call — `totalsByToken(...)`, `[...map.values()]`,
 * an object literal — is an infinite render loop, not a slow render. {@link useKeyedServiceState}
 * therefore returns `map.get(key)`, whose identity is stable while the map is unchanged. Derive in a
 * `useMemo` on the result, never in the selector.
 *
 * ## Cancellation is interruption
 *
 * The subscription is a fiber, and unsubscribing interrupts it — see `./service-state-subscription.ts`,
 * which holds that part so it can be tested without a renderer. That is the difference from the
 * `let cancelled = false` guard used in 45 places across the hooks: a flag lets the work finish and
 * discards the result, while an interrupt stops it.
 *
 * ## Why the ref may be `undefined`
 *
 * {@link useServiceState} takes `SubscriptionRef | undefined` because a service is not always there on
 * the render that needs it: `wallet-service` is built inside an `Effect` a `useEffect` runs, so the
 * first paint happens before it exists. A `useRef` cannot express that — filling one does not
 * re-render, so the hook would read `undefined` once and never look again. The ref therefore has to
 * arrive through `useState`, and this hook has to accept its absence rather than make every caller
 * guard.
 *
 * @module
 */

import {Effect, SubscriptionRef} from 'effect'
import {useCallback, useSyncExternalStore} from 'react'

import {subscribeToRef} from './service-state-subscription'

/** Stable no-op so an absent ref does not hand `useSyncExternalStore` a new unsubscribe each render. */
const NO_UNSUBSCRIBE = (): void => {}

/**
 * One key out of a ref holding a map — the shape every wallet store uses, keyed by
 * `(groupId, accountIndex)`.
 *
 * `undefined` for an absent key *and* for a `key` the caller does not have yet, which is the ordinary
 * state while a wallet is still resolving. A caller that must tell "no wallet selected" from "this
 * wallet holds nothing" should check its own `key`, not this result — the two are its own facts.
 */
export const useKeyedServiceState = <K, V>(
  ref: SubscriptionRef.SubscriptionRef<ReadonlyMap<K, V>>,
  key: K | undefined,
): V | undefined => {
  const getSnapshot = useCallback(
    () => (key === undefined ? undefined : Effect.runSync(SubscriptionRef.get(ref)).get(key)),
    [ref, key],
  )
  const subscribe = useCallback((onChange: () => void) => subscribeToRef(ref, onChange), [ref])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * One value selected out of a whole ref — for a service whose state is a record rather than a map.
 *
 * `undefined` while `ref` is absent, which is the ordinary state while the service that owns it is
 * still being built. A caller that renders differently before the service exists should track that
 * itself; this result cannot tell "no service yet" from "the service says undefined".
 *
 * ⚠️ `select` must return a **stored** value, for the reason above — `(s) => s.groups` is safe,
 * `(s) => [...s.groups.values()]` is an infinite render loop. Derive in a `useMemo` on the result.
 */
export const useServiceState = <A, S>(
  ref: SubscriptionRef.SubscriptionRef<A> | undefined,
  select: (state: A) => S,
): S | undefined => {
  const getSnapshot = useCallback(
    () => (ref === undefined ? undefined : select(Effect.runSync(SubscriptionRef.get(ref)))),
    [ref, select],
  )
  const subscribe = useCallback(
    (onChange: () => void) => (ref === undefined ? NO_UNSUBSCRIBE : subscribeToRef(ref, onChange)),
    [ref],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
