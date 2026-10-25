/**
 * Where `RootIndex` sends the user once the app is unlocked and a wallet exists.
 *
 * | pending push intent | last home tab | landing |
 * |---|---|---|
 * | set | (ignored) | whatever {@link landingForPushIntent} says — the notification is why they opened it |
 * | none | `id` / `community` / `wallets` | that tab |
 * | none | none (first run, or an unreadable/renamed value) | {@link FIRST_RUN_LANDING} |
 *
 * The middle row is the point: this used to be a hardcoded `/community` for everyone, so a user who lives
 * in Wallets was moved off it by every unlock — and a network switch re-locks, which made it constant.
 *
 * @module
 */

import {type HomeTab, homeTabHref} from './last-home-tab'
import type {PendingPushIntent} from './pending-push-intent'
import {landingForPushIntent} from './push-intent-landing'

/** Used only when the user has never settled on a tab. Not a preference — an unavoidable first choice. */
export const FIRST_RUN_LANDING = '/community'

export const postUnlockLanding = (input: {
  readonly pendingIntent: PendingPushIntent | null
  readonly lastHomeTab: HomeTab | null
}): string => {
  if (input.pendingIntent !== null) return landingForPushIntent(input.pendingIntent)
  return input.lastHomeTab === null ? FIRST_RUN_LANDING : homeTabHref(input.lastHomeTab)
}
