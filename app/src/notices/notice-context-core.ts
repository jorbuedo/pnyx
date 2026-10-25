/**
 * The notice context itself — its types, the React context object, and the hook that reads it.
 *
 * ⚠️ **Split out of `NoticeContext.tsx` to break a require cycle.** The provider has to render
 * `NoticeSources`, and every source registers itself through `useRegisterNotice` in `useNoticeDot.ts`,
 * which needs this context back:
 *
 *   NoticeContext → sources → sources/useBackupNotice → useNoticeDot → NoticeContext
 *
 * Metro's warning is the reason to care — "can result in uninitialized values" — and a context object
 * read as `undefined` during module init fails in a way that looks nothing like its cause. Nothing here
 * imports a source, so the loop is open.
 *
 * @module
 */

import {createContext, useContext} from 'react'
import type {Dismissals} from './matching'

export type NoticeKey = string

export type NoticeValue = {
  /** Route the notice is anchored to. Dot lights up on this and all ancestor routes. */
  readonly route: string
  /** Current activity — `false` keeps the entry but suppresses the dot. */
  readonly active: boolean
  /**
   * When true, visiting the anchoring screen suppresses the dot via
   * {@link useDismissNoticeOnFocus}. The dismissal auto-clears the next
   * time this key publishes `active: false`, so a later re-activation
   * shows the dot again.
   */
  readonly dismissable?: boolean
  /**
   * Optional content signature. A dismissal only suppresses the dot while
   * this string is unchanged — publishing a new revision (e.g. a changed
   * redeemable amount) re-arms the dot even if `active` never dipped to
   * `false`. Omit for notices whose mere presence is the whole signal.
   */
  readonly revision?: string
}

export type NoticeContextValue = {
  readonly notices: ReadonlyMap<NoticeKey, NoticeValue>
  readonly dismissals: Dismissals
  /** Set (or replace) a notice under `key`. Pass `null` to clear the entry entirely. */
  readonly set: (key: NoticeKey, value: NoticeValue | null) => void
  /** Mark a dismissable notice as dismissed at its current revision. No-op for non-dismissable notices. */
  readonly dismiss: (key: NoticeKey) => void
  /**
   * Dismiss every currently-active dismissable notice whose route equals
   * `route` or is a descendant (route prefix). Non-dismissable notices
   * are ignored. Used by screens that anchor many per-instance notices
   * (e.g. per-wallet-group keys) to acknowledge them all in one call.
   */
  readonly dismissAllAt: (route: string) => void
}

export const NoticeContext = createContext<NoticeContextValue | null>(null)

export const useNoticeContext = (): NoticeContextValue => {
  const ctx = useContext(NoticeContext)
  if (!ctx) throw new Error('useNoticeContext must be used within NoticeProvider')
  return ctx
}
