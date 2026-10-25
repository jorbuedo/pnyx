/**
 * Hooks for the notice registry.
 *
 * - {@link useNoticeDot} — read: does this nav surface need an attention dot?
 * - {@link useRegisterNotice} — write: source hooks use this to publish a
 *   notice under a stable key.
 * - {@link useDismissNoticeOnFocus} — suppress a dismissable notice while
 *   the anchoring screen is focused.
 *
 * Dot propagation up the nav tree is automatic via route prefix matching:
 * an active notice at `/menu/airdrop` lights up `/menu`, `/menu/airdrop`,
 * and any shallower ancestor route a consumer asks about. Routes are
 * case-sensitive; a trailing slash on the query is tolerated.
 *
 * @module
 */

import {useFocusEffect} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef} from 'react'
import {hasActiveDot} from './matching'
import {type NoticeKey, type NoticeValue, useNoticeContext} from './notice-context-core'

/**
 * Does this nav surface need an attention dot?
 *
 * Accepts several routes because a surface can own more than one subtree — see
 * {@link module:./nav-routes}. Memoised on the joined key so passing an array literal each render
 * does not defeat it.
 */
export const useNoticeDot = (route: string | readonly string[]): boolean => {
  const {notices, dismissals} = useNoticeContext()
  const key = typeof route === 'string' ? route : route.join('\u0000')
  return useMemo(() => hasActiveDot(notices, dismissals, key.split('\u0000')), [notices, dismissals, key])
}

/**
 * Register a notice under `key`. Re-registering under the same key
 * replaces the previous value. Passing `null` clears the entry.
 *
 * The content-equality check inside the provider keeps redundant calls
 * cheap — it's safe to pass a fresh `{route, active}` object every render.
 */
export const useRegisterNotice = (key: NoticeKey, value: NoticeValue | null): void => {
  const {set} = useNoticeContext()
  const route = value?.route
  const active = value?.active
  const dismissable = value?.dismissable
  const revision = value?.revision
  useEffect(() => {
    if (route === undefined || active === undefined) {
      set(key, null)
      return
    }
    set(key, {route, active, ...(dismissable ? {dismissable} : {}), ...(revision !== undefined ? {revision} : {})})
    return () => set(key, null)
  }, [key, route, active, dismissable, revision, set])
}

/**
 * Dismiss the notice `key` whenever this screen gains focus. Intended for
 * screens that anchor dismissable notices — once the user has been there,
 * the dot should stop nagging until the underlying signal resets.
 *
 * No-op for non-dismissable notices; the provider drops the call.
 */
export const useDismissNoticeOnFocus = (key: NoticeKey): void => {
  const {dismiss} = useNoticeContext()
  useFocusEffect(
    useCallback(() => {
      dismiss(key)
    }, [dismiss, key]),
  )
}

/**
 * Dismiss every currently-active dismissable notice anchored at `route` or
 * below it. Use this on screens that aggregate per-instance notices (e.g.
 * a wallet list where each wallet contributes its own `key`) so the user's
 * single visit acknowledges them all.
 *
 * Non-dismissable notices at the same route are ignored.
 */
export const useDismissNoticesOnFocusAt = (route: string): void => {
  const {dismissAllAt} = useNoticeContext()
  useFocusEffect(
    useCallback(() => {
      dismissAllAt(route)
    }, [dismissAllAt, route]),
  )
}

/**
 * Register one notice per id, clearing the ones that go away.
 *
 * The many-instances case the per-group keys already needed: hooks cannot be called in a loop, so a
 * varying number of notices has to be driven through `set` from a single effect. `keyOf` and
 * `routeOf` must be stable (module-level functions), since they identify what to clear.
 */
export const useRegisterNoticeSet = (
  keyOf: (id: string) => NoticeKey,
  routeOf: (id: string) => string,
  ids: readonly string[],
): void => {
  const {set} = useNoticeContext()
  // Joined so a fresh array each render does not re-run the effect; NUL cannot occur in an id.
  const joined = ids.join('\u0000')
  const registered = useRef<readonly string[]>([])
  useEffect(() => {
    const next = joined === '' ? [] : joined.split('\u0000')
    for (const id of registered.current) if (!next.includes(id)) set(keyOf(id), null)
    for (const id of next) set(keyOf(id), {route: routeOf(id), active: true})
    registered.current = next
    return () => {
      for (const id of next) set(keyOf(id), null)
      registered.current = []
    }
  }, [joined, set, keyOf, routeOf])
}
