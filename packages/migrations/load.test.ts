import {createMemoryStorage} from '@pnyx/storage/memory'
import {Storage, StorageError} from '@pnyx/storage/types'
import {Effect, Layer, Option} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {serializeEnvelope} from './envelope.js'
import {loadVersioned} from './load.js'
import {logger as migrationsLogger} from './logger.js'
import {saveVersioned} from './save.js'
import type {LoadOutcome, Migration, MigrationConfig} from './types.js'

type V1 = {readonly name: string}
type V2 = {readonly firstName: string; readonly lastName: string}
type V3 = {readonly fullName: string}

const isV3 = (v: unknown): v is V3 =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).fullName === 'string'

const isV1 = (v: unknown): v is V1 =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).name === 'string'

// v0 → v1 is identity — wraps existing unversioned data unchanged.
const v0ToV1: Migration<unknown, V1> = {
  from: 0,
  to: 1,
  migrate: (prev) => {
    if (!isV1(prev)) throw new Error('v0→v1: expected {name}')
    return prev
  },
}

// v1 → v2 splits the single name into first + last.
const v1ToV2: Migration<V1, V2> = {
  from: 1,
  to: 2,
  migrate: (prev) => {
    const [firstName = '', lastName = ''] = prev.name.split(' ', 2)
    return {firstName, lastName}
  },
}

// v2 → v3 collapses back to a single field.
const v2ToV3: Migration<V2, V3> = {
  from: 2,
  to: 3,
  migrate: (prev) => ({fullName: `${prev.firstName} ${prev.lastName}`.trim()}),
}

const makeConfig = (overrides: Partial<MigrationConfig<V3>> = {}): MigrationConfig<V3> => ({
  key: 'user',
  currentVersion: 3,
  migrations: [v0ToV1 as Migration, v1ToV2 as Migration, v2ToV3 as Migration],
  validate: isV3,
  ...overrides,
})

const runWithStorage = <A, E>(
  storage: ReturnType<typeof createMemoryStorage>,
  effect: Effect.Effect<A, E, Storage>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Storage, storage))) as Effect.Effect<A, E>)

describe('loadVersioned', () => {
  it('returns none when the key is missing', async () => {
    const storage = createMemoryStorage()
    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))
    expect(Option.isNone(result)).toBe(true)
    expect(outcomes).toEqual([{kind: 'missing'}])
  })

  it('reports no-op when data is already at currentVersion', async () => {
    const storage = createMemoryStorage()
    await runWithStorage(storage, saveVersioned(makeConfig(), {fullName: 'Ada Lovelace'}))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.getOrThrow(result)).toEqual({fullName: 'Ada Lovelace'})
    expect(outcomes[0]?.kind).toBe('no-op')
  })

  it('migrates legacy (unversioned) data through the full chain', async () => {
    const storage = createMemoryStorage()
    // Legacy write — raw JSON with no envelope.
    await Effect.runPromise(storage.set('user', JSON.stringify({name: 'Ada Lovelace'})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.getOrThrow(result)).toEqual({fullName: 'Ada Lovelace'})
    expect(outcomes[0]).toMatchObject({kind: 'migrated', from: 0, to: 3})
  })

  it('stamps the migrated envelope back to storage so subsequent loads are no-ops', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', JSON.stringify({name: 'Ada Lovelace'})))

    const outcomes: LoadOutcome[] = []

    // First load: legacy detected, chain runs, envelope stamped back.
    const first = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))
    expect(Option.getOrThrow(first)).toEqual({fullName: 'Ada Lovelace'})
    expect(outcomes[0]).toMatchObject({kind: 'migrated', from: 0, to: 3})

    // The stored blob must now be at currentVersion — subsequent readers
    // see the envelope directly.
    const raw = await Effect.runPromise(storage.get('user'))
    expect(JSON.parse(raw ?? '')).toEqual({version: 3, data: {fullName: 'Ada Lovelace'}})

    // Second load: no migration, outcome must be no-op (not migrated again).
    const second = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))
    expect(Option.getOrThrow(second)).toEqual({fullName: 'Ada Lovelace'})
    expect(outcomes[1]?.kind).toBe('no-op')
  })

  it('returns the migrated value even if stamp-back write fails', async () => {
    // Seed legacy data, then swap set() for one that always fails, so the
    // stamp-back goes to the broken path and the load result is still
    // returned from the in-memory migrated value.
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', JSON.stringify({name: 'Ada Lovelace'})))
    let setAttempts = 0
    const failingStorage = {
      ...storage,
      set: (_key: string, _value: string) => {
        setAttempts++
        return Effect.fail(new StorageError({message: 'backend down'}))
      },
    }

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(
      failingStorage as ReturnType<typeof createMemoryStorage>,
      loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})),
    )

    expect(Option.getOrThrow(result)).toEqual({fullName: 'Ada Lovelace'})
    expect(outcomes[0]?.kind).toBe('migrated')
    // Exactly one set() attempt — the stamp-back — and it failed silently.
    expect(setAttempts).toBe(1)
  })

  it('migrates from an intermediate version', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', serializeEnvelope(2, {firstName: 'Ada', lastName: 'Lovelace'})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.getOrThrow(result)).toEqual({fullName: 'Ada Lovelace'})
    expect(outcomes[0]).toMatchObject({kind: 'migrated', from: 2, to: 3})
  })

  it('quarantines invalid JSON and returns none', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', 'not-json{'))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({kind: 'quarantined', reason: {kind: 'parse-failed'}})
    // Original removed.
    const remaining = await Effect.runPromise(storage.get('user'))
    expect(remaining).toBeNull()
    // Quarantine copy preserved.
    const allKeys = await Effect.runPromise(storage.keys())
    expect(allKeys.some((k) => k.startsWith('user:quarantined:'))).toBe(true)
  })

  it('quarantines when the chain does not start low enough to cover the stored version', async () => {
    // A chain that only has v2→v3 claims to support currentVersion=3 — but
    // has no way to migrate v0 or v1 data. validateChain accepts this
    // (it's contiguous within itself), so the safety net has to live at
    // load time. Without it, the v2→v3 step would silently run on v1 data
    // and produce a nonsensical output.
    type V3 = {readonly fullName: string}
    const isV3 = (v: unknown): v is V3 =>
      typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).fullName === 'string'
    const partialChainConfig: MigrationConfig<V3> = {
      key: 'user',
      currentVersion: 3,
      migrations: [
        {
          from: 2,
          to: 3,
          migrate: () => ({fullName: 'WRONG — should not be called'}),
        },
      ],
      validate: isV3,
    }

    const storage = createMemoryStorage()
    // Stored at v1: the chain starts at v2, so this is unreachable.
    await Effect.runPromise(storage.set('user', serializeEnvelope(1, {firstName: 'Ada', lastName: 'Lovelace'})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(
      storage,
      loadVersioned({...partialChainConfig, onOutcome: (o) => outcomes.push(o)}),
    )

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({
      kind: 'quarantined',
      reason: {kind: 'unreachable-version', version: 1, minSupported: 2},
    })
  })

  it('quarantines legacy (v0) data when the chain does not include a v0→v1 step', async () => {
    type V3 = {readonly fullName: string}
    const isV3 = (v: unknown): v is V3 =>
      typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).fullName === 'string'
    const noLegacyConfig: MigrationConfig<V3> = {
      key: 'user',
      currentVersion: 3,
      migrations: [
        {from: 1, to: 2, migrate: () => ({firstName: 'wrong', lastName: 'wrong'})},
        {from: 2, to: 3, migrate: () => ({fullName: 'WRONG'})},
      ],
      validate: isV3,
    }

    const storage = createMemoryStorage()
    // Pre-framework unversioned data — fromVersion becomes 0.
    await Effect.runPromise(storage.set('user', JSON.stringify({name: 'Ada Lovelace'})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned({...noLegacyConfig, onOutcome: (o) => outcomes.push(o)}))

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({
      kind: 'quarantined',
      reason: {kind: 'unreachable-version', version: 0, minSupported: 1},
    })
  })

  it('quarantines when stored version is newer than currentVersion', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', serializeEnvelope(99, {anything: 'goes'})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({kind: 'quarantined', reason: {kind: 'unknown-version', version: 99}})
  })

  it('quarantines when a migration throws', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', serializeEnvelope(1, {wrongShape: true})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({
      kind: 'quarantined',
      reason: {kind: 'migration-failed', from: 1, to: 2},
    })
  })

  it('quarantines when final validation rejects the migrated shape', async () => {
    const storage = createMemoryStorage()
    // Intentionally broken final migration: claims to produce v3 but drops `fullName`.
    const brokenV2ToV3: Migration<V2, Record<string, unknown>> = {
      from: 2,
      to: 3,
      migrate: () => ({somethingElse: true}),
    }
    const config = makeConfig({
      migrations: [v0ToV1 as Migration, v1ToV2 as Migration, brokenV2ToV3 as Migration],
    })
    await Effect.runPromise(storage.set('user', serializeEnvelope(2, {firstName: 'A', lastName: 'B'})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned({...config, onOutcome: (o) => outcomes.push(o)}))

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({kind: 'quarantined', reason: {kind: 'validation-failed'}})
  })

  it('quarantines when at-currentVersion data fails validation', async () => {
    const storage = createMemoryStorage()
    // Envelope says v3 but the payload doesn't have `fullName`.
    await Effect.runPromise(storage.set('user', serializeEnvelope(3, {unrelated: true})))

    const outcomes: LoadOutcome[] = []
    const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: (o) => outcomes.push(o)})))

    expect(Option.isNone(result)).toBe(true)
    expect(outcomes[0]).toMatchObject({kind: 'quarantined', reason: {kind: 'validation-failed'}})
  })

  it('keeps the app running even if onOutcome throws, but emits via the framework logger', async () => {
    const storage = createMemoryStorage()
    await runWithStorage(storage, saveVersioned(makeConfig(), {fullName: 'Ada Lovelace'}))

    const throwing = vi.fn(() => {
      throw new Error('observability glitch')
    })
    // Attach a temporary transport to the framework logger so we can verify
    // the broken-hook diagnostic is surfaced. In real apps this transport
    // is the Sentry one; here we capture entries into an array. Logger's
    // addTransport returns a disposer.
    const entries: Array<{level: string; message: unknown; metadata: Record<string, unknown>}> = []
    const removeTransport = migrationsLogger.addTransport(({level, message, metadata}) => {
      entries.push({level, message, metadata})
    })

    try {
      const result = await runWithStorage(storage, loadVersioned(makeConfig({onOutcome: throwing})))
      expect(Option.isSome(result)).toBe(true)
      expect(throwing).toHaveBeenCalled()
      // A broken hook should still produce *some* signal — otherwise a wrong
      // Sentry wire would silence every real quarantine.
      const warning = entries.find((e) => e.level === 'warn' && e.message === 'onOutcome hook threw')
      expect(warning).toBeDefined()
      expect(warning?.metadata).toMatchObject({origin: 'migrations', key: 'user', outcomeKind: 'no-op'})
      // Stack included so a broken transport is diagnosable from the log alone.
      expect(typeof warning?.metadata.stack).toBe('string')
      expect(warning?.metadata.stack as string).toContain('Error')
    } finally {
      removeTransport()
    }
  })
})

describe('saveVersioned + loadVersioned round-trip', () => {
  it('writes the envelope and reads it back at the expected version', async () => {
    const storage = createMemoryStorage()
    await runWithStorage(storage, saveVersioned(makeConfig(), {fullName: 'Grace Hopper'}))

    const raw = await Effect.runPromise(storage.get('user'))
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw ?? '')
    expect(parsed).toEqual({version: 3, data: {fullName: 'Grace Hopper'}})

    const loaded = await runWithStorage(storage, loadVersioned(makeConfig()))
    expect(Option.getOrThrow(loaded)).toEqual({fullName: 'Grace Hopper'})
  })
})
