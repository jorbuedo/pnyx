/**
 * Which route subtrees each bottom tab leads to.
 *
 * ⚠️ **The router does not encode this and cannot.** Notice propagation is by route prefix, but the
 * app's *navigation* hierarchy is tabs → screens, and the two disagree: `/settings/security` is
 * reached by tapping Menu, yet it does not descend from `/menu`. So `useNoticeDot('/menu')` was
 * false however many sources were publishing, and the dot on the Security row had nothing leading
 * to it — a trail that starts at the destination.
 *
 * This is the missing edge, written down once. A new top-level route that a tab owns belongs here,
 * or its dots stop at the screen they are on.
 *
 * @module
 */

/** The tabs, as `app/(tabs)/_layout.tsx` names them. */
export type TabName = 'id' | 'community' | 'wallets' | 'menu'

export const TAB_NOTICE_ROUTES: Record<TabName, readonly string[]> = {
  id: ['/id'],
  // DM threads are pushed from the Community tab's inbox pane but live at a top-level route.
  community: ['/community', '/dm'],
  // ⚠️ `/settings/wallet-settings` is a settings route the Menu does not list — the only way in is
  // the gear beside the wallet selector on this tab.
  wallets: ['/wallets', '/wallet', '/settings/wallet-settings'],
  // Menu is the settings surface: everything under `/settings` is reached through it, except the
  // one subtree another tab owns. A `!` target subtracts — see `hasActiveDot`.
  menu: ['/menu', '/settings', '!/settings/wallet-settings'],
}
