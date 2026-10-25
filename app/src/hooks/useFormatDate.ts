/**
 * Locale-aware date/time formatting hook.
 *
 * Uses the system timezone detected via expo-localization and delegates to
 * react-intl's IntlProvider for locale-correct formatting on the runtime's
 * native Intl.DateTimeFormat.
 *
 * @module
 */

import {getCalendars} from 'expo-localization'
import {useMemo} from 'react'
import {useIntl} from 'react-intl'

/**
 * Returns the device's current IANA timezone identifier (e.g. 'Asia/Tokyo').
 * Falls back to the runtime default if expo-localization returns null.
 */
export function getSystemTimeZone(): string | undefined {
  const tz = getCalendars()[0]?.timeZone
  // null means the platform couldn't determine the timezone; undefined tells
  // Intl to use the runtime default rather than forcing an explicit zone.
  return tz ?? undefined
}

export type FormatDateOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>

export type FormatTimeOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>

/**
 * Returns locale-aware date and time formatters bound to the device timezone.
 *
 * The timezone is detected once per hook instantiation via expo-localization.
 * All formatting is delegated to react-intl's `intl.formatDate`, which uses
 * the runtime's native Intl.DateTimeFormat.
 *
 * @example
 * const {formatDate, formatTime, formatDateTime} = useFormatDate()
 *
 * formatDate(new Date())
 * // → "2/23/2026"  (en-US) | "23.02.2026" (de) | "2026/02/23" (ja-JP)
 *
 * formatTime(new Date())
 * // → "3:45 PM"  (en-US) | "15:45" (de)
 *
 * formatDateTime(new Date(), {dateStyle: 'long', timeStyle: 'short'})
 * // → "February 23, 2026 at 3:45 PM"
 */
export function useFormatDate() {
  const intl = useIntl()
  const timeZone = useMemo(getSystemTimeZone, [])

  const formatDate = useMemo(
    () =>
      (date: Date | number, options: FormatDateOptions = {}): string =>
        intl.formatDate(date, {dateStyle: 'short', ...options, timeZone}),
    [intl, timeZone],
  )

  const formatTime = useMemo(
    () =>
      (date: Date | number, options: FormatTimeOptions = {}): string =>
        intl.formatTime(date, {timeStyle: 'short', ...options, timeZone}),
    [intl, timeZone],
  )

  const formatDateTime = useMemo(
    () =>
      (date: Date | number, options: FormatDateOptions = {}): string =>
        intl.formatDate(date, {dateStyle: 'medium', timeStyle: 'short', ...options, timeZone}),
    [intl, timeZone],
  )

  return {formatDate, formatTime, formatDateTime, timeZone}
}
