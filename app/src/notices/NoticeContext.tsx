/**
 * Notice registry — route-indexed attention signals.
 *
 * A "notice" is a reason for a user to look at some corner of the app
 * (backup pending, PIN missing, unread push, etc.).
 * Each notice has a stable `key` (so its source can update it in place)
 * and a `route` (the deepest nav location the notice is anchored to).
 *
 * Consumers ask via {@link useNoticeDot} whether a given nav surface
 * should show the attention dot. Propagation up the nav tree is automatic
 * via route prefix matching: an active notice at `/menu/airdrop` lights up
 * `/menu`, `/menu/airdrop`, and anything else whose route is a prefix of
 * the notice route.
 *
 * Sources register themselves from inside {@link NoticeProvider} via hook
 * adapters (see `./sources/*`). Adding a new attention signal is:
 *   1. Write a hook that returns `{route, active}` from app state
 *   2. Add a `useX()` call inside `<NoticeSources />`
 *   3. Drop `<NoticeDot route="..." />` on any nav surface that should react
 *
 * ## Dismissable notices
 *
 * Notices marked `dismissable: true` can be suppressed by the user visiting
 * the anchoring screen — the framework persists the dismissal to storage
 * and auto-clears it when the source transitions back to `active: false`.
 * That way a re-activation (e.g. PIN set then unset, new midnight thaw
 * after a claim) re-arms the dot. Only the screens that want visit-based
 * dismissal need to call {@link useDismissNoticeOnFocus}; everything else
 * stays active-until-resolved, which is the right default for urgent
 * security/backup nudges.
 *
 * @module
 */

import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useLatestRef} from '../hooks/useLatestRef'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {type Dismissals, findKeysToDismissAt, parseDismissals, serializeDismissals} from './matching'
import {NoticeContext, type NoticeKey, type NoticeValue} from './notice-context-core'
import {NoticeSources} from './sources'

const STORAGE_KEY = '@pnyx/notices:dismissed'

const readDismissed = async (): Promise<Dismissals> => {
  const raw = await storage.get(STORAGE_KEY).catch((e) => {
    logger.warn('Dismissed-notice read failed; dismissed notices may reappear', {
      origin: 'NoticeContext',
      error: String(e),
    })
    return null
  })
  return parseDismissals(raw)
}

const writeDismissed = (dismissals: Dismissals): void => {
  // Fire-and-forget — if the write fails the in-memory state is still
  // correct for the current session; next launch will just show the dot
  // again until the user dismisses it once more. Cheap cost, no retry loop.
  void storage.set(STORAGE_KEY, serializeDismissals(dismissals))
}

export const NoticeProvider = ({children}: {children: ReactNode}) => {
  const [notices, setNotices] = useState<ReadonlyMap<NoticeKey, NoticeValue>>(() => new Map())
  const [dismissals, setDismissals] = useState<Dismissals>(() => new Map())
  // `dismiss` / `dismissAllAt` need to read the current notice map inside
  // their setState updaters (to record the revision at dismissal time) but
  // the callback identity has to stay stable so consumers don't resubscribe
  // on every dismissal.
  const noticesRef = useLatestRef(notices)
  // Gate the persist-to-storage effect until the async hydration read
  // completes. Without this, the effect would fire on initial mount
  // with the default empty Set and clobber any pre-existing dismissals
  // in storage before `readDismissed` gets a chance to load them.
  const hydratedRef = useRef(false)

  // Hydrate from storage on mount. Merge (rather than replace) so a
  // dismiss that fires in the narrow window between mount and hydration
  // completing (e.g. if the user opens straight to a screen with a
  // `useDismissNoticeOnFocus`) isn't overwritten when loaded arrives.
  //
  // Always emits a new `Set` reference from the updater so the persist
  // effect below re-fires after hydration flips `hydratedRef` — otherwise
  // a pre-hydration dismiss against empty storage would update in-memory
  // state while the persist effect was still gated, and no later state
  // change would retrigger the write.
  useEffect(() => {
    readDismissed().then((loaded) => {
      setDismissals((current) => {
        if (current.size === 0) return loaded
        const merged = new Map(loaded)
        for (const [key, revision] of current) merged.set(key, revision)
        return merged
      })
      hydratedRef.current = true
    })
  }, [])

  // Persist dismissals to storage whenever the set changes. A separate
  // effect rather than writing inside each mutator — keeps the setState
  // updaters pure (strict-mode safe), and collapses the multi-dismiss
  // batching case (three `useDismissNoticeOnFocus` on one screen focus
  // produce one effect firing, not three) so we write storage once.
  useEffect(() => {
    if (!hydratedRef.current) return
    writeDismissed(dismissals)
  }, [dismissals])

  const set = useCallback((key: NoticeKey, value: NoticeValue | null) => {
    setNotices((prev) => {
      const existing = prev.get(key)
      if (value === null) {
        if (!existing) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      }
      // Reference-equality early-out: sources re-call set() on every render
      // with the same route/active, and a fresh Map here would cause every
      // NoticeDot in the tree to re-render for no reason.
      if (
        existing &&
        existing.route === value.route &&
        existing.active === value.active &&
        existing.dismissable === value.dismissable &&
        existing.revision === value.revision
      ) {
        return prev
      }
      const next = new Map(prev)
      next.set(key, value)
      return next
    })

    // Auto-clear dismissal when a dismissable notice goes inactive. The
    // next re-activation (signal flipping false → true) then re-arms
    // the dot. Functional updater so concurrent updates merge correctly.
    if (value?.active === false) {
      setDismissals((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  const dismiss = useCallback((key: NoticeKey) => {
    const notice = noticesRef.current.get(key)
    // Only dismissable notices are suppressible; ignore the rest so a stray
    // call can't shadow an urgent dot.
    if (!notice?.dismissable) return
    const revision = notice.revision ?? ''
    setDismissals((prev) => {
      if (prev.get(key) === revision) return prev
      const next = new Map(prev)
      next.set(key, revision)
      return next
    })
  }, [])

  const dismissAllAt = useCallback((route: string) => {
    setDismissals((prev) => {
      const toAdd = findKeysToDismissAt(noticesRef.current, prev, route)
      if (toAdd.size === 0) return prev
      const next = new Map(prev)
      for (const [key, revision] of toAdd) next.set(key, revision)
      return next
    })
  }, [])

  const ctx = useMemo(
    () => ({notices, dismissals, set, dismiss, dismissAllAt}),
    [notices, dismissals, set, dismiss, dismissAllAt],
  )

  return (
    <NoticeContext.Provider value={ctx}>
      <NoticeSources />
      {children}
    </NoticeContext.Provider>
  )
}

// Re-exported from where they have always been imported; they live in `notice-context-core.ts`, which
// no notice source imports back. See that module for the cycle it breaks.
export {type NoticeKey, type NoticeValue, useNoticeContext} from './notice-context-core'
