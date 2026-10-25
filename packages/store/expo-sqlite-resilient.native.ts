/**
 * SQLite database handle that survives mid-session native-handle invalidation.
 *
 * Android can destroy our Activity under memory pressure (TRIM_MEMORY_*) while
 * the JS process survives. When the Activity comes back, every cached
 * `SQLiteDatabase` reference now points at a destroyed native pointer, and
 * the first JNI call rejects with `Call to function 'NativeDatabase.X' has
 * been rejected → java.lang.NullPointerException`. Without recovery the wallet
 * silently falls back to an in-memory store and persistent state stops
 * updating for the rest of the session.
 *
 * `openResilientDb` wraps every native call in `with(op)`. On a stale-handle
 * rejection it reopens the database via the cached `dbName`, replays the
 * supplied `initSchema` (must be idempotent), and retries `op` exactly once
 * against the fresh handle. Reopens are serialised — a thundering herd of
 * concurrent failing calls triggers a single reopen.
 *
 * The initial open gets the same one retry: `initSchema` is itself a native
 * call, so an Activity destroyed while the database is first opened rejects it
 * and would otherwise drop the caller into the in-memory fallback this module
 * exists to prevent.
 *
 * @module
 */

import * as SQLite from 'expo-sqlite'

/**
 * Matches the exact JNI rejection shape — no false positives on app-level
 * errors. Both pieces must be present (`NativeDatabase.X has been rejected`
 * and `NullPointerException`).
 */
const STALE_HANDLE_PATTERN = /Call to function 'NativeDatabase\.[^']+' has been rejected/

export const isStaleNativeHandleError = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e)
  return STALE_HANDLE_PATTERN.test(msg) && msg.includes('NullPointerException')
}

export type ResilientDb = {
  /**
   * Run `op` against the current native handle. If the call rejects with a
   * stale-handle error, reopen the database, replay `initSchema`, and retry
   * `op` exactly once against the fresh handle.
   */
  readonly with: <A>(op: (db: SQLite.SQLiteDatabase) => Promise<A>) => Promise<A>
  /** Close the underlying database. Safe to call on an already-stale handle. */
  readonly close: () => Promise<void>
}

/**
 * How long a contending writer waits for the lock before giving up.
 *
 * ⚠️ **SQLite's default is zero** — it does not wait at all, it returns `SQLITE_BUSY`
 * on the first contended statement. Nothing here set it, so the app was running every
 * database at that default while several writers shared one connection.
 */
const BUSY_TIMEOUT_MS = 5000

/**
 * Make a connection survive being written to by more than one caller.
 *
 * Observed on a device 2026-09-05, walking transaction history while the address book
 * was being written: `Failed to persist a history batch; those txs stay missing
 * {"rowCount":50, … "Caused by: database is locked"}`. Fifty transactions dropped,
 * because with `busy_timeout` at its zero default a writer that finds the lock held
 * fails *immediately* rather than waiting the millisecond it would have taken.
 *
 * - **`busy_timeout`** turns that instant failure into a wait. It is what makes
 *   concurrent writers correct rather than lucky.
 * - **`journal_mode = WAL`** stops readers and writers blocking each other at all,
 *   which is the shape of the contention here: a read walks the address table while a
 *   history batch is being written. ⚠️ This is a persistent property of the database
 *   file, not of the connection — it adds `-wal` / `-shm` alongside the `.db` and it
 *   survives reopening. Deliberate: every consumer of these files is this app.
 *
 * Applied before `initSchema`, so the schema write itself is covered, and on every
 * reopen, because a recovered connection is not born with the old one's settings.
 */
const configureForConcurrency = async (db: SQLite.SQLiteDatabase): Promise<void> => {
  await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
}

/**
 * @param dbName     - Database file name, cached for reopens.
 * @param initSchema - Idempotent schema setup (CREATE TABLE IF NOT EXISTS …).
 *   Runs once on initial open AND once per reopen. Must NOT include
 *   destructive operations (DROP, version migrations) — those belong outside
 *   in caller-controlled bootstrap that runs through `with(...)` itself.
 */
export const openResilientDb = async (
  dbName: string,
  initSchema: (db: SQLite.SQLiteDatabase) => Promise<void>,
): Promise<ResilientDb> => {
  /**
   * @param bypassCache - ⚠️ **What makes a reopen actually reopen.** `openDatabaseAsync` reuses a
   *   connection cached by database name unless `useNewConnection` is set — expo-sqlite's own words:
   *   "create new connection even if connection with the same database name exists in cache", default
   *   `false`. So when the cached connection is the one that went stale, every reopen was handed the
   *   same dead object and recovery could not work; only killing the process cleared the cache. The
   *   initial open keeps the default, because sharing one connection per file is what makes the tables
   *   on it coherent — only recovery needs to step around it.
   */
  const open = async (bypassCache = false): Promise<SQLite.SQLiteDatabase> => {
    const fresh = await SQLite.openDatabaseAsync(dbName, bypassCache ? {useNewConnection: true} : undefined)
    await configureForConcurrency(fresh)
    await initSchema(fresh)
    return fresh
  }

  /**
   * ⚠️ **Every open needs the same retry as every later call** — the first one and each reopen alike.
   * `open()` runs `initSchema`, which is itself a native call, so an Activity destroyed while the
   * database is being opened rejects that `execAsync` exactly like a stale handle.
   *
   * Unguarded on the *initial* open, the caller took its "SQLite not available" branch and fell back
   * to memory for the whole session. Unguarded on a *reopen*, it is worse than that: the rejection
   * escapes `with(op)` wearing the caller's own message, so a blip during recovery reads as the
   * original read failing. Seen on a device 2026-08-29 as `Failed to get address row: … execAsync …
   * NullPointerException` — a `getFirstAsync` call reporting an `execAsync` failure — which emptied
   * the DUST destination picker of every wallet the user owns.
   *
   * One retry, because a second failure is no longer a lifecycle blip.
   */
  const openWithRetry = (bypassCache = false): Promise<SQLite.SQLiteDatabase> =>
    open(bypassCache).catch(async (e: unknown) => {
      if (!isStaleNativeHandleError(e)) throw e
      // The retry always bypasses the cache: whatever failed the first attempt, a cached connection is
      // the one thing a second identical open cannot get past.
      return await open(true)
    })

  let db = await openWithRetry()
  let reopenInFlight: Promise<SQLite.SQLiteDatabase> | null = null
  let closed = false

  /**
   * Native calls currently running against this handle.
   *
   * ⚠️ **Closing a connection under a running statement is a use-after-free, not an
   * error.** Reproduced 2/2 on a device: widening `walletService.close()` from one
   * handle to nine turned every network switch into a SIGSEGV at
   * `expo::NativeStatementBinding::getColumnNames()` — a *read* path, closed out from
   * under itself. expo-sqlite runs every native call on `Dispatchers.IO`, a pool, so a
   * read is very often still running when the owner decides it is done.
   */
  const inFlight = new Set<Promise<unknown>>()

  /**
   * How long teardown waits for outstanding native calls before closing anyway.
   *
   * Bounded on purpose: an unbounded wait turns one wedged statement into an app that
   * cannot switch networks. Two seconds is far longer than any statement here, so
   * reaching it means something is already wrong — hence the warn, and hence closing
   * regardless, because leaking the handle forever is the worse of the two.
   */
  const DRAIN_TIMEOUT_MS = 2000

  const drainInFlight = async (): Promise<void> => {
    if (inFlight.size === 0) return
    const pending = inFlight.size
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
    })
    const outcome = await Promise.race([Promise.allSettled([...inFlight]).then(() => 'drained' as const), timeout])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      // `console` because this package carries no logger dependency — same as platform.native.ts.
      console.warn(
        `[expo-sqlite-resilient] closing ${dbName} with ${inFlight.size} native call(s) still running after ${DRAIN_TIMEOUT_MS}ms`,
      )
    } else if (pending > 0) {
      console.debug(`[expo-sqlite-resilient] drained ${pending} native call(s) before closing ${dbName}`)
    }
  }

  const reopen = (after: SQLite.SQLiteDatabase): Promise<SQLite.SQLiteDatabase> => {
    // Another caller already reopened — return the fresh handle directly.
    if (db !== after) return Promise.resolve(db)
    // A reopen is already in flight — wait for it instead of racing.
    if (reopenInFlight !== null) return reopenInFlight

    reopenInFlight = (async () => {
      try {
        await db.closeAsync()
      } catch (e: unknown) {
        // Already dead — that's why we're reopening. `console` per this file's existing note.
        console.debug(`[expo-sqlite-resilient] close before reopen of ${dbName} threw: ${String(e)}`)
      }
      const fresh = await openWithRetry(true)
      db = fresh
      return fresh
    })()

    return reopenInFlight.finally(() => {
      reopenInFlight = null
    })
  }

  return {
    with: async (op) => {
      if (closed) throw new Error('Database is closed')
      const current = db
      const attempt = op(current)
      inFlight.add(attempt)
      try {
        return await attempt
      } catch (e) {
        if (!isStaleNativeHandleError(e)) throw e
        const fresh = await reopen(current)
        const retry = op(fresh)
        inFlight.add(retry)
        try {
          return await retry
        } finally {
          inFlight.delete(retry)
        }
      } finally {
        inFlight.delete(attempt)
      }
    },
    close: async () => {
      if (closed) return
      closed = true
      await drainInFlight()
      try {
        await db.closeAsync()
      } catch (e: unknown) {
        // Ordinarily already closed by an Android Activity destroy.
        console.debug(`[expo-sqlite-resilient] close of ${dbName} threw: ${String(e)}`)
      }
    },
  }
}
