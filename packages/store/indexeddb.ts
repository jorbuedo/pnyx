import {Effect, Ref, Stream} from 'effect'
import {KeyNotFoundError, StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {withIndexedDbOpenRetry} from './idb-open.js'
import {type BatchOp, createScopedStore, type Store, StoreService} from './store.js'

const STORE_NAME = 'keyvalue'

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

export const IndexedDBStore = (dbName: string): Effect.Effect<typeof StoreService.Service, StoreError> =>
  Effect.gen(function* () {
    const db = yield* withIndexedDbOpenRetry(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, 1)

            // Settle exactly once. Rejecting from `onblocked` doesn't abort the
            // request — it can still resolve later when the blocking connection
            // closes. Close that late connection so a rejected-then-retried open
            // can't orphan an unused IDBDatabase.
            let settled = false

            request.onerror = () => {
              if (settled) return
              settled = true
              reject(request.error)
            }

            request.onsuccess = () => {
              if (settled) {
                request.result.close()
                return
              }
              settled = true
              resolve(request.result)
            }

            // A concurrent connection holding an older version blocks this open;
            // reject so the retry re-attempts once it closes instead of hanging.
            request.onblocked = () => {
              if (settled) return
              settled = true
              reject(new Error('IndexedDB open blocked by another connection'))
            }

            request.onupgradeneeded = () => {
              const db = request.result
              if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME)
              }
            }
          }),
        catch: (e) => new StoreError({message: `Failed to open IndexedDB: ${e}`, cause: e}),
      }),
    )

    const closedRef = yield* Ref.make(false)

    const checkClosed = Effect.gen(function* () {
      const closed = yield* Ref.get(closedRef)
      if (closed) {
        return yield* Effect.fail(new StoreClosedError({message: 'Store is closed'}))
      }
    })

    const withTransaction = <T>(
      mode: IDBTransactionMode,
      fn: (store: IDBObjectStore) => IDBRequest<T>,
    ): Effect.Effect<T, StoreErrors> =>
      Effect.gen(function* () {
        yield* checkClosed
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<T>((resolve, reject) => {
              const tx = db.transaction(STORE_NAME, mode)
              const store = tx.objectStore(STORE_NAME)
              const request = fn(store)

              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            }),
          catch: (e) => new StoreError({message: `Transaction failed: ${e}`, cause: e}),
        })
      })

    const store: Store = {
      get: (key: Uint8Array) =>
        Effect.gen(function* () {
          const keyStr = bytesToKey(key)
          const result = yield* withTransaction('readonly', (store) => store.get(keyStr))

          if (result === undefined) {
            return yield* Effect.fail(new KeyNotFoundError({message: 'Key not found', key}))
          }

          return new Uint8Array(result as ArrayBuffer)
        }),

      set: (key: Uint8Array, value: Uint8Array) =>
        Effect.gen(function* () {
          const keyStr = bytesToKey(key)
          if (value.length === 0) {
            yield* withTransaction('readwrite', (store) => store.delete(keyStr))
          } else {
            yield* withTransaction('readwrite', (store) =>
              store.put(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength), keyStr),
            )
          }
        }),

      delete: (key: Uint8Array) =>
        Effect.gen(function* () {
          const keyStr = bytesToKey(key)
          yield* withTransaction('readwrite', (store) => store.delete(keyStr))
        }),

      has: (key: Uint8Array) =>
        Effect.gen(function* () {
          const keyStr = bytesToKey(key)
          const result = yield* withTransaction('readonly', (store) => store.count(keyStr))
          return result > 0
        }),

      batch: (ops: ReadonlyArray<BatchOp>) =>
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite')
                const store = tx.objectStore(STORE_NAME)

                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error)

                for (const op of ops) {
                  const keyStr = bytesToKey(op.key)
                  if (op.type === 'del') {
                    store.delete(keyStr)
                  } else if (op.value) {
                    if (op.value.length === 0) {
                      store.delete(keyStr)
                    } else {
                      store.put(
                        op.value.buffer.slice(op.value.byteOffset, op.value.byteOffset + op.value.byteLength),
                        keyStr,
                      )
                    }
                  }
                }
              }),
            catch: (e) => new StoreError({message: `Batch failed: ${e}`, cause: e}),
          })
        }),

      iterator: (prefix?: Uint8Array) =>
        Stream.fromEffect(checkClosed).pipe(
          Stream.flatMap(() =>
            Stream.async<[Uint8Array, Uint8Array], StoreErrors>((emit) => {
              const tx = db.transaction(STORE_NAME, 'readonly')
              const store = tx.objectStore(STORE_NAME)
              const request = store.openCursor()
              const prefixStr = prefix ? bytesToKey(prefix) : ''

              request.onsuccess = () => {
                const cursor = request.result
                if (cursor) {
                  const keyStr = cursor.key as string
                  if (keyStr.startsWith(prefixStr)) {
                    const key = keyToBytes(keyStr)
                    const value = new Uint8Array(cursor.value as ArrayBuffer)
                    emit.single([key, value])
                  }
                  cursor.continue()
                } else {
                  emit.end()
                }
              }

              request.onerror = () => {
                emit.fail(new StoreError({message: 'Cursor error', cause: request.error}))
              }
            }),
          ),
        ),

      close: () =>
        Effect.gen(function* () {
          yield* Ref.set(closedRef, true)
          db.close()
        }),

      scoped: (prefix: Uint8Array) => createScopedStore(store, prefix),
    }

    return StoreService.of(store)
  })
