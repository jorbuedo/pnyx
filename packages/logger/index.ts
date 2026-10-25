/**
 * Logger package - platform-agnostic logging system.
 * @module
 */

export {consoleTransport, createLogger} from './logger.js'
export {looksLikeMnemonic, REDACTED, redactLogMessage, redactMetadata, SECRET_KEY_PATTERN} from './redact.js'
export {getLogger, loggerRegistry} from './registry.js'
export type {LoggerService as LoggerServiceType} from './service.js'
// Effect service
export {LoggerService, LoggerServiceLive, LoggerServiceSilent, log, makeLoggerLayer} from './service.js'
export type {LogEntry, Logger, LogMessage, LogMetadata, LogTransport, LogTransportOptions} from './types.js'
export {LogLevel} from './types.js'
