/**
 * Load a versioned blob, running migrations as needed.
 *
 * Contract:
 * - Missing key → `Option.none`.
 * - Parse failure / unknown version / migration throw / validation reject →
 *   the blob is quarantined (original removed, copy saved at
 *   `{key}:quarantined:{timestamp}`) and we return `Option.none`. From the
 *   caller's perspective this is "data missing" — they proceed with a
 *   fresh state.
 * - Storage failure on the initial read → fails with `StorageError`
 *   (propagated through Effect). Never swallowed.
 * - Storage failure on stamp-back (the post-migration write) → swallowed
 *   silently; the caller still receives the migrated value. Next load
 *   re-runs the chain.
 *
 * After a successful migration, the result is persisted at `currentVersion`
 * so subsequent loads hit the no-op path. This keeps "every user migrates
 * exactly once" honest — without it, read-heavy blobs would re-run the
 * chain on every read.
 *
 * The outcome (`missing` / `no-op` / `migrated` / `quarantined`) is reported
 * via the optional `config.onOutcome` hook, which is where Sentry wiring
 * lives at the call site.
 *
 * @module
 */

import {Storage, type StorageError} from '@pnyx/storage/types'
import {Effect, Option} from 'effect'
import {stepsFrom, validateChain} from './chain.js'
import {parseEnvelope, serializeEnvelope} from './envelope.js'
import {logger} from './logger.js'
import {quarantine} from './quarantine.js'
import type {LoadOutcome, MigrationConfig, QuarantineReason} from './types.js'

const emit = <T>(config: MigrationConfig<T>, outcome: LoadOutcome): void => {
  try {
    config.onOutcome?.(outcome)
  } catch (error) {
    // Never let observability crash the load. Surface the broken hook
    // through the framework's own logger (a separate instance from
    // whatever the consumer wired into onOutcome, so a bug in one
    // doesn't silence the other). @pnyx/logger already catches
    // per-transport throws, so normally this is safe — but we wrap
    // defensively so our "observability never crashes the load"
    // invariant doesn't rely on that downstream guarantee holding
    // across future refactors. The stack is what makes a broken
    // transport diagnosable, so we pass both the message and stack
    // rather than flattening to a single string.
    try {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined
      logger.warn('onOutcome hook threw', {
        origin: 'migrations',
        key: config.key,
        outcomeKind: outcome.kind,
        error: errorMessage,
        ...(errorStack ? {stack: errorStack} : {}),
      })
    } catch {
      // Ultra-hostile env — logger itself threw synchronously. Nothing
      // further we can safely do; keep going.
    }
  }
}

/**
 * Apply the chain from `fromVersion` to `currentVersion`. Returns either
 * the migrated value or a structured reason for quarantine.
 */
const runMigrations = <T>(
  config: MigrationConfig<T>,
  fromVersion: number,
  value: unknown,
): {readonly ok: true; readonly value: unknown} | {readonly ok: false; readonly reason: QuarantineReason} => {
  let current = value
  for (const step of stepsFrom(config.migrations, fromVersion)) {
    try {
      current = step.migrate(current)
    } catch (error) {
      return {ok: false, reason: {kind: 'migration-failed', from: step.from, to: step.to, error}}
    }
  }
  return {ok: true, value: current}
}

/**
 * Load and, if necessary, migrate the blob at `config.key`.
 */
export const loadVersioned = <T>(config: MigrationConfig<T>): Effect.Effect<Option.Option<T>, StorageError, Storage> =>
  Effect.gen(function* () {
    validateChain(config)
    const storage = yield* Storage
    const started = Date.now()
    const raw = yield* storage.get(config.key)

    if (raw === null) {
      emit(config, {kind: 'missing'})
      return Option.none()
    }

    const parsed = parseEnvelope(raw)

    let fromVersion: number
    let value: unknown

    if (parsed.kind === 'invalid-json') {
      yield* quarantine(config.key, raw)
      const outcome: LoadOutcome = {
        kind: 'quarantined',
        reason: {kind: 'parse-failed', error: parsed.error},
        durationMs: Date.now() - started,
      }
      emit(config, outcome)
      return Option.none()
    }

    if (parsed.kind === 'legacy') {
      // Unwrapped pre-framework data — enter the chain at v0.
      fromVersion = 0
      value = parsed.raw
    } else {
      fromVersion = parsed.blob.version
      value = parsed.blob.data
    }

    // If the stored version is newer than the app's current, we can't
    // migrate forward — quarantine rather than guess.
    if (fromVersion > config.currentVersion) {
      yield* quarantine(config.key, raw)
      emit(config, {
        kind: 'quarantined',
        reason: {kind: 'unknown-version', version: fromVersion},
        durationMs: Date.now() - started,
      })
      return Option.none()
    }

    // Already at current — no migration needed, just validate and return.
    if (fromVersion === config.currentVersion) {
      if (!config.validate(value)) {
        yield* quarantine(config.key, raw)
        emit(config, {
          kind: 'quarantined',
          reason: {kind: 'validation-failed', finalValue: value},
          durationMs: Date.now() - started,
        })
        return Option.none()
      }
      emit(config, {kind: 'no-op', version: fromVersion, durationMs: Date.now() - started})
      return Option.some(value)
    }

    // Data-vs-chain guard: validateChain accepts chains that don't start
    // at v0 (e.g. `[{from:2,to:3}]` for a blob introduced at v2), because
    // it has no way to know what on-disk versions exist. At runtime we do
    // know — if the earliest step starts *above* the stored version, the
    // chain can't bridge the gap and running it anyway would silently
    // apply a later step to an earlier shape. Quarantine instead.
    const sortedSteps = stepsFrom(config.migrations, fromVersion)
    const firstStep = sortedSteps[0]
    if (firstStep && firstStep.from > fromVersion) {
      yield* quarantine(config.key, raw)
      emit(config, {
        kind: 'quarantined',
        reason: {kind: 'unreachable-version', version: fromVersion, minSupported: firstStep.from},
        durationMs: Date.now() - started,
      })
      return Option.none()
    }

    // Run the forward chain.
    const result = runMigrations(config, fromVersion, value)
    if (!result.ok) {
      yield* quarantine(config.key, raw)
      emit(config, {kind: 'quarantined', reason: result.reason, durationMs: Date.now() - started})
      return Option.none()
    }

    const migrated = result.value
    if (!config.validate(migrated)) {
      yield* quarantine(config.key, raw)
      emit(config, {
        kind: 'quarantined',
        reason: {kind: 'validation-failed', finalValue: migrated},
        durationMs: Date.now() - started,
      })
      return Option.none()
    }

    // Persist the migrated shape so subsequent loads hit the no-op path
    // instead of re-running the chain on every read. Without this, the
    // `migrated` outcome fires on every load for write-rare blobs — wastes
    // CPU, floods observability with spurious `migrated` events, and the
    // "every user migrates exactly once" guarantee in the architecture doc
    // would be a lie.
    //
    // Best-effort: if the write fails we still return the in-memory value
    // (the load did succeed) and next time we'll re-migrate. A failing
    // backend doesn't get to crash a read path.
    yield* storage.set(config.key, serializeEnvelope(config.currentVersion, migrated)).pipe(
      Effect.catchAll((e) => {
        logger.warn('migrated value could not be written back; the next load re-migrates', {
          origin: 'migrations',
          key: config.key,
          error: String(e),
        })
        return Effect.void
      }),
    )

    emit(config, {
      kind: 'migrated',
      from: fromVersion,
      to: config.currentVersion,
      durationMs: Date.now() - started,
    })
    return Option.some(migrated)
  })
