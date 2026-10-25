/**
 * Effect-based logger service.
 *
 * Provides an Effect service wrapper around the logger for use in Effect-based packages.
 * Apps provide a Layer with their configured logger (with Sentry, transports, etc).
 *
 * @module
 */

import {Context, Effect, Layer} from 'effect'
import {consoleTransport, createLogger} from './logger.js'
import type {Logger as LoggerImpl, LogMetadata} from './types.js'

/**
 * Effect logger service interface.
 * Methods return Effect for composition in Effect.gen blocks.
 */
export type LoggerService = {
  readonly debug: (message: string, metadata?: LogMetadata) => Effect.Effect<void>
  readonly info: (message: string, metadata?: LogMetadata) => Effect.Effect<void>
  readonly warn: (message: string, metadata?: LogMetadata) => Effect.Effect<void>
  readonly error: (message: string | Error, metadata?: LogMetadata) => Effect.Effect<void>
}

/**
 * Effect service tag for LoggerService.
 */
export const LoggerService = Context.GenericTag<LoggerService>('LoggerService')

/**
 * Create a LoggerService Layer from an existing logger instance.
 *
 * @param logger - The logger instance (from createLogger)
 * @returns Layer providing LoggerService
 *
 * @example
 * ```typescript
 * import {createLogger, makeLoggerLayer} from '@pnyx/logger'
 *
 * const myLogger = createLogger({level: 'debug'})
 * myLogger.addTransport(consoleTransport)
 * myLogger.addTransport(sentryTransport)
 *
 * const LoggerLayer = makeLoggerLayer(myLogger)
 *
 * // Use in Effect
 * Effect.runPromise(
 *   myEffect.pipe(Effect.provide(LoggerLayer))
 * )
 * ```
 */
export const makeLoggerLayer = (logger: LoggerImpl): Layer.Layer<LoggerService> =>
  Layer.succeed(LoggerService, {
    debug: (message, metadata) => Effect.sync(() => logger.debug(message, metadata)),
    info: (message, metadata) => Effect.sync(() => logger.info(message, metadata)),
    warn: (message, metadata) => Effect.sync(() => logger.warn(message, metadata)),
    error: (message, metadata) => Effect.sync(() => logger.error(message, metadata)),
  })

/**
 * Default LoggerService layer with console output.
 * Useful for testing, CLI tools, or when no custom logger is needed.
 */
export const LoggerServiceLive: Layer.Layer<LoggerService> = makeLoggerLayer(
  (() => {
    const logger = createLogger({level: 'debug'})
    logger.addTransport(consoleTransport)
    return logger
  })(),
)

/**
 * Silent LoggerService layer that discards all logs.
 * Useful for tests where log output is not wanted.
 */
export const LoggerServiceSilent: Layer.Layer<LoggerService> = Layer.succeed(LoggerService, {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
})

/**
 * Convenience functions for logging with automatic service resolution.
 * Use these in Effect.gen blocks without manually yielding the service.
 *
 * @example
 * ```typescript
 * import {log} from '@pnyx/logger'
 *
 * const myEffect = Effect.gen(function* () {
 *   yield* log.info('Starting process', {origin: 'my-package'})
 *   // ... do work
 *   yield* log.debug('Process complete', {duration: 123})
 * })
 * ```
 */
export const log = {
  debug: (message: string, metadata?: LogMetadata): Effect.Effect<void, never, LoggerService> =>
    Effect.flatMap(LoggerService, (logger) => logger.debug(message, metadata)),

  info: (message: string, metadata?: LogMetadata): Effect.Effect<void, never, LoggerService> =>
    Effect.flatMap(LoggerService, (logger) => logger.info(message, metadata)),

  warn: (message: string, metadata?: LogMetadata): Effect.Effect<void, never, LoggerService> =>
    Effect.flatMap(LoggerService, (logger) => logger.warn(message, metadata)),

  error: (message: string | Error, metadata?: LogMetadata): Effect.Effect<void, never, LoggerService> =>
    Effect.flatMap(LoggerService, (logger) => logger.error(message, metadata)),
}
