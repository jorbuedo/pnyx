/**
 * Types for the storage-migrations framework.
 *
 * @module
 */

import {Data} from 'effect'

/**
 * A single forward migration step.
 *
 * Transforms the value from one version to the next. Must be pure — no I/O,
 * no Effect, no async. The `from` and `to` must be contiguous integers
 * (`to === from + 1`); the registry throws at construction if a chain has
 * gaps, duplicates, or non-contiguous steps.
 *
 * The input is `unknown` because, by construction, the previous version's
 * type may have evolved. Do narrowing inside the function; throw (or return
 * a shape `validate` will reject) if the input doesn't match what this step
 * expects.
 */
export type Migration<From = unknown, To = unknown> = {
  readonly from: number
  readonly to: number
  readonly migrate: (prev: From) => To
}

/**
 * The persisted shape — every value written through the framework is wrapped
 * in this envelope. Kept intentionally minimal: anything richer (e.g. a
 * `migratedAt` timestamp) can be derived from Sentry breadcrumbs instead.
 */
export type VersionedBlob<T = unknown> = {
  readonly version: number
  readonly data: T
}

/**
 * Why a stored blob was quarantined. Fed to the quarantine side-effect and
 * to any caller-provided hook so Sentry / logs can record the specific
 * failure mode.
 */
export type QuarantineReason =
  | {readonly kind: 'parse-failed'; readonly error: unknown}
  | {readonly kind: 'unknown-version'; readonly version: number}
  | {
      /**
       * Stored data is at a version the chain can't migrate from — the
       * lowest `from` in the chain is greater than `fromVersion`. Fires
       * when, for example, the chain is `[{from: 2, to: 3}]` but the
       * stored blob is at v1 or v0 (legacy). Without this guard the v2→v3
       * step would silently run on v1 shapes and corrupt the output.
       */
      readonly kind: 'unreachable-version'
      readonly version: number
      readonly minSupported: number
    }
  | {readonly kind: 'migration-failed'; readonly from: number; readonly to: number; readonly error: unknown}
  | {readonly kind: 'validation-failed'; readonly finalValue: unknown}

/**
 * Outcome of a single `loadVersioned` run. Emitted via the optional
 * `onOutcome` hook (and, eventually, Sentry breadcrumbs) so callers can
 * observe what the framework did without interpreting return values.
 */
export type LoadOutcome =
  | {readonly kind: 'missing'}
  | {readonly kind: 'no-op'; readonly version: number; readonly durationMs: number}
  | {readonly kind: 'migrated'; readonly from: number; readonly to: number; readonly durationMs: number}
  | {readonly kind: 'quarantined'; readonly reason: QuarantineReason; readonly durationMs: number}

/**
 * Configuration for a versioned storage blob.
 *
 * One instance per persisted key. Lives with the consuming package — the
 * framework itself holds no registry, so `@pnyx/migrations` doesn't know
 * which keys exist. This keeps the framework decoupled from every consumer.
 */
export type MigrationConfig<T> = {
  /** Raw storage key. */
  readonly key: string
  /** The version the application currently writes. Must be `>= 1`. */
  readonly currentVersion: number
  /**
   * Ordered chain of forward migrations. For a new blob (no on-disk data
   * yet) this can be empty — `currentVersion = 1` and no migrations is
   * valid. For pre-existing unversioned data (legacy detection), include a
   * `v0 → v1` migration that wraps the raw value unchanged; it's just a
   * stamp, but it keeps the chain contiguous.
   */
  readonly migrations: ReadonlyArray<Migration>
  /**
   * Narrowing guard applied to the final migrated value. If it returns
   * `false`, the blob is quarantined (treated as missing from the caller's
   * perspective). This is the only place the framework knows `T`'s shape —
   * migrations themselves deal in `unknown`.
   */
  readonly validate: (value: unknown) => value is T
  /**
   * Optional hook for every outcome (missing / no-op / migrated /
   * quarantined). Wire this to Sentry + logger at the call site.
   */
  readonly onOutcome?: (outcome: LoadOutcome) => void
}

/**
 * Raised only when the migration chain itself is malformed — not for
 * runtime data issues. Surfaces on the first `validateChain(config)` call
 * (usually the first `loadVersioned` / `saveVersioned` after module init);
 * subsequent calls with the same config are no-ops, so a malformed chain
 * will always fire once, early, and never twice.
 */
export class MigrationChainError extends Data.TaggedError('MigrationChainError')<{
  readonly key: string
  readonly message: string
}> {}
