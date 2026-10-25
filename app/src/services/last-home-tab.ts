/**
 * Which home tab the user was last on, so anywhere that has to pick a destination picks *theirs*.
 *
 * ⚠️ **Menu is not a home tab.** Id, Community and Wallets are places you live in; Menu is a settings
 * surface you pass through. Landing someone in Menu after an unlock because that is where they happened
 * to be last would be worse than any fixed default, so focusing Menu leaves the stored value alone.
 *
 * Read synchronously, because the one caller that matters ({@link module:./post-unlock-landing}) renders
 * a `<Redirect>` during render and cannot await. ⚠️ `storage.getSync` does not reach the extension's
 * `chrome.storage`; there the read answers `null` and the caller falls back, which is correct rather than
 * merely tolerable — a wrong tab is worse than the default one.
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'

const ORIGIN = 'last-home-tab'

export type HomeTab = 'id' | 'community' | 'wallets'

export const HOME_TABS: readonly HomeTab[] = ['id', 'community', 'wallets']

export const LAST_HOME_TAB_KEY = '@pnyx/last_home_tab'

/** `null` for absent *or* unrecognised — never a guessed tab. A stale value from a renamed route reads as absent. */
export const parseHomeTab = (raw: string | null | undefined): HomeTab | null =>
  raw !== null && raw !== undefined && (HOME_TABS as readonly string[]).includes(raw) ? (raw as HomeTab) : null

export const homeTabHref = (tab: HomeTab): '/id' | '/community' | '/wallets' => `/${tab}`

export const readLastHomeTabSync = (): HomeTab | null => {
  try {
    return parseHomeTab(storage.getSync(LAST_HOME_TAB_KEY))
  } catch (error) {
    logger.warn('last home tab unreadable; falling back to the default landing', {
      origin: ORIGIN,
      error: String(error),
    })
    return null
  }
}

/**
 * Record the tab. Fire-and-forget: the user is already looking at it, so the write must never block or
 * fail the navigation — but it says so when it fails, because a silently unwritten tab looks exactly like
 * a landing rule that does not work.
 */
export const recordLastHomeTab = (tab: HomeTab): void => {
  void storage.set(LAST_HOME_TAB_KEY, tab).catch((error: unknown) => {
    logger.warn('failed to record the last home tab', {origin: ORIGIN, tab, error: String(error)})
  })
}
