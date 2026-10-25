/**
 * Web stub for Firebase push notification utilities.
 * FCM is not supported on web — all functions are no-ops.
 */

export async function getFCMToken(): Promise<string | null> {
  return null
}

export function initFirebasePushNotifications(): () => void {
  return () => {}
}

export function onFcmTokenRefresh(_listener: (token: string) => void): () => void {
  return () => {}
}
