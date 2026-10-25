/**
 * Storage-migrations framework.
 *
 * Wraps `@pnyx/storage` with versioned envelopes + forward-only
 * migrations + quarantine-on-failure. Binary blobs (`@pnyx/store`
 * snapshots) and encrypted blobs are out of scope — see
 * docs/STORAGE_MIGRATIONS.md.
 *
 * @module
 */

export {stepsFrom, validateChain} from './chain.js'
export {type EnvelopeParse, parseEnvelope, serializeEnvelope} from './envelope.js'
export {loadVersioned} from './load.js'
export {logger} from './logger.js'
export {buildQuarantineKey, QUARANTINE_KEEP, quarantine} from './quarantine.js'
export {InvalidValueError, saveVersioned} from './save.js'
export {
  type LoadOutcome,
  type Migration,
  MigrationChainError,
  type MigrationConfig,
  type QuarantineReason,
  type VersionedBlob,
} from './types.js'
