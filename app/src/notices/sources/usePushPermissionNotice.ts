/**
 * Source hook: light up Settings → Notifications when OS-level push
 * permission hasn't been granted. Native only — web's permission flow
 * is handled by the browser directly and has no in-app settings row.
 *
 * Gated on the `pushNotifications` feature flag to avoid nudging users
 * toward a subsystem the build hasn't enabled. Also gated on `isLoading`
 * so the dot doesn't flash `true` on cold start while the first
 * permission check is still pending — the initial permission state is
 * optimistically `false` in the hook, and flipping to `true` after the
 * async check would leave a very brief red-dot flash.
 *
 * @module
 */

import {useFeatureFlag} from '../../hooks/useFeatureFlag'
import {useNotificationPermissions} from '../../hooks/useNotificationPermissions'
import {isNative} from '../../platform'
import {useRegisterNotice} from '../useNoticeDot'

const KEY = 'push-permission-missing'
const ROUTE = '/settings/notifications'

export const usePushPermissionNotice = (): void => {
  const pushEnabled = useFeatureFlag('pushNotifications')
  const {hasPermission, isLoading} = useNotificationPermissions()
  const active = isNative && pushEnabled && !isLoading && !hasPermission
  useRegisterNotice(KEY, {route: ROUTE, active})
}
