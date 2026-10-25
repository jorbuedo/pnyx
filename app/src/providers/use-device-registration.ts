/**
 * Binds the device's FCM token to the Pnyx session.
 *
 * Registers the token with the content service (`POST /devices`) when a
 * session appears, and re-registers whenever FCM rotates the token while
 * signed in. Mounted by {@link ./PnyxSessionProvider}; kept free of JSX so it
 * is unit-testable with the repo's React hook simulation.
 *
 * @module
 */

import {useEffect} from 'react'
import {onFcmTokenRefresh} from '../platform/firebase'
import {registerDeviceWithService} from '../services/device-registration'
import type {PnyxSession} from '../services/pnyx-session'

export function useDeviceRegistration(session: PnyxSession | undefined): void {
  useEffect(() => {
    if (session === undefined) return
    void registerDeviceWithService(session)
    return onFcmTokenRefresh((rotated) => {
      void registerDeviceWithService(session, rotated)
    })
  }, [session])
}
