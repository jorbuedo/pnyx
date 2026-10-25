/**
 * Composition root for notice source hooks.
 *
 * Renderless — each `use…Notice()` call inside this component publishes
 * its signal into the notice registry via `useRegisterNotice`. Adding a
 * new attention signal is: write a source hook, call it here.
 *
 * This component is mounted by {@link NoticeProvider}, so every source
 * hook runs inside the notice context and can read from any provider
 * mounted above NoticeProvider.
 *
 * @module
 */

import {useBackupNotice} from './sources/useBackupNotice'
import {usePushPermissionNotice} from './sources/usePushPermissionNotice'
import {useSecuritySettingsSeenNotice} from './sources/useSecuritySettingsSeenNotice'

export const NoticeSources = (): null => {
  // /settings/wallet-selection
  useBackupNotice()
  // /settings/security
  useSecuritySettingsSeenNotice()
  // /settings/notifications
  usePushPermissionNotice()
  return null
}
