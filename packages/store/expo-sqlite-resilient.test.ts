/**
 * Unit tests for `openResilientDb` / `isStaleNativeHandleError`.
 *
 * Doesn't touch real expo-sqlite — drives a fake `SQLiteDatabase` so the
 * stale-handle recovery contract can be exercised in pure Node without an
 * Android lifecycle. The Android-side trigger needs a manual repro
 * (documented in the PR description).
 *
 * @module
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {isStaleNativeHandleError, openResilientDb} from './expo-sqlite-resilient.native.js'

// Mock the expo-sqlite module — the helper imports `SQLite.openDatabaseAsync`.
// We swap it out with a factory we control so each test can script the
// sequence of native rejections + recoveries.
// ⚠️ Derived from the factory rather than declared alongside it. A bare `ReturnType<typeof vi.fn>` is
// `Mock<Procedure | Constructable>`, which TypeScript will not call — and a hand-written signature
// beside `makeFakeDb` would be a second place to keep in step.
type FakeDb = ReturnType<typeof makeFakeDb>

let pendingDbs: FakeDb[] = []
const openDatabaseAsync = vi.fn(async (_dbName: string, _options?: {useNewConnection?: boolean}) => {
  const db = pendingDbs.shift()
  if (!db) throw new Error('test forgot to enqueue a fake db')
  return db
})

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: (dbName: string, options?: {useNewConnection?: boolean}) => openDatabaseAsync(dbName, options),
}))

const makeFakeDb = () => ({
  execAsync: vi.fn(async (_sql?: string) => undefined),
  closeAsync: vi.fn(async () => undefined),
})

// The exact JNI rejection shape produced by expo-sqlite on Android after the
// Activity is destroyed. Both the `NativeDatabase.X has been rejected` clause
// and the `NullPointerException` cause must be present to trip recovery.
const npe = (method: string) =>
  new Error(
    `Call to function 'NativeDatabase.${method}' has been rejected.\n→ Caused by: java.lang.NullPointerException: java.lang.NullPointerException`,
  )

beforeEach(() => {
  pendingDbs = []
  openDatabaseAsync.mockClear()
})

afterEach(() => {
  expect(pendingDbs).toEqual([]) // every test must drain its enqueued dbs
})

describe('isStaleNativeHandleError', () => {
  it('matches the expo-sqlite Android JNI rejection shape', () => {
    expect(isStaleNativeHandleError(npe('prepareAsync'))).toBe(true)
    expect(isStaleNativeHandleError(npe('execAsync'))).toBe(true)
    expect(isStaleNativeHandleError(npe('runAsync'))).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isStaleNativeHandleError(new Error('disk I/O error'))).toBe(false)
    expect(isStaleNativeHandleError(new Error('constraint failed: UNIQUE'))).toBe(false)
    expect(isStaleNativeHandleError(new Error('NullPointerException'))).toBe(false)
    expect(isStaleNativeHandleError(new Error("Call to function 'OtherModule.foo' has been rejected"))).toBe(false)
    expect(isStaleNativeHandleError('string error')).toBe(false)
    expect(isStaleNativeHandleError(undefined)).toBe(false)
  })
})

describe('openResilientDb', () => {
  it('runs initSchema once on initial open', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const initSchema = vi.fn(async (_db: FakeDb) => undefined)

    await openResilientDb('test.db', initSchema as never)

    expect(openDatabaseAsync).toHaveBeenCalledTimes(1)
    expect(initSchema).toHaveBeenCalledTimes(1)
    expect(initSchema).toHaveBeenCalledWith(db)
  })

  it('forwards a successful call to the underlying db', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const handle = await openResilientDb('test.db', async () => undefined)

    const result = await handle.with(async (d) => {
      expect(d).toBe(db)
      return 'ok'
    })

    expect(result).toBe('ok')
  })

  it('reopens + retries when the first call rejects with a stale-handle NPE', async () => {
    const dead = makeFakeDb()
    const fresh = makeFakeDb()
    pendingDbs.push(dead, fresh)

    const initSchema = vi.fn(async (_db: FakeDb) => undefined)
    const handle = await openResilientDb('test.db', initSchema as never)
    expect(initSchema).toHaveBeenCalledTimes(1)

    let callCount = 0
    const result = await handle.with(async (d) => {
      callCount++
      if (callCount === 1) {
        expect(d).toBe(dead)
        throw npe('prepareAsync')
      }
      expect(d).toBe(fresh)
      return 'recovered'
    })

    expect(result).toBe('recovered')
    expect(callCount).toBe(2)
    expect(openDatabaseAsync).toHaveBeenCalledTimes(2)
    expect(initSchema).toHaveBeenCalledTimes(2) // schema replayed on the fresh handle
    expect(dead.closeAsync).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-stale-handle errors', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const handle = await openResilientDb('test.db', async () => undefined)

    const op = vi.fn(async () => {
      throw new Error('UNIQUE constraint failed')
    })
    await expect(handle.with(op)).rejects.toThrow('UNIQUE constraint failed')
    expect(op).toHaveBeenCalledTimes(1)
    expect(openDatabaseAsync).toHaveBeenCalledTimes(1) // never reopened
  })

  it('surfaces the original error if the retry also throws', async () => {
    const dead = makeFakeDb()
    const fresh = makeFakeDb()
    pendingDbs.push(dead, fresh)

    const handle = await openResilientDb('test.db', async () => undefined)

    let n = 0
    await expect(
      handle.with(async () => {
        n++
        if (n === 1) throw npe('prepareAsync')
        throw new Error('still broken after reopen')
      }),
    ).rejects.toThrow('still broken after reopen')

    expect(n).toBe(2) // exactly one retry, no infinite loop
  })

  it('ignores closeAsync failures on the stale handle (already dead)', async () => {
    const dead = makeFakeDb()
    dead.closeAsync.mockRejectedValueOnce(new Error('already closed'))
    const fresh = makeFakeDb()
    pendingDbs.push(dead, fresh)

    const handle = await openResilientDb('test.db', async () => undefined)

    let n = 0
    const result = await handle.with(async () => {
      n++
      if (n === 1) throw npe('execAsync')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(dead.closeAsync).toHaveBeenCalledTimes(1)
  })

  it('serialises concurrent reopens — N failing callers trigger one reopen', async () => {
    const dead = makeFakeDb()
    const fresh = makeFakeDb()
    pendingDbs.push(dead, fresh)

    const handle = await openResilientDb('test.db', async () => undefined)

    // Fire 5 callers in parallel, all of which see the stale handle once.
    const results = await Promise.all(
      Array.from({length: 5}, (_, i) => {
        let attempt = 0
        return handle.with(async () => {
          attempt++
          if (attempt === 1) throw npe('runAsync')
          return `caller-${i}`
        })
      }),
    )

    expect(results).toEqual(['caller-0', 'caller-1', 'caller-2', 'caller-3', 'caller-4'])
    expect(openDatabaseAsync).toHaveBeenCalledTimes(2) // initial + one reopen
    expect(dead.closeAsync).toHaveBeenCalledTimes(1) // single close on the stale handle
  })

  it('rejects new operations after close()', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const handle = await openResilientDb('test.db', async () => undefined)
    await handle.close()

    await expect(handle.with(async () => 'unreachable')).rejects.toThrow(/closed/)
    expect(db.closeAsync).toHaveBeenCalledTimes(1)
  })
})

describe('close drains in-flight work', () => {
  // ⚠️ Reproduced on a device 2/2: widening `walletService.close()` from one handle to
  // nine turned every network switch into a SIGSEGV at
  // `expo::NativeStatementBinding::getColumnNames()`. Closing a connection under a
  // running statement is a use-after-free, and expo-sqlite runs every native call on a
  // thread pool, so a read is very often still running when the owner says it is done.
  it('waits for a running native call before closing the handle', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const handle = await openResilientDb('test.db', async () => undefined)

    let release: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      release = resolve
    })
    let closedWhileRunning = false
    db.closeAsync.mockImplementation(async () => {
      closedWhileRunning = !settled
      return undefined
    })
    let settled = false
    const op = handle.with(async () => {
      await running
      settled = true
      return 'done'
    })

    const closing = handle.close()
    // Give close every chance to run ahead of the operation.
    await Promise.resolve()
    await Promise.resolve()
    expect(db.closeAsync).not.toHaveBeenCalled()

    release?.()
    await op
    await closing
    expect(db.closeAsync).toHaveBeenCalledTimes(1)
    expect(closedWhileRunning, 'the handle was closed under a running statement').toBe(false)
  })

  it('closes anyway when a call will not finish, rather than wedging teardown', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const handle = await openResilientDb('test.db', async () => undefined)

    // Never settles — the wedged-statement case the bound exists for. An unbounded wait
    // here would turn one stuck statement into an app that cannot switch networks.
    void handle.with(() => new Promise<never>(() => {})).catch(() => undefined)

    vi.useFakeTimers()
    try {
      const closing = handle.close()
      await vi.advanceTimersByTimeAsync(2500)
      await closing
    } finally {
      vi.useRealTimers()
    }
    expect(db.closeAsync).toHaveBeenCalledTimes(1)
  })
})

describe('connection pragmas', () => {
  // ⚠️ The bug this exists for: with `busy_timeout` at SQLite's zero default, a writer that
  // finds the lock held fails *immediately*. Observed on a device 2026-09-05 as a dropped
  // history batch — `"rowCount":50 … Caused by: database is locked`, fifty transactions gone.
  it('sets busy_timeout and WAL before the schema is created', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    const schemaAt: number[] = []
    await openResilientDb('test.db', async () => {
      schemaAt.push(db.execAsync.mock.calls.length)
    })

    const pragmas = db.execAsync.mock.calls.map(([sql]) => sql ?? '').join(' ')
    expect(pragmas).toContain('busy_timeout')
    expect(pragmas).toContain('journal_mode = WAL')
    // Applied first, so creating the schema is itself covered.
    expect(schemaAt[0]).toBeGreaterThan(0)
  })

  it('applies them to a reopened connection too — a fresh handle inherits nothing', async () => {
    const first = makeFakeDb()
    const second = makeFakeDb()
    pendingDbs.push(first, second)
    const handle = await openResilientDb('test.db', async () => undefined)
    second.execAsync.mockClear()

    first.execAsync.mockRejectedValueOnce(npe('execAsync'))
    await handle.with((db) => db.execAsync('SELECT 1'))

    const pragmas = second.execAsync.mock.calls.map(([sql]) => sql ?? '').join(' ')
    expect(pragmas).toContain('busy_timeout')
    expect(pragmas).toContain('journal_mode = WAL')
  })
})

describe('openResilientDb connection cache', () => {
  // ⚠️ The reason a reopen used to change nothing. `openDatabaseAsync` reuses a connection cached by
  // database name unless `useNewConnection` is set, so when the cached connection was the stale one,
  // every reopen was handed the same dead object and only killing the process recovered. Seen on the
  // emulator 2026-08-29 on two surfaces in one day.
  it('opens the first connection from the cache, as everything else on the file expects', async () => {
    const db = makeFakeDb()
    pendingDbs.push(db)
    await openResilientDb('test.db', async () => undefined)

    expect(openDatabaseAsync).toHaveBeenCalledWith('test.db', undefined)
  })

  it('bypasses the cache when reopening after a stale handle', async () => {
    const dead = makeFakeDb()
    const fresh = makeFakeDb()
    pendingDbs.push(dead, fresh)
    const handle = await openResilientDb('test.db', async () => undefined)

    let n = 0
    await handle.with(async () => {
      n++
      if (n === 1) throw npe('prepareAsync')
      return 'ok'
    })

    expect(openDatabaseAsync).toHaveBeenNthCalledWith(2, 'test.db', {useNewConnection: true})
  })

  it('bypasses the cache on the initial open’s retry too', async () => {
    const dead = makeFakeDb()
    const fresh = makeFakeDb()
    pendingDbs.push(dead, fresh)

    let schemaCalls = 0
    await openResilientDb('test.db', async () => {
      schemaCalls++
      if (schemaCalls === 1) throw npe('execAsync')
    })

    expect(openDatabaseAsync).toHaveBeenNthCalledWith(1, 'test.db', undefined)
    expect(openDatabaseAsync).toHaveBeenNthCalledWith(2, 'test.db', {useNewConnection: true})
  })
})

describe('openResilientDb reopen', () => {
  // ⚠️ The gap this closes. A reopen replays `initSchema`, which is a native call of its own. When the
  // lifecycle blip that invalidated the handle was still in progress, that replay rejected and the
  // rejection escaped `with(op)` — so the caller saw its own operation fail, carrying the *reopen's*
  // `execAsync` in the message. Seen live 2026-08-29: `Failed to get address row: … execAsync …
  // NullPointerException`, from a call site that only ever runs `getFirstAsync`.
  it('retries the reopen when its schema replay hits a stale handle', async () => {
    const dead = makeFakeDb()
    const alsoDead = makeFakeDb()
    const fresh = makeFakeDb()
    pendingDbs.push(dead, alsoDead, fresh)

    let schemaCalls = 0
    const initSchema = vi.fn(async (_db: FakeDb) => {
      schemaCalls++
      // Initial open fine; the reopen's replay rejects once, then succeeds.
      if (schemaCalls === 2) throw npe('execAsync')
    })
    const handle = await openResilientDb('test.db', initSchema as never)

    let n = 0
    const result = await handle.with(async (d) => {
      n++
      if (n === 1) throw npe('getFirstAsync')
      expect(d).toBe(fresh)
      return 'recovered'
    })

    expect(result).toBe('recovered')
    expect(schemaCalls).toBe(3) // initial + failed replay + retried replay
    expect(openDatabaseAsync).toHaveBeenCalledTimes(3)
  })

  it('gives up after one reopen retry rather than looping', async () => {
    const dead = makeFakeDb()
    const alsoDead = makeFakeDb()
    const stillDead = makeFakeDb()
    pendingDbs.push(dead, alsoDead, stillDead)

    const initSchema = vi.fn(async (_db: FakeDb) => {
      if (initSchema.mock.calls.length > 1) throw npe('execAsync')
    })
    const handle = await openResilientDb('test.db', initSchema as never)

    await expect(
      handle.with(async () => {
        throw npe('getFirstAsync')
      }),
    ).rejects.toThrow(/execAsync/)

    expect(openDatabaseAsync).toHaveBeenCalledTimes(3) // initial + reopen + its one retry
  })
})

describe('openResilientDb initial open', () => {
  // ⚠️ The gap this closes. `with(op)` recovered a handle that went stale mid-session, but the very
  // first `open()` — which runs `initSchema` — was unguarded. An Activity destroyed while the database
  // was being opened rejected that `execAsync`, `openResilientDb` threw, and the caller fell back to an
  // in-memory store for the rest of the session. Seen on a device as a wallet whose Midnight receive
  // address had vanished after a network switch.
  it('retries the initial open when schema setup hits a stale handle', async () => {
    const dead = makeFakeDb()
    dead.execAsync.mockRejectedValueOnce(npe('execAsync'))
    const live = makeFakeDb()
    pendingDbs = [dead, live]

    const rdb = await openResilientDb('test.db', (db) => db.execAsync('CREATE TABLE IF NOT EXISTS t (a)'))

    expect(openDatabaseAsync).toHaveBeenCalledTimes(2)
    await expect(rdb.with(async (db) => (db as unknown as FakeDb).execAsync('SELECT 1'))).resolves.toBeUndefined()
    expect(live.execAsync).toHaveBeenCalled()
  })

  it('gives up when the retried open fails the same way — a second failure is not a lifecycle blip', async () => {
    const dead = makeFakeDb()
    dead.execAsync.mockRejectedValueOnce(npe('execAsync'))
    const alsoDead = makeFakeDb()
    alsoDead.execAsync.mockRejectedValueOnce(npe('execAsync'))
    pendingDbs = [dead, alsoDead]

    await expect(openResilientDb('test.db', (db) => db.execAsync('CREATE TABLE IF NOT EXISTS t (a)'))).rejects.toThrow(
      /NativeDatabase\.execAsync/,
    )
    expect(openDatabaseAsync).toHaveBeenCalledTimes(2)
  })

  it('does not retry an ordinary open failure', async () => {
    const broken = makeFakeDb()
    broken.execAsync.mockRejectedValueOnce(new Error('disk I/O error'))
    pendingDbs = [broken]

    await expect(openResilientDb('test.db', (db) => db.execAsync('CREATE TABLE IF NOT EXISTS t (a)'))).rejects.toThrow(
      'disk I/O error',
    )
    expect(openDatabaseAsync).toHaveBeenCalledTimes(1)
  })
})
