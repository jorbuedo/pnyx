/**
 * Hook for managing notification permissions.
 *
 * Provides permission status and request function for OS notifications.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'

import {hasNotificationsPermission, requestNotificationsPermission} from '../platform/notification-tools'

export type NotificationPermissionsState = {
  /** Whether notification permissions are granted */
  readonly hasPermission: boolean
  /** Whether we're currently checking/requesting permissions */
  readonly isLoading: boolean
}

export type NotificationPermissionsActions = {
  /** Request notification permissions from the user */
  readonly requestPermission: () => Promise<boolean>
  /** Refresh permission status */
  readonly refreshStatus: () => Promise<void>
}

export type UseNotificationPermissionsResult = NotificationPermissionsState & NotificationPermissionsActions

/**
 * Hook for managing notification permissions
 */
export function useNotificationPermissions(): UseNotificationPermissionsResult {
  const [hasPermission, setHasPermission] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  // Check permission status on mount
  useEffect(() => {
    hasNotificationsPermission()
      .then(setHasPermission)
      .finally(() => setIsLoading(false))
  }, [])

  const refreshStatus = useCallback(async () => {
    setIsLoading(true)
    try {
      const granted = await hasNotificationsPermission()
      setHasPermission(granted)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const requestPermission = useCallback(async () => {
    setIsLoading(true)
    try {
      const granted = await requestNotificationsPermission()
      setHasPermission(granted)
      return granted
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    hasPermission,
    isLoading,
    requestPermission,
    refreshStatus,
  }
}
