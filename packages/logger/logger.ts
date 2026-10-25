/**
 * Core logger implementation.
 * @module
 */

import {redactLogMessage, redactMetadata} from './redact.js'
import type {LogEntry, Logger, LogLevel, LogMessage, LogMetadata, LogTransport, LogTransportOptions} from './types.js'
import {LogLevel as LogLevelEnum} from './types.js'

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

const DEFAULT_TRAIL_MAX_SIZE = 1000

let idCounter = 0
const generateId = (): string => {
  idCounter += 1
  return `log-${Date.now()}-${idCounter}`
}

/**
 * Console transport for development logging.
 * Outputs formatted log messages to the console with timestamps and metadata.
 */
export const consoleTransport: LogTransport = ({level, message, metadata, timestamp}: LogTransportOptions): void => {
  const date = new Date(timestamp)
  const timeStr = date.toISOString()
  const origin = metadata.origin ? `[${metadata.origin}]` : ''
  const messageStr = message instanceof Error ? message.message : message

  const {origin: _origin, type: _type, ...rest} = metadata
  const hasExtra = Object.keys(rest).length > 0
  const extraStr = hasExtra ? ` ${JSON.stringify(rest)}` : ''

  const formattedMessage = `${timeStr} ${level.toUpperCase().padEnd(5)} ${origin} ${messageStr}${extraStr}`

  switch (level) {
    case LogLevelEnum.Error:
      if (message instanceof Error) {
        console.warn(formattedMessage, message)
      } else {
        console.warn(formattedMessage)
      }
      break
    case LogLevelEnum.Warn:
      console.warn(formattedMessage)
      break
    case LogLevelEnum.Info:
      console.info(formattedMessage)
      break
    case LogLevelEnum.Debug:
      console.debug(formattedMessage)
      break
  }
}

/**
 * Creates a new logger instance.
 *
 * @param options - Logger configuration options
 * @returns A new logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger({level: 'debug'})
 * logger.addTransport(consoleTransport)
 * logger.info('Hello', {origin: 'MyService'})
 * ```
 */
export const createLogger = (options?: {level?: LogLevel; trailMaxSize?: number}): Logger => {
  let enabled = true
  let currentLevel: LogLevel = options?.level ?? LogLevelEnum.Info
  let filter: RegExp | null = null
  const trailMaxSize = options?.trailMaxSize ?? DEFAULT_TRAIL_MAX_SIZE
  const transports: Set<LogTransport> = new Set()
  const trail: LogEntry[] = []

  const shouldLog = (level: LogLevel, metadata: LogMetadata): boolean => {
    if (!enabled) return false
    const levelPriority = LOG_LEVEL_PRIORITY[level]
    const currentLevelPriority = LOG_LEVEL_PRIORITY[currentLevel]
    if (levelPriority > currentLevelPriority) return false
    if (filter !== null) {
      const origin = metadata.origin ?? ''
      if (!filter.test(origin)) return false
    }
    return true
  }

  const addToTrail = (entry: LogEntry): void => {
    trail.push(entry)
    if (trail.length > trailMaxSize) {
      trail.shift()
    }
  }

  const log = (level: LogLevel, message: LogMessage, metadata: LogMetadata = {}): void => {
    if (!shouldLog(level, metadata)) return

    const timestamp = Date.now()
    // Scrub once, here, before the entry can reach either destination. The trail
    // is not exempt: it gets attached to crash reports, so it is an exfiltration
    // surface exactly like a transport (Phase 16 item 44). Filtering runs on the
    // caller's metadata first, so a `shouldLog` rule can still key off a value
    // that is about to be redacted.
    const safeMessage = redactLogMessage(message)
    const safeMetadata = redactMetadata(metadata)
    const messageStr = safeMessage instanceof Error ? safeMessage.message : safeMessage

    const entry: LogEntry = {
      id: generateId(),
      level,
      message: messageStr,
      metadata: safeMetadata,
      timestamp,
    }

    addToTrail(entry)

    const transportOptions: LogTransportOptions = {
      level,
      message: safeMessage,
      metadata: safeMetadata,
      timestamp,
    }

    for (const transport of transports) {
      try {
        transport(transportOptions)
      } catch {
        // Silently ignore transport errors to prevent logging loops
      }
    }
  }

  return {
    get level() {
      return currentLevel
    },

    get trail() {
      return trail as readonly LogEntry[]
    },

    get filter() {
      return filter
    },

    debug(message: string, metadata?: LogMetadata): void {
      log(LogLevelEnum.Debug, message, metadata)
    },

    info(message: string, metadata?: LogMetadata): void {
      log(LogLevelEnum.Info, message, metadata)
    },

    warn(message: string, metadata?: LogMetadata): void {
      log(LogLevelEnum.Warn, message, metadata)
    },

    error(error: Error | string, metadata?: LogMetadata): void {
      log(LogLevelEnum.Error, error, metadata)
    },

    addTransport(transport: LogTransport): () => void {
      transports.add(transport)
      return () => {
        transports.delete(transport)
      }
    },

    enable(): void {
      enabled = true
    },

    disable(): void {
      enabled = false
    },

    setLevel(level: LogLevel): void {
      currentLevel = level
    },

    setFilter(newFilter: RegExp | null): void {
      filter = newFilter
    },

    clearTrail(): void {
      trail.length = 0
    },
  }
}
