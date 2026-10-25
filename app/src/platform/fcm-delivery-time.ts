/**
 * Shared FCM delivery-time resolution for push-notification entry points.
 *
 * react-native-firebase on Android can surface `remoteMessage.sentTime` clamped
 * to Int32 max (`2147483647` ≈ 1970-01-25), and a seconds-based value (~1.7e9)
 * is likewise far too small. Both fall below this floor, so we reject them and
 * let the caller fall through to the FCM `google.sent_time` data field or "now"
 * — rather than rendering a 1970 date in the inbox.
 *
 * @module
 */

/** Smallest epoch-ms we treat as a real send time (2001-09-09). */
export const MIN_PLAUSIBLE_EPOCH_MS = 1_000_000_000_000

const asPlausibleMs = (value: unknown): number | null => {
  if (typeof value === 'number' && value >= MIN_PLAUSIBLE_EPOCH_MS) return value
  if (typeof value === 'string') {
    const ms = Number.parseInt(value, 10)
    if (Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_EPOCH_MS) return ms
  }
  return null
}

/**
 * Resolve a plausible FCM delivery time in epoch-ms: prefer the message
 * `sentTime`, then the FCM `google.sent_time` data field. Returns `null` when
 * neither is a plausible ms value, so the caller can fall back to `Date.now()`.
 */
export const resolveFcmDeliveryMs = (primarySentTime: unknown, googleSentTime: unknown): number | null =>
  asPlausibleMs(primarySentTime) ?? asPlausibleMs(googleSentTime)
