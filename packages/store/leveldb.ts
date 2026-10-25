import {Effect, Ref, Stream} from 'effect'
import {KeyNotFoundError, StoreClosedError, StoreError, type StoreErrors} from './errors.js'
import {type BatchOp, createScopedStore, type Store, StoreService} from './store.js'

type LevelDB = {
  get(key: Buffer): Promise<Buffer>
  put(key: Buffer, value: Buffer): Promise<void>
  del(key: Buffer): Promise<void>
  batch(ops: Array<{type: 'put' | 'del'; key: Buffer; value?: Buffer}>): Promise<void>
  iterator(options?: {gte?: Buffer; lte?: Buffer}): AsyncIterable<[Buffer, Buffer]>
  close(): Promise<void>
  status: 'opening' | 'open' | 'closing' | 'closed'
}

export const LevelDBStore = (path: string): Effect.Effect<typeof StoreService.Service, StoreError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise({
      try: async () => {
        // Dynamic import for optional peer dependency
        const levelModule = await import('level' as string)
        const Level = levelModule.Level ?? levelModule.default?.Level
        return new Level(path, {
          keyEncoding: 'buffer',
          valueEncoding: 'buffer',
        }) as LevelDB
      },
      catch: (e) => new StoreError({message: `Failed to open LevelDB: ${e}`, cause: e}),
    })

    const closedRef = yield* Ref.make(false)

    const checkClosed = Effect.gen(function* () {
      const closed = yield* Ref.get(closedRef)
      if (closed || db.status === 'closed' || db.status === 'closing') {
        return yield* Effect.fail(new StoreClosedError({message: 'Store is closed'}))
      }
    })

    const store: Store = {
      get: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          const result = yield* Effect.tryPromise({
            try: () => db.get(Buffer.from(key)),
            catch: (e) => {
              if ((e as {code?: string}).code === 'LEVEL_NOT_FOUND') {
                return new KeyNotFoundError({message: 'Key not found', key})
              }
              return new StoreError({message: `Failed to get: ${e}`, cause: e})
            },
          })
          return new Uint8Array(result)
        }),

      set: (key: Uint8Array, value: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          if (value.length === 0) {
            yield* Effect.tryPromise({
              try: () => db.del(Buffer.from(key)),
              catch: (e) => new StoreError({message: `Failed to delete: ${e}`, cause: e}),
            })
          } else {
            yield* Effect.tryPromise({
              try: () => db.put(Buffer.from(key), Buffer.from(value)),
              catch: (e) => new StoreError({message: `Failed to set: ${e}`, cause: e}),
            })
          }
        }),

      delete: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          yield* Effect.tryPromise({
            try: () => db.del(Buffer.from(key)),
            catch: (e) => new StoreError({message: `Failed to delete: ${e}`, cause: e}),
          })
        }),

      has: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* checkClosed
          const result = yield* Effect.tryPromise({
            try: async () => {
              try {
                await db.get(Buffer.from(key))
                return true
              } catch (e) {
                if ((e as {code?: string}).code === 'LEVEL_NOT_FOUND') {
                  return false
                }
                throw e
              }
            },
            catch: (e) => new StoreError({message: `Failed to check key: ${e}`, cause: e}),
          })
          return result
        }),

      batch: (ops: ReadonlyArray<BatchOp>) =>
        Effect.gen(function* () {
          yield* checkClosed
          const levelOps = ops.map((op) => ({
            type: op.type,
            key: Buffer.from(op.key),
            ...(op.value ? {value: Buffer.from(op.value)} : {}),
          }))
          yield* Effect.tryPromise({
            try: () => db.batch(levelOps),
            catch: (e) => new StoreError({message: `Failed to batch: ${e}`, cause: e}),
          })
        }),

      iterator: (prefix?: Uint8Array) =>
        Stream.fromEffect(checkClosed).pipe(
          Stream.flatMap(() =>
            Stream.async<[Uint8Array, Uint8Array], StoreErrors>((emit) => {
              const options = prefix
                ? {
                    gte: Buffer.from(prefix),
                    lte: Buffer.from([...prefix, 0xff]),
                  }
                : undefined

              ;(async () => {
                try {
                  for await (const [key, value] of db.iterator(options)) {
                    emit.single([new Uint8Array(key), new Uint8Array(value)])
                  }
                  emit.end()
                } catch (e) {
                  emit.fail(new StoreError({message: `Iterator error: ${e}`, cause: e}))
                }
              })()
            }),
          ),
        ),

      close: () =>
        Effect.gen(function* () {
          yield* Ref.set(closedRef, true)
          yield* Effect.tryPromise({
            try: () => db.close(),
            catch: (e) => new StoreError({message: `Failed to close: ${e}`, cause: e}),
          })
        }),

      scoped: (prefix: Uint8Array) => createScopedStore(store, prefix),
    }

    return StoreService.of(store)
  })
