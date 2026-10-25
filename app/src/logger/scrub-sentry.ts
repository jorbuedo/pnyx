/**
 * Scrub secret-shaped values out of Sentry payloads before they leave the device.
 *
 * `@pnyx/logger` already redacts at its own chokepoint, which covers everything
 * that goes *through* the logger. Sentry has three paths that do not:
 *
 * 1. **unhandled JS exceptions** it catches itself,
 * 2. **native crashes**, whose payloads it assembles without us,
 * 3. **auto-collected breadcrumbs** — console, network, navigation — including a
 *    stray `console.log` that never touched our logger.
 *
 * So this is the second half of Phase 16 item 44, wired as `beforeSend` and
 * `beforeBreadcrumb`. It reuses the logger's redactor rather than defining a
 * second policy: one place decides what a secret looks like, or the two drift and
 * the weaker one becomes the real behaviour.
 *
 * Pure and Sentry-typed only structurally, so it is testable without the SDK.
 *
 * @module
 */

import {looksLikeMnemonic, REDACTED, redactMetadata} from '@pnyx/logger'

/** The subset of a Sentry event this touches. Structural, so no SDK import is needed. */
export type ScrubbableEvent = {
  message?: string | {message?: string; formatted?: string}
  exception?: {values?: Array<{type?: string; value?: string}>}
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  tags?: Record<string, string>
  breadcrumbs?: ScrubbableBreadcrumb[]
}

export type ScrubbableBreadcrumb = {
  message?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

const scrubText = (value: string): string => (looksLikeMnemonic(value) ? REDACTED : value)

const scrubRecord = <T extends Record<string, unknown>>(record: T): T => redactMetadata(record) as T

/** Redact one breadcrumb. Returns it for `beforeBreadcrumb`, which expects the crumb or `null`. */
export const scrubBreadcrumb = (crumb: ScrubbableBreadcrumb): ScrubbableBreadcrumb => ({
  ...crumb,
  ...(crumb.message === undefined ? {} : {message: scrubText(crumb.message)}),
  ...(crumb.data === undefined ? {} : {data: scrubRecord(crumb.data)}),
})

/**
 * Redact an event in place of the caller's copy.
 *
 * Exception **types** are left alone: `InvalidMnemonicError` is a class name, not
 * a secret, and scrubbing it would break Sentry's grouping for no gain. Only
 * `value` — the human-readable message, which is where a stringified secret would
 * actually land — is scrubbed.
 *
 * `tags` are scrubbed by key too: they are indexed and searchable server-side, so
 * a secret in a tag is the worst placement of all.
 */
export const scrubSentryEvent = <T extends ScrubbableEvent>(event: T): T => ({
  ...event,
  ...(typeof event.message === 'string'
    ? {message: scrubText(event.message)}
    : event.message === undefined
      ? {}
      : {
          message: {
            ...event.message,
            ...(event.message.message === undefined ? {} : {message: scrubText(event.message.message)}),
            ...(event.message.formatted === undefined ? {} : {formatted: scrubText(event.message.formatted)}),
          },
        }),
  ...(event.exception?.values === undefined
    ? {}
    : {
        exception: {
          ...event.exception,
          values: event.exception.values.map((v) => ({
            ...v,
            ...(v.value === undefined ? {} : {value: scrubText(v.value)}),
          })),
        },
      }),
  ...(event.extra === undefined ? {} : {extra: scrubRecord(event.extra)}),
  ...(event.contexts === undefined ? {} : {contexts: scrubRecord(event.contexts)}),
  ...(event.tags === undefined ? {} : {tags: scrubRecord(event.tags)}),
  ...(event.breadcrumbs === undefined ? {} : {breadcrumbs: event.breadcrumbs.map(scrubBreadcrumb)}),
})
