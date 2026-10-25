/**
 * Push notification React context.
 *
 * Exposes the singleton pushNotificationManager to the component tree.
 */

import {createContext, type ReactNode, useContext} from 'react'
import {pushNotificationManager} from '../services/notification-manager'

type PushNotificationManagerType = typeof pushNotificationManager

const NotificationContext = createContext<PushNotificationManagerType>(pushNotificationManager)

export function NotificationProvider({children}: {children: ReactNode}) {
  return <NotificationContext.Provider value={pushNotificationManager}>{children}</NotificationContext.Provider>
}

export function usePushNotificationManager(): PushNotificationManagerType {
  return useContext(NotificationContext)
}
