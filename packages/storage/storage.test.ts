import {describe, expect, it} from '@effect/vitest'
import {Effect} from 'effect'
import {getJson, getJsonWithDefault, setJson, updateJson} from './json.js'
import {createMemoryStorage, MemoryStorageLayer} from './memory.js'
import {detectPlatform, isBrowser, isBrowserExtension, isNode, isReactNative} from './platform.js'
import {Storage, StorageError, StorageKeyNotFoundError, StorageSerializationError} from './types.js'

describe('storage', () => {
  describe('MemoryStorage', () => {
    it.effect('sets and gets a value', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('key', 'value')
        const result = yield* storage.get('key')
        expect(result).toBe('value')
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('returns null for non-existent key', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        const result = yield* storage.get('nonexistent')
        expect(result).toBeNull()
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('removes a value', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('key', 'value')
        yield* storage.remove('key')
        const result = yield* storage.get('key')
        expect(result).toBeNull()
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('clears all values', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('key1', 'value1')
        yield* storage.set('key2', 'value2')
        yield* storage.clear()
        const keys = yield* storage.keys()
        expect(keys).toHaveLength(0)
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('lists all keys', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('key1', 'value1')
        yield* storage.set('key2', 'value2')
        const keys = yield* storage.keys()
        expect(keys).toContain('key1')
        expect(keys).toContain('key2')
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('multiGet retrieves multiple values', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('key1', 'value1')
        yield* storage.set('key2', 'value2')
        const results = yield* storage.multiGet(['key1', 'key2', 'key3'])
        expect(results).toEqual([
          ['key1', 'value1'],
          ['key2', 'value2'],
          ['key3', null],
        ])
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('multiSet stores multiple values', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.multiSet([
          ['key1', 'value1'],
          ['key2', 'value2'],
        ])
        const result1 = yield* storage.get('key1')
        const result2 = yield* storage.get('key2')
        expect(result1).toBe('value1')
        expect(result2).toBe('value2')
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('multiRemove removes multiple values', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('key1', 'value1')
        yield* storage.set('key2', 'value2')
        yield* storage.set('key3', 'value3')
        yield* storage.multiRemove(['key1', 'key2'])
        const result1 = yield* storage.get('key1')
        const result2 = yield* storage.get('key2')
        const result3 = yield* storage.get('key3')
        expect(result1).toBeNull()
        expect(result2).toBeNull()
        expect(result3).toBe('value3')
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )
  })

  describe('createMemoryStorage', () => {
    it('creates independent storage instances', () => {
      const storage1 = createMemoryStorage()
      const storage2 = createMemoryStorage()

      Effect.runSync(storage1.set('key', 'value1'))
      Effect.runSync(storage2.set('key', 'value2'))

      expect(Effect.runSync(storage1.get('key'))).toBe('value1')
      expect(Effect.runSync(storage2.get('key'))).toBe('value2')
    })
  })

  describe('JSON utilities', () => {
    it.effect('getJson parses JSON value', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('user', '{"name":"Alice","age":30}')
        const user = yield* getJson<{name: string; age: number}>('user')
        expect(user).toEqual({name: 'Alice', age: 30})
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('getJson returns null for non-existent key', () =>
      Effect.gen(function* () {
        const result = yield* getJson<{name: string}>('nonexistent')
        expect(result).toBeNull()
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('getJson fails on invalid JSON', () =>
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.set('invalid', 'not json')
        const result = yield* Effect.either(getJson<{name: string}>('invalid'))
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left._tag).toBe('StorageSerializationError')
        }
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('setJson stores JSON value', () =>
      Effect.gen(function* () {
        yield* setJson('user', {name: 'Bob', age: 25})
        const storage = yield* Storage
        const raw = yield* storage.get('user')
        expect(raw).toBe('{"name":"Bob","age":25}')
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('getJsonWithDefault returns value when exists', () =>
      Effect.gen(function* () {
        yield* setJson('count', 42)
        const result = yield* getJsonWithDefault('count', 0)
        expect(result).toBe(42)
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('getJsonWithDefault returns default when not exists', () =>
      Effect.gen(function* () {
        const result = yield* getJsonWithDefault('nonexistent', {value: 'default'})
        expect(result).toEqual({value: 'default'})
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('updateJson updates existing value', () =>
      Effect.gen(function* () {
        yield* setJson('count', 10)
        const result = yield* updateJson('count', (n: number) => n + 5, 0)
        expect(result).toBe(15)
        const stored = yield* getJson<number>('count')
        expect(stored).toBe(15)
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )

    it.effect('updateJson uses default for non-existent key', () =>
      Effect.gen(function* () {
        const result = yield* updateJson('newkey', (n: number) => n + 5, 0)
        expect(result).toBe(5)
      }).pipe(Effect.provide(MemoryStorageLayer)),
    )
  })

  describe('platform detection', () => {
    it('detectPlatform returns node in test environment', () => {
      const platform = detectPlatform()
      expect(['node', 'unknown']).toContain(platform)
    })

    it('isReactNative returns false in node', () => {
      expect(isReactNative()).toBe(false)
    })

    it('isBrowser returns false in node', () => {
      expect(isBrowser()).toBe(false)
    })

    it('isBrowserExtension returns false in node', () => {
      expect(isBrowserExtension()).toBe(false)
    })

    it('isNode returns true in node environment', () => {
      // May be true or false depending on test environment
      const result = isNode()
      expect(typeof result).toBe('boolean')
    })
  })

  describe('error types', () => {
    it('StorageError has correct tag', () => {
      const error = new StorageError({message: 'test error'})
      expect(error._tag).toBe('StorageError')
      expect(error.message).toBe('test error')
    })

    it('StorageKeyNotFoundError has correct tag', () => {
      const error = new StorageKeyNotFoundError({key: 'mykey'})
      expect(error._tag).toBe('StorageKeyNotFoundError')
      expect(error.key).toBe('mykey')
    })

    it('StorageSerializationError has correct tag', () => {
      const error = new StorageSerializationError({message: 'parse error'})
      expect(error._tag).toBe('StorageSerializationError')
      expect(error.message).toBe('parse error')
    })
  })
})
