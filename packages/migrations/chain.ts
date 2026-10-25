/**
 * Migration chain validation + composition.
 *
 * @module
 */

import {type Migration, MigrationChainError, type MigrationConfig} from './types.js'

/**
 * Memoize validation results by config identity. `loadVersioned` and
 * `saveVersioned` both call `validateChain` on every invocation — without
 * memoization, the same static chain would be re-validated on every
 * user read/write. With this, the first call does the work and subsequent
 * calls are no-ops, so the docstring claim "validated on first use" is
 * accurate and per-call overhead is bounded to a WeakMap lookup.
 */
const validatedConfigs = new WeakMap<MigrationConfig<unknown>, true>()

/**
 * Validate that `migrations` forms a contiguous chain ending at
 * `currentVersion`. Throws `MigrationChainError` on any malformed chain.
 *
 * Memoized by config identity — the first call (usually during the
 * first `loadVersioned` / `saveVersioned` after module init) surfaces
 * errors immediately; subsequent calls with the same config object are
 * no-ops. Callers who want to fail eagerly at module init can invoke
 * `validateChain(config)` themselves.
 *
 * Accepts:
 * - An empty chain when `currentVersion === 1` (fresh blob, nothing to
 *   migrate from).
 * - A chain from `1 → currentVersion`: i.e. for `currentVersion = N` we
 *   require migrations with `from`s `[0, 1, 2, …, N-1]` and `to`s
 *   `[1, 2, …, N]`. The `from: 0` entry is the legacy-detection step that
 *   wraps an unversioned on-disk blob into the v1 envelope.
 */
export const validateChain = <T>(config: MigrationConfig<T>): void => {
  // WeakMap keys are typed against a single parameter; we carry unknown
  // through because validation doesn't depend on the concrete value type.
  if (validatedConfigs.has(config as MigrationConfig<unknown>)) return

  const {key, currentVersion, migrations} = config

  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new MigrationChainError({
      key,
      message: `currentVersion must be an integer >= 1, got ${currentVersion}`,
    })
  }

  if (migrations.length === 0) {
    // Fresh-blob case — valid only when nothing needs migrating.
    if (currentVersion !== 1) {
      throw new MigrationChainError({
        key,
        message: `currentVersion is ${currentVersion} but migrations[] is empty; the chain can only be empty at version 1`,
      })
    }
    validatedConfigs.set(config as MigrationConfig<unknown>, true)
    return
  }

  // Expect from-versions [0, 1, …, currentVersion - 1] in order.
  // `from: 0` is the legacy-detection slot; it's optional when no legacy
  // data exists, but the chain must still be contiguous from whatever its
  // lowest `from` is up to `currentVersion`.
  const sorted = [...migrations].sort((a, b) => a.from - b.from)
  const seen = new Set<number>()
  for (const m of sorted) {
    if (!Number.isInteger(m.from) || !Number.isInteger(m.to)) {
      throw new MigrationChainError({
        key,
        message: `migration from=${m.from} to=${m.to} has non-integer versions`,
      })
    }
    if (typeof m.migrate !== 'function') {
      throw new MigrationChainError({
        key,
        message: `migration from=${m.from} to=${m.to}: migrate must be a function`,
      })
    }
    if (m.to !== m.from + 1) {
      throw new MigrationChainError({
        key,
        message: `migration from=${m.from} to=${m.to}: to must equal from + 1`,
      })
    }
    if (seen.has(m.from)) {
      throw new MigrationChainError({
        key,
        message: `duplicate migration with from=${m.from}`,
      })
    }
    seen.add(m.from)
  }

  // Must end at currentVersion. `sorted` is non-empty here (early return
  // above handled the empty case), so the last element always exists.
  const last = sorted[sorted.length - 1]
  if (last === undefined) return // unreachable; keeps the type narrow
  if (last.to !== currentVersion) {
    throw new MigrationChainError({
      key,
      message: `chain ends at to=${last.to} but currentVersion is ${currentVersion}`,
    })
  }

  // Must be contiguous — no gaps between adjacent entries.
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i]
    const prev = sorted[i - 1]
    if (curr === undefined || prev === undefined) continue // unreachable
    if (curr.from !== prev.to) {
      throw new MigrationChainError({
        key,
        message: `gap in chain: ${prev.from}→${prev.to} then ${curr.from}→${curr.to}`,
      })
    }
  }

  validatedConfigs.set(config as MigrationConfig<unknown>, true)
}

/**
 * Return the subset of `migrations` that runs from `fromVersion` up to
 * `currentVersion`, in order. Assumes the chain has been validated.
 */
export const stepsFrom = (migrations: ReadonlyArray<Migration>, fromVersion: number): ReadonlyArray<Migration> => {
  return [...migrations].sort((a, b) => a.from - b.from).filter((m) => m.from >= fromVersion)
}
