/**
 * Cached date/time formatting, for the same reason `getNumberFormat` exists.
 *
 * ⚠️ **`Date#toLocaleTimeString` constructs a formatter on every call.** Two activity-row renderers
 * called it per row, per render, and on a wallet with a long history that was the single largest cost on
 * the JS thread: **551 ms** of a 12-second window inside `datePrototypeToLocaleStringHelper`, measured
 * on an idle screen with a 2.13M-ADA wallet loaded. `Intl.NumberFormat` had already been memoised for
 * exactly this reason, with a Sentry profile behind it (see `number-format.ts`); dates were left out.
 *
 * The permutations are bounded — a couple of option sets across the supported locales — so a
 * module-level map is an effectively permanent cache that leaks nothing.
 *
 * @module
 */

const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>()

/**
 * An `Intl.DateTimeFormat` for `(locale, options)`, constructed at most once.
 *
 * `locale` of `undefined` means the runtime default, which is what the callers replaced here were
 * passing; it is cached under its own key rather than resolved, so behaviour is unchanged.
 */
export const getDateTimeFormat = (
  locale: string | undefined,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  // Option objects are built as literals in a fixed key order at each call site, so identical sets
  // serialise identically — the same assumption `getNumberFormat` documents and relies on.
  const key = `${locale ?? ''}|${options ? JSON.stringify(options) : ''}`
  const hit = dateTimeFormatCache.get(key)
  if (hit !== undefined) return hit
  const format = new Intl.DateTimeFormat(locale, options)
  dateTimeFormatCache.set(key, format)
  return format
}

const TIME_OF_DAY: Intl.DateTimeFormatOptions = {hour: 'numeric', minute: '2-digit'}

/**
 * The time of day for an activity row — `11:57 AM`, in the locale's own convention.
 *
 * Takes the same shapes the rows hold: an ISO string or epoch millis.
 */
export const formatTimeOfDay = (timestamp: string | number, locale?: string): string =>
  getDateTimeFormat(locale, TIME_OF_DAY).format(new Date(timestamp))
