/**
 * Logger types.
 * @module
 */

export const LogLevel = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
} as const

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

export type LogMessage = string | Error

export type LogMetadata = {
  /** Sentry breadcrumb type */
  type?: 'default' | 'debug' | 'error' | 'navigation' | 'http' | 'info' | 'query' | 'transaction' | 'ui' | 'user'
  /** Source module/package */
  origin?: string
  /** Additional fields */
  [key: string]: unknown
}

export type LogEntry = {
  id: string
  level: LogLevel
  message: string
  metadata: LogMetadata
  timestamp: number
}

export type LogTransportOptions = {
  level: LogLevel
  message: LogMessage
  metadata: LogMetadata
  timestamp: number
}

export type LogTransport = (options: LogTransportOptions) => void

export type Logger = {
  readonly level: LogLevel
  readonly trail: readonly LogEntry[]
  readonly filter: RegExp | null
  debug(message: string, metadata?: LogMetadata): void
  info(message: string, metadata?: LogMetadata): void
  warn(message: string, metadata?: LogMetadata): void
  error(error: Error | string, metadata?: LogMetadata): void
  addTransport(transport: LogTransport): () => void
  enable(): void
  disable(): void
  setLevel(level: LogLevel): void
  setFilter(filter: RegExp | null): void
  /** Remove all buffered trail entries. */
  clearTrail(): void
}
