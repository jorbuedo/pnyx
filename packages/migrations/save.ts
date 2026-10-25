/**
 * Save a value through the framework — wraps in an envelope at
 * `config.currentVersion` and writes.
 *
 * @module
 */

import {Storage, type StorageError} from '@pnyx/storage/types'
import {Data, Effect} from 'effect'
import {validateChain} from './chain.js'
import {serializeEnvelope} from './envelope.js'
import type {MigrationConfig} from './types.js'

/**
 * Raised when `saveVersioned` is asked to persist a value that doesn't
 * pass the config's own `validate` guard. Catches producer-side bugs at
 * the code path that caused them, rather than letting the bad shape hit
 * disk and get quarantined on the next load.
 */
export class InvalidValueError extends Data.TaggedError('InvalidValueError')<{
  readonly key: string
  readonly message: string
}> {}

export const saveVersioned = <T>(
  config: MigrationConfig<T>,
  value: T,
): Effect.Effect<void, StorageError | InvalidValueError, Storage> =>
  Effect.gen(function* () {
    validateChain(config)
    // Gate saves on the same validator the load path uses. A producer bug
    // that generates a wrong shape fails here with a stack pointing at the
    // caller, instead of surfacing half a session later when the loader
    // quarantines the blob. Small cost per save; bounded by the caller's
    // own validate.
    if (!config.validate(value)) {
      return yield* Effect.fail(
        new InvalidValueError({
          key: config.key,
          message: `value failed validation for ${config.key}; refusing to persist`,
        }),
      )
    }
    const storage = yield* Storage
    yield* storage.set(config.key, serializeEnvelope(config.currentVersion, value))
  })
