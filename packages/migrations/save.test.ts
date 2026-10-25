import {createMemoryStorage} from '@pnyx/storage/memory'
import {Storage} from '@pnyx/storage/types'
import {Effect, Exit, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {InvalidValueError, saveVersioned} from './save.js'
import type {MigrationConfig} from './types.js'

type Contact = {readonly id: string; readonly name: string}

const isContactArray = (v: unknown): v is readonly Contact[] =>
  Array.isArray(v) &&
  v.every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      typeof (item as Record<string, unknown>).name === 'string',
  )

const config: MigrationConfig<readonly Contact[]> = {
  key: 'contacts',
  currentVersion: 1,
  migrations: [],
  validate: isContactArray,
}

const runWithStorage = <A, E>(
  storage: ReturnType<typeof createMemoryStorage>,
  effect: Effect.Effect<A, E, Storage>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(Layer.succeed(Storage, storage))) as Effect.Effect<A, E>)

describe('saveVersioned', () => {
  it('persists valid values as an envelope at currentVersion', async () => {
    const storage = createMemoryStorage()
    const exit = await runWithStorage(storage, saveVersioned(config, [{id: '1', name: 'Ada'}]))
    expect(Exit.isSuccess(exit)).toBe(true)

    const raw = await Effect.runPromise(storage.get('contacts'))
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? '')).toEqual({version: 1, data: [{id: '1', name: 'Ada'}]})
  })

  it('rejects values that fail the config validator with InvalidValueError', async () => {
    const storage = createMemoryStorage()
    const exit = await runWithStorage(
      storage,
      saveVersioned(config, [{wrong: 'shape'}] as unknown as readonly Contact[]),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      // Extract the failure cause as an error and check its tag.
      const firstError = exit.cause.toString()
      expect(firstError).toContain('InvalidValueError')
    }

    // Storage untouched on rejection.
    const raw = await Effect.runPromise(storage.get('contacts'))
    expect(raw).toBeNull()
  })

  it('exposes InvalidValueError as a tagged error', () => {
    const e = new InvalidValueError({key: 'k', message: 'm'})
    expect(e._tag).toBe('InvalidValueError')
    expect(e.key).toBe('k')
  })
})
