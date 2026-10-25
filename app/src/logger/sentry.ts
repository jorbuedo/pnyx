/**
 * Sentry transport for production logging.
 * @module
 */

import type {LogLevel as LogLevelType, LogTransport, LogTransportOptions} from '@pnyx/logger'
import {LogLevel} from '@pnyx/logger'

type SentryBreadcrumbType =
  | 'default'
  | 'debug'
  | 'error'
  | 'navigation'
  | 'http'
  | 'info'
  | 'query'
  | 'transaction'
  | 'ui'
  | 'user'

type SentrySeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'

type SentryScope = {
  setTags(tags: Record<string, string>): void
  setExtras(extras: Record<string, unknown>): void
  captureMessage(message: string, level?: SentrySeverityLevel): void
  captureException(exception: unknown): void
}

type SentryRuntime = {
  addBreadcrumb(breadcrumb: {
    type?: SentryBreadcrumbType
    category?: string
    message?: string
    level?: SentrySeverityLevel
    data?: Record<string, unknown>
    timestamp?: number
  }): void
  captureMessage(message: string, level?: SentrySeverityLevel): void
  captureException(exception: unknown, hint?: {extra?: Record<string, unknown>}): void
  withScope(callback: (scope: SentryScope) => void): void
}

const logLevelToSentrySeverity: Record<LogLevelType, SentrySeverityLevel> = {
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warning',
  [LogLevel.Error]: 'error',
}

/**
 * Creates a Sentry transport for logging.
 *
 * - Adds breadcrumbs for all log entries
 * - Captures messages for error/warn levels
 * - Captures exceptions for Error objects
 *
 * @param sentry - Sentry runtime instance (e.g., from @sentry/react-native)
 * @returns A LogTransport function
 *
 * @example
 * ```typescript
 * import * as Sentry from '@sentry/react-native'
 * const sentryTransport = createSentryTransport(Sentry)
 * logger.addTransport(sentryTransport)
 * ```
 */
const sanitizeTags = (raw: unknown): Record<string, string> | null => {
  if (raw == null || typeof raw !== 'object') return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : null
}

export const createSentryTransport = (sentry: SentryRuntime): LogTransport => {
  return ({level, message, metadata, timestamp}: LogTransportOptions): void => {
    const messageStr = message instanceof Error ? message.message : message
    const severity = logLevelToSentrySeverity[level]
    const {origin, type, tags: rawTags, ...extra} = metadata
    const tags = sanitizeTags(rawTags)

    const hasExtraData = Object.keys(extra).length > 0

    sentry.addBreadcrumb({
      type: type ?? 'default',
      category: origin ?? 'app',
      message: messageStr,
      level: severity,
      ...(hasExtraData && {data: extra}),
      timestamp: timestamp / 1000,
    })

    const shouldCapture = level === LogLevel.Error || level === LogLevel.Warn
    if (!shouldCapture) return

    // Promote `metadata.tags` to Sentry tags via `withScope` so support can
    // filter Issues by an error reference / chain / errorCode without
    // digging through breadcrumb data on each event. `origin` always
    // travels with the event so the fallback path and the scoped path
    // both attach it — gating on `hasExtraData` alone would silently drop
    // origin for events that carry tags but no other extras.
    if (tags || hasExtraData) {
      sentry.withScope((scope) => {
        if (tags) scope.setTags(tags)
        const scopedExtras: Record<string, unknown> = hasExtraData ? {...extra} : {}
        if (origin !== undefined) scopedExtras.origin = origin
        if (Object.keys(scopedExtras).length > 0) scope.setExtras(scopedExtras)
        if (level === LogLevel.Error && message instanceof Error) {
          scope.captureException(message)
        } else {
          scope.captureMessage(messageStr, severity)
        }
      })
      return
    }

    if (level === LogLevel.Error && message instanceof Error) {
      sentry.captureException(message, {extra: {origin}})
    } else {
      sentry.captureMessage(messageStr, severity)
    }
  }
}
