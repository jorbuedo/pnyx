import {Context, Effect, Ref, Stream} from 'effect'
import {KeyNotFoundError, StoreClosedError, type StoreErrors} from './errors.js'

export type BatchOp = {
  readonly type: 'put' | 'del'
  readonly key: Uint8Array
  readonly value?: Uint8Array
}

export type Store = {
  readonly get: (key: Uint8Array) => Effect.Effect<Uint8Array, StoreErrors>
  readonly set: (key: Uint8Array, value: Uint8Array) => Effect.Effect<void, StoreErrors>
  readonly delete: (key: Uint8Array) => Effect.Effect<void, StoreErrors>
  readonly has: (key: Uint8Array) => Effect.Effect<boolean, StoreErrors>
  readonly batch: (ops: ReadonlyArray<BatchOp>) => Effect.Effect<void, StoreErrors>
  readonly iterator: (prefix?: Uint8Array) => Stream.Stream<[Uint8Array, Uint8Array], StoreErrors>
  readonly close: () => Effect.Effect<void, StoreErrors>
  readonly scoped: (prefix: Uint8Array) => Store
}

export class StoreService extends Context.Tag('StoreService')<StoreService, Store>() {}

const bytesToKey = (bytes: Uint8Array): string => {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const keyToBytes = (key: string): Uint8Array => {
  const bytes = new Uint8Array(key.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const result = new Uint8Array(a.length + b.length)
  result.set(a)
  result.set(b, a.length)
  return result
}

export const createScopedStore = (store: Store, prefix: Uint8Array): Store => ({
  get: (key: Uint8Array) => store.get(concatBytes(prefix, key)),

  set: (key: Uint8Array, value: Uint8Array) => store.set(concatBytes(prefix, key), value),

  delete: (key: Uint8Array) => store.delete(concatBytes(prefix, key)),

  has: (key: Uint8Array) => store.has(concatBytes(prefix, key)),

  batch: (ops: ReadonlyArray<BatchOp>) =>
    store.batch(
      ops.map((op) => ({
        ...op,
        key: concatBytes(prefix, op.key),
      })),
    ),

  iterator: (subPrefix?: Uint8Array) => {
    const fullPrefix = subPrefix ? concatBytes(prefix, subPrefix) : prefix
    return Stream.map(store.iterator(fullPrefix), ([key, value]) => [key.slice(prefix.length), value])
  },

  close: () => store.close(),

  scoped: (subPrefix: Uint8Array) => createScopedStore(store, concatBytes(prefix, subPrefix)),
})

export const MemoryStore = Effect.gen(function* () {
  const storage = yield* Ref.make<Map<string, Uint8Array>>(new Map())
  const closedRef = yield* Ref.make(false)

  const checkClosed = Effect.gen(function* () {
    const closed = yield* Ref.get(closedRef)
    if (closed) {
      return yield* Effect.fail(new StoreClosedError({message: 'Store is closed'}))
    }
  })

  const store: Store = {
    get: (key: Uint8Array) =>
      Effect.gen(function* () {
        yield* checkClosed
        const entries = yield* Ref.get(storage)
        const keyStr = bytesToKey(key)
        const value = entries.get(keyStr)

        if (!value) {
          return yield* Effect.fail(new KeyNotFoundError({message: 'Key not found', key}))
        }

        return value
      }),

    set: (key: Uint8Array, value: Uint8Array) =>
      Effect.gen(function* () {
        yield* checkClosed
        const keyStr = bytesToKey(key)

        if (value.length === 0) {
          yield* Ref.update(storage, (entries) => {
            const newEntries = new Map(entries)
            newEntries.delete(keyStr)
            return newEntries
          })
        } else {
          yield* Ref.update(storage, (entries) => {
            const newEntries = new Map(entries)
            newEntries.set(keyStr, value)
            return newEntries
          })
        }
      }),

    delete: (key: Uint8Array) =>
      Effect.gen(function* () {
        yield* checkClosed
        const keyStr = bytesToKey(key)
        yield* Ref.update(storage, (entries) => {
          const newEntries = new Map(entries)
          newEntries.delete(keyStr)
          return newEntries
        })
      }),

    has: (key: Uint8Array) =>
      Effect.gen(function* () {
        yield* checkClosed
        const entries = yield* Ref.get(storage)
        return entries.has(bytesToKey(key))
      }),

    batch: (ops: ReadonlyArray<BatchOp>) =>
      Effect.gen(function* () {
        yield* checkClosed
        yield* Ref.update(storage, (entries) => {
          const newEntries = new Map(entries)
          for (const op of ops) {
            const keyStr = bytesToKey(op.key)
            if (op.type === 'del') {
              newEntries.delete(keyStr)
            } else if (op.value) {
              if (op.value.length === 0) {
                newEntries.delete(keyStr)
              } else {
                newEntries.set(keyStr, op.value)
              }
            }
          }
          return newEntries
        })
      }),

    iterator: (prefix?: Uint8Array) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          yield* checkClosed
          const entries = yield* Ref.get(storage)
          return entries
        }),
      ).pipe(
        Stream.flatMap((entries) => {
          const prefixStr = prefix ? bytesToKey(prefix) : ''
          const items: Array<[Uint8Array, Uint8Array]> = []

          for (const [keyStr, value] of entries) {
            if (keyStr.startsWith(prefixStr)) {
              items.push([keyToBytes(keyStr), value])
            }
          }

          items.sort((a, b) => {
            const keyA = bytesToKey(a[0])
            const keyB = bytesToKey(b[0])
            return keyA.localeCompare(keyB)
          })

          return Stream.fromIterable(items)
        }),
      ),

    close: () =>
      Effect.gen(function* () {
        yield* Ref.set(closedRef, true)
      }),

    scoped: (prefix: Uint8Array) => createScopedStore(store, prefix),
  }

  return StoreService.of(store)
})
