import {Chunk, Effect, Exit, Stream} from 'effect'
import {describe, expect, it} from 'vitest'
import {KeyNotFoundError, MemoryStore, StoreClosedError, StoreError, TransactionError} from './index.js'

describe('Store Errors', () => {
  it('creates StoreError', () => {
    const error = new StoreError({message: 'test', cause: 'cause'})
    expect(error.message).toBe('test')
    expect(error.cause).toBe('cause')
    expect(error._tag).toBe('StoreError')
  })

  it('creates KeyNotFoundError', () => {
    const error = new KeyNotFoundError({message: 'not found', key: new Uint8Array([1, 2, 3])})
    expect(error.message).toBe('not found')
    expect(error.key).toEqual(new Uint8Array([1, 2, 3]))
    expect(error._tag).toBe('KeyNotFoundError')
  })

  it('creates StoreClosedError', () => {
    const error = new StoreClosedError({message: 'closed'})
    expect(error.message).toBe('closed')
    expect(error._tag).toBe('StoreClosedError')
  })

  it('creates TransactionError', () => {
    const error = new TransactionError({message: 'tx failed', cause: 'cause'})
    expect(error.message).toBe('tx failed')
    expect(error.cause).toBe('cause')
    expect(error._tag).toBe('TransactionError')
  })
})

describe('Memory Store', () => {
  it('creates a store service', async () => {
    const program = Effect.gen(function* () {
      const service = yield* MemoryStore
      expect(service).toBeDefined()
    })

    await Effect.runPromise(program)
  })

  it('sets and gets a value', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      const key = new Uint8Array([1, 2, 3])
      const value = new Uint8Array([4, 5, 6])

      yield* store.set(key, value)
      const result = yield* store.get(key)

      expect(result).toEqual(value)
    })

    await Effect.runPromise(program)
  })

  it('fails to get non-existent key', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      const result = yield* Effect.exit(store.get(new Uint8Array([1, 2, 3])))
      expect(Exit.isFailure(result)).toBe(true)
    })

    await Effect.runPromise(program)
  })

  it('checks if key exists', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      const key = new Uint8Array([1, 2, 3])
      const hasBefore = yield* store.has(key)
      expect(hasBefore).toBe(false)

      yield* store.set(key, new Uint8Array([4, 5, 6]))

      const hasAfter = yield* store.has(key)
      expect(hasAfter).toBe(true)
    })

    await Effect.runPromise(program)
  })

  it('deletes a key', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      const key = new Uint8Array([1, 2, 3])
      yield* store.set(key, new Uint8Array([4, 5, 6]))
      yield* store.delete(key)

      const has = yield* store.has(key)
      expect(has).toBe(false)
    })

    await Effect.runPromise(program)
  })

  it('deletes key when setting empty value', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      const key = new Uint8Array([1, 2, 3])
      yield* store.set(key, new Uint8Array([4, 5, 6]))
      yield* store.set(key, new Uint8Array(0))

      const has = yield* store.has(key)
      expect(has).toBe(false)
    })

    await Effect.runPromise(program)
  })

  it('performs batch operations', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      yield* store.batch([
        {type: 'put', key: new Uint8Array([1]), value: new Uint8Array([10])},
        {type: 'put', key: new Uint8Array([2]), value: new Uint8Array([20])},
        {type: 'put', key: new Uint8Array([3]), value: new Uint8Array([30])},
      ])

      const v1 = yield* store.get(new Uint8Array([1]))
      const v2 = yield* store.get(new Uint8Array([2]))
      const v3 = yield* store.get(new Uint8Array([3]))

      expect(v1).toEqual(new Uint8Array([10]))
      expect(v2).toEqual(new Uint8Array([20]))
      expect(v3).toEqual(new Uint8Array([30]))

      yield* store.batch([{type: 'del', key: new Uint8Array([2])}])

      const has2 = yield* store.has(new Uint8Array([2]))
      expect(has2).toBe(false)
    })

    await Effect.runPromise(program)
  })

  it('batch deletes when setting empty value', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      yield* store.set(new Uint8Array([1]), new Uint8Array([10]))

      yield* store.batch([{type: 'put', key: new Uint8Array([1]), value: new Uint8Array(0)}])

      const has = yield* store.has(new Uint8Array([1]))
      expect(has).toBe(false)
    })

    await Effect.runPromise(program)
  })

  it('iterates over all entries', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      yield* store.set(new Uint8Array([1]), new Uint8Array([10]))
      yield* store.set(new Uint8Array([2]), new Uint8Array([20]))
      yield* store.set(new Uint8Array([3]), new Uint8Array([30]))

      const entries = yield* Stream.runCollect(store.iterator())
      expect(Array.from(entries).length).toBe(3)
    })

    await Effect.runPromise(program)
  })

  it('iterates with prefix filter', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      yield* store.set(new Uint8Array([0xaa, 1]), new Uint8Array([10]))
      yield* store.set(new Uint8Array([0xaa, 2]), new Uint8Array([20]))
      yield* store.set(new Uint8Array([0xbb, 1]), new Uint8Array([30]))

      const entries = yield* Stream.runCollect(store.iterator(new Uint8Array([0xaa])))
      expect(Array.from(entries).length).toBe(2)
    })

    await Effect.runPromise(program)
  })

  it('closes the store', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      yield* store.close()

      const result = yield* Effect.exit(store.get(new Uint8Array([1])))
      expect(Exit.isFailure(result)).toBe(true)
    })

    await Effect.runPromise(program)
  })

  it('fails operations on closed store', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      yield* store.close()

      const setResult = yield* Effect.exit(store.set(new Uint8Array([1]), new Uint8Array([1])))
      expect(Exit.isFailure(setResult)).toBe(true)

      const hasResult = yield* Effect.exit(store.has(new Uint8Array([1])))
      expect(Exit.isFailure(hasResult)).toBe(true)

      const deleteResult = yield* Effect.exit(store.delete(new Uint8Array([1])))
      expect(Exit.isFailure(deleteResult)).toBe(true)

      const batchResult = yield* Effect.exit(store.batch([]))
      expect(Exit.isFailure(batchResult)).toBe(true)
    })

    await Effect.runPromise(program)
  })

  it('creates scoped stores', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      const scoped = store.scoped(new Uint8Array([0xaa]))

      yield* scoped.set(new Uint8Array([1]), new Uint8Array([10]))
      yield* scoped.set(new Uint8Array([2]), new Uint8Array([20]))

      const v1 = yield* scoped.get(new Uint8Array([1]))
      expect(v1).toEqual(new Uint8Array([10]))

      // Check that the parent store has the prefixed keys
      const v1FromParent = yield* store.get(new Uint8Array([0xaa, 1]))
      expect(v1FromParent).toEqual(new Uint8Array([10]))

      // Iterate scoped entries
      const entries = yield* Stream.runCollect(scoped.iterator())
      expect(Array.from(entries).length).toBe(2)

      // Keys should be without the prefix
      const first = Chunk.get(entries, 0)
      if (first._tag === 'Some') {
        expect(first.value[0]).toEqual(new Uint8Array([1]))
      }
    })

    await Effect.runPromise(program)
  })

  it('creates nested scoped stores', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore

      const level1 = store.scoped(new Uint8Array([0xaa]))
      const level2 = level1.scoped(new Uint8Array([0xbb]))

      yield* level2.set(new Uint8Array([1]), new Uint8Array([10]))

      // Check nested access
      const v = yield* level2.get(new Uint8Array([1]))
      expect(v).toEqual(new Uint8Array([10]))

      // Check from root
      const vFromRoot = yield* store.get(new Uint8Array([0xaa, 0xbb, 1]))
      expect(vFromRoot).toEqual(new Uint8Array([10]))
    })

    await Effect.runPromise(program)
  })

  it('scoped batch operations', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      const scoped = store.scoped(new Uint8Array([0xaa]))

      yield* scoped.batch([
        {type: 'put', key: new Uint8Array([1]), value: new Uint8Array([10])},
        {type: 'put', key: new Uint8Array([2]), value: new Uint8Array([20])},
      ])

      const v1 = yield* store.get(new Uint8Array([0xaa, 1]))
      const v2 = yield* store.get(new Uint8Array([0xaa, 2]))

      expect(v1).toEqual(new Uint8Array([10]))
      expect(v2).toEqual(new Uint8Array([20]))
    })

    await Effect.runPromise(program)
  })

  it('scoped has operation', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      const scoped = store.scoped(new Uint8Array([0xaa]))

      yield* store.set(new Uint8Array([0xaa, 1]), new Uint8Array([10]))

      const has = yield* scoped.has(new Uint8Array([1]))
      expect(has).toBe(true)
    })

    await Effect.runPromise(program)
  })

  it('scoped delete operation', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      const scoped = store.scoped(new Uint8Array([0xaa]))

      yield* scoped.set(new Uint8Array([1]), new Uint8Array([10]))
      yield* scoped.delete(new Uint8Array([1]))

      const has = yield* scoped.has(new Uint8Array([1]))
      expect(has).toBe(false)
    })

    await Effect.runPromise(program)
  })

  it('scoped iterator with subprefix', async () => {
    const program = Effect.gen(function* () {
      const store = yield* MemoryStore
      const scoped = store.scoped(new Uint8Array([0xaa]))

      yield* scoped.set(new Uint8Array([0xbb, 1]), new Uint8Array([10]))
      yield* scoped.set(new Uint8Array([0xbb, 2]), new Uint8Array([20]))
      yield* scoped.set(new Uint8Array([0xcc, 1]), new Uint8Array([30]))

      const entries = yield* Stream.runCollect(scoped.iterator(new Uint8Array([0xbb])))
      expect(Array.from(entries).length).toBe(2)
    })

    await Effect.runPromise(program)
  })
})
