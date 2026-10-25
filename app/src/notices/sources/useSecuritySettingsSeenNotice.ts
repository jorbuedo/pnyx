/**
 * Source hook: nudge the user to visit Security & Privacy once.
 *
 * Always publishes `active: true` — the "I've seen it" behavior is
 * handled by the shared dismissal mechanism (`dismissable: true` +
 * `useDismissNoticeOnFocus` on the screen). Since this signal never
 * goes inactive on its own, dismissal is effectively permanent, which
 * matches the old `useSecuritySettingsSeen` storage bit semantics.
 *
 * Keeping the source hook skinny here is intentional: letting the
 * framework own the visit-cleared pattern means this and the other
 * dismissable nudges (pin, biometric, midnight, multichain, etc.)
 * share one storage key, one persistence mechanism, and one recovery
 * path — previously each one-off dot invented its own.
 *
 * @module
 */

import {useRegisterNotice} from '../useNoticeDot'

const KEY = 'security-settings-unseen'
const ROUTE = '/settings/security'

export const useSecuritySettingsSeenNotice = (): void => {
  useRegisterNotice(KEY, {route: ROUTE, active: true, dismissable: true})
}
