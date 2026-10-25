/**
 * Named-logger registry.
 *
 * Each package gets its own logger via `getLogger('<name>')` instead of a
 * standalone `createLogger()`. All named loggers share the registry's
 * transports — calling `loggerRegistry.addTransport(t)` once fans `t` out
 * to every logger that's been (or will be) created via `getLogger`.
 *
 * `createLogger()` keeps its original behaviour (isolated logger, own
 * transports, own trail) — use it in tests or anywhere isolation matters.
 *
 * Order is irrelevant: packages can call `getLogger(name)` at module-import
 * time (before any transport is attached) and still get every transport
 * the app later registers. Transports added after a logger is created
 * propagate immediately; named loggers created later also pick up every
 * transport already in the registry.
 *
 * @module
 */
import {createLogger} from './logger.js'
import type {Logger, LogLevel, LogTransport} from './types.js'

type NamedLoggerEntry = {
  readonly name: string
  readonly logger: Logger
  /** Per-transport unsubscribe handles, keyed by the transport function. */
  readonly transportUnsubs: Map<LogTransport, () => void>
}

const named = new Map<string, NamedLoggerEntry>()
const registryTransports = new Set<LogTransport>()
const registryLevelOverride: {current: LogLevel | null} = {current: null}

/**
 * Return the named logger for `name`, creating it if necessary.
 *
 * Subsequent calls with the same name return the same instance, so it's
 * safe to call from module scope without worrying about duplication.
 *
 * Newly-created loggers inherit every transport currently registered on
 * the registry plus the active level override (if any).
 */
export const getLogger = (
  name: string,
  options?: {readonly level?: LogLevel; readonly trailMaxSize?: number},
): Logger => {
  const existing = named.get(name)
  if (existing) return existing.logger

  const logger = createLogger(options)
  if (registryLevelOverride.current !== null) {
    logger.setLevel(registryLevelOverride.current)
  }
  const transportUnsubs = new Map<LogTransport, () => void>()
  for (const transport of registryTransports) {
    transportUnsubs.set(transport, logger.addTransport(transport))
  }
  named.set(name, {name, logger, transportUnsubs})
  return logger
}

/**
 * Registry-level controls. Transports + level apply to every logger
 * obtained via {@link getLogger}, both already-created and future.
 *
 * `createLogger()` instances are NOT affected — they have their own
 * isolated state by design.
 */
export const loggerRegistry = {
  /**
   * Attach a transport to every named logger. Returns an unsubscribe
   * that detaches it from all of them. Safe to call before any logger
   * is created — future `getLogger` calls will inherit it.
   */
  addTransport(transport: LogTransport): () => void {
    if (registryTransports.has(transport)) {
      // Idempotent: same transport already wired. Returning a no-op
      // unsubscribe rather than throwing keeps app boot resilient to
      // accidental double-registration (e.g. HMR re-running the wiring
      // module).
      return () => {
        // intentional no-op
      }
    }
    registryTransports.add(transport)
    for (const entry of named.values()) {
      entry.transportUnsubs.set(transport, entry.logger.addTransport(transport))
    }
    return () => {
      if (!registryTransports.has(transport)) return
      registryTransports.delete(transport)
      for (const entry of named.values()) {
        const unsub = entry.transportUnsubs.get(transport)
        if (unsub) {
          unsub()
          entry.transportUnsubs.delete(transport)
        }
      }
    }
  },

  /**
   * Set the level on every named logger. Persisted so future
   * `getLogger` calls also start at this level.
   */
  setLevel(level: LogLevel): void {
    registryLevelOverride.current = level
    for (const entry of named.values()) {
      entry.logger.setLevel(level)
    }
  },

  /** Snapshot of every named logger currently in the registry. */
  getNamedLoggers(): ReadonlyArray<{readonly name: string; readonly logger: Logger}> {
    return Array.from(named.values(), ({name, logger}) => ({name, logger}))
  },

  /**
   * Drop every named logger + transport. Test-only — production code
   * should never need this. Exposed so a test suite can reset the
   * module-level singleton state between cases.
   */
  reset(): void {
    for (const entry of named.values()) {
      for (const unsub of entry.transportUnsubs.values()) unsub()
    }
    named.clear()
    registryTransports.clear()
    registryLevelOverride.current = null
  },
}
