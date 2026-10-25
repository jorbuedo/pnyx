/**
 * Dev-only perf tracers.
 *
 * Thin wrappers on top of `@pnyx/logger` for tracking things the React
 * DevTools profiler can't see directly: context-value identity churn, effect
 * wall-clock cost, mount-time fan-outs, and render rates on suspect components.
 *
 * All tracers emit through the app logger at `debug` level with
 * `origin: 'perf:<name>'`, so they can be isolated by calling
 * `logger.setFilter(/^perf:/)` and exported via `dumpPerfTrail()`.
 *
 * Everything is gated by `__DEV__`; the hooks still call their inner
 * React hooks (so the hook order stays consistent between dev and prod)
 * but the actual measurement/logging branches are dead-stripped in prod.
 *
 * @module
 */

import type {LogEntry, LogMetadata} from '@pnyx/logger'
import {useEffect, useRef} from 'react'
import {UnistylesRuntime} from 'react-native-unistyles'
import {logger} from '../logger'

declare const __DEV__: boolean

// ── Time helpers ──────────────────────────────────────────────────────────────

const now = (): number => {
  // Hermes and web both expose performance.now() with sub-ms resolution.
  // Fall back to Date.now() if unavailable (shouldn't happen in practice).
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

// ── Identity tracker ──────────────────────────────────────────────────────────

type IdentityBucket = {
  count: number
  firstAt: number
  lastAt: number
  timer: ReturnType<typeof setTimeout> | null
  total: number
}

const identityBuckets = new Map<string, IdentityBucket>()
const IDENTITY_FLUSH_MS = 1000

const flushIdentityBucket = (name: string): void => {
  const bucket = identityBuckets.get(name)
  if (!bucket) return
  if (bucket.timer != null) {
    clearTimeout(bucket.timer)
    bucket.timer = null
  }
  if (bucket.count === 0) return
  const span = bucket.lastAt - bucket.firstAt
  logger.debug(`identity:burst ${name}`, {
    origin: `perf:${name}`,
    type: 'debug',
    count: bucket.count,
    total: bucket.total,
    spanMs: Math.round(span * 100) / 100,
    ratePerSec: span > 0 ? Math.round((bucket.count / span) * 1000) : bucket.count,
  })
  bucket.count = 0
  bucket.firstAt = 0
  bucket.lastAt = 0
}

/** Logs ref-identity changes for `value`, bucketed to one summary per second to avoid flooding. */
export function useIdentityTracker<T>(name: string, value: T): void {
  const prevRef = useRef<T | null>(null)
  const initRef = useRef(false)

  // Cleanup must be registered unconditionally to keep hook order
  // stable across __DEV__ branches. In production the cleanup is a
  // no-op because no bucket entry was ever created.
  useEffect(() => {
    return () => {
      if (!__DEV__) return
      // Flush any pending count and drop the bucket entry so a
      // remount of the same name starts fresh (otherwise the
      // module-level Map would carry a stale `total` across mounts).
      flushIdentityBucket(name)
      identityBuckets.delete(name)
    }
  }, [name])

  if (!__DEV__) return

  if (!initRef.current) {
    initRef.current = true
    prevRef.current = value
    logger.debug(`identity:init ${name}`, {origin: `perf:${name}`, type: 'debug'})
    return
  }

  if (Object.is(prevRef.current, value)) return
  prevRef.current = value

  const t = now()
  let bucket = identityBuckets.get(name)
  if (!bucket) {
    bucket = {count: 0, firstAt: 0, lastAt: 0, timer: null, total: 0}
    identityBuckets.set(name, bucket)
  }
  if (bucket.count === 0) bucket.firstAt = t
  bucket.lastAt = t
  bucket.count += 1
  bucket.total += 1
  if (bucket.timer == null) {
    bucket.timer = setTimeout(() => flushIdentityBucket(name), IDENTITY_FLUSH_MS)
  }
}

// ── Render counter (buffered) ─────────────────────────────────────────────────

type RenderBucket = {count: number; firstAt: number; lastAt: number; timer: ReturnType<typeof setTimeout> | null}

const renderBuckets = new Map<string, RenderBucket>()
const RENDER_FLUSH_MS = 1000

const flushRenderBucket = (name: string): void => {
  const bucket = renderBuckets.get(name)
  if (!bucket) return
  // Cancel any still-pending scheduled flush so it can't fire after an
  // explicit flush (e.g. on unmount) and prematurely flush the bucket of a
  // new same-named instance that mounts before the orphan timer fires.
  if (bucket.timer != null) {
    clearTimeout(bucket.timer)
    bucket.timer = null
  }
  if (bucket.count === 0) return
  const span = bucket.lastAt - bucket.firstAt
  logger.debug(`render:burst ${name}`, {
    origin: `perf:${name}`,
    type: 'debug',
    count: bucket.count,
    spanMs: Math.round(span * 100) / 100,
    ratePerSec: span > 0 ? Math.round((bucket.count / span) * 1000) : bucket.count,
  })
  bucket.count = 0
  bucket.firstAt = 0
  bucket.lastAt = 0
}

/**
 * Counts renders of a component. Buffers and flushes every {@link RENDER_FLUSH_MS}
 * so a 3 000-renders/sec component produces one summary log per second instead
 * of blowing the trail.
 *
 * @example
 * ```tsx
 * export function TransactionListItem(props) {
 *   useRenderCounter('TransactionListItem')
 *   // …
 * }
 * ```
 */
export function useRenderCounter(name: string): void {
  useEffect(() => {
    return () => {
      // Flush any pending renders on unmount.
      if (__DEV__) flushRenderBucket(name)
    }
  }, [name])

  if (!__DEV__) return

  const t = now()
  let bucket = renderBuckets.get(name)
  if (!bucket) {
    bucket = {count: 0, firstAt: 0, lastAt: 0, timer: null}
    renderBuckets.set(name, bucket)
  }
  if (bucket.count === 0) bucket.firstAt = t
  bucket.lastAt = t
  bucket.count += 1
  if (bucket.timer === null) {
    bucket.timer = setTimeout(() => flushRenderBucket(name), RENDER_FLUSH_MS)
  }
}

// ── Sync / async measurement ──────────────────────────────────────────────────

/**
 * Measures a synchronous function's wall-clock duration and logs it.
 * Returns the function's result unchanged.
 */
export function measureSync<T>(name: string, fn: () => T, extra?: LogMetadata): T {
  if (!__DEV__) return fn()
  const start = now()
  try {
    return fn()
  } finally {
    const dur = now() - start
    logger.debug(`measure:sync ${name}`, {
      origin: `perf:${name}`,
      type: 'debug',
      durationMs: Math.round(dur * 100) / 100,
      ...extra,
    })
  }
}

/** Measures an async operation. */
export async function measureAsync<T>(name: string, promise: Promise<T>, extra?: LogMetadata): Promise<T> {
  if (!__DEV__) return promise
  const start = now()
  try {
    const v = await promise
    const dur = now() - start
    logger.debug(`measure:async ${name} ok`, {
      origin: `perf:${name}`,
      type: 'debug',
      durationMs: Math.round(dur * 100) / 100,
      ...extra,
    })
    return v
  } catch (e) {
    const dur = now() - start
    logger.debug(`measure:async ${name} err`, {
      origin: `perf:${name}`,
      type: 'debug',
      durationMs: Math.round(dur * 100) / 100,
      error: e instanceof Error ? e.message : String(e),
      ...extra,
    })
    throw e
  }
}

// ── Fan-out tracker ───────────────────────────────────────────────────────────

/**
 * Logs the start/end of a fan-out (N parallel operations) and each operation's
 * individual duration. Used for things like "sync every chain in this wallet
 * group".
 *
 * @example
 * ```ts
 * const fo = startFanout('WalletProvider.syncChainWallet', group.wallets.map(w => `${w.groupId}:${w.chainId}`))
 * for (const w of group.wallets) {
 *   const label = `${w.groupId}:${w.chainId}`
 *   service.syncChainWallet(…).then(() => fo.itemOk(label)).catch((e) => fo.itemErr(label, e))
 * }
 * ```
 */
export function startFanout(
  name: string,
  items: readonly string[],
): {
  itemOk: (label: string) => void
  itemErr: (label: string, err: unknown) => void
} {
  if (!__DEV__) {
    return {itemOk: () => {}, itemErr: () => {}}
  }
  const start = now()
  const totalCount = items.length
  const pending = new Map<string, number>()
  for (const label of items) pending.set(label, start)

  logger.debug(`fanout:start ${name}`, {
    origin: `perf:${name}`,
    type: 'debug',
    totalCount,
    items: items.slice(0, 20), // cap log size — first 20 is usually enough
  })

  const finishIfEmpty = () => {
    if (pending.size === 0) {
      const totalDur = now() - start
      logger.debug(`fanout:done ${name}`, {
        origin: `perf:${name}`,
        type: 'debug',
        totalCount,
        totalDurationMs: Math.round(totalDur * 100) / 100,
      })
    }
  }

  return {
    itemOk(label) {
      const t0 = pending.get(label)
      if (t0 === undefined) return
      pending.delete(label)
      logger.debug(`fanout:item ${name}`, {
        origin: `perf:${name}`,
        type: 'debug',
        label,
        durationMs: Math.round((now() - t0) * 100) / 100,
        remaining: pending.size,
      })
      finishIfEmpty()
    },
    itemErr(label, err) {
      const t0 = pending.get(label)
      if (t0 === undefined) return
      pending.delete(label)
      logger.debug(`fanout:item ${name} err`, {
        origin: `perf:${name}`,
        type: 'debug',
        label,
        durationMs: Math.round((now() - t0) * 100) / 100,
        remaining: pending.size,
        error: err instanceof Error ? err.message : String(err),
      })
      finishIfEmpty()
    },
  }
}

// ── Heap sampler + size probes ──────────────────────────────────────────────

type HermesStats = {
  js_heapSize?: number
  js_allocatedBytes?: number
  js_mallocSizeEstimate?: number
  js_numGCs?: number
}

const lastSizes = new Map<string, number>()

/**
 * Dev-only: publish the current element count of a suspect in-memory
 * collection (assets, txs, utxos). The heap sampler logs all reported sizes
 * alongside the Hermes heap so a climb toward OOM can be attributed to a
 * specific structure. No-op in prod.
 */
export const reportSize = (name: string, n: number): void => {
  if (!__DEV__) return
  lastSizes.set(name, n)
}

let heapSamplerTimer: ReturnType<typeof setInterval> | null = null

/** Starts the periodic heap sampler (idempotent). Returns a stop fn. */
export const startHeapSampler = (intervalMs = 2000): (() => void) => {
  if (!__DEV__ || heapSamplerTimer != null) return () => {}
  const hermes = (globalThis as {HermesInternal?: {getInstrumentedStats?: () => HermesStats}}).HermesInternal
  const mb = (n: number | undefined): number | undefined =>
    typeof n === 'number' ? Math.round(n / 1e5) / 10 : undefined
  const tick = (): void => {
    const s = hermes?.getInstrumentedStats?.() ?? {}
    const sizes: Record<string, number> = {}
    for (const [k, v] of lastSizes) sizes[k] = v
    logger.debug('heap:sample', {
      origin: 'perf:heap',
      type: 'debug',
      heapMB: mb(s.js_heapSize),
      liveMB: mb(s.js_allocatedBytes),
      mallocMB: mb(s.js_mallocSizeEstimate),
      numGCs: s.js_numGCs,
      ...sizes,
    })
  }
  tick()
  heapSamplerTimer = setInterval(tick, intervalMs)
  return () => {
    if (heapSamplerTimer != null) clearInterval(heapSamplerTimer)
    heapSamplerTimer = null
  }
}

// ── Trail export ──────────────────────────────────────────────────────────────

/**
 * Returns the logger's in-memory trail (optionally filtered by origin prefix).
 *
 * In dev builds this is exposed as `globalThis.__getPerfTrail` so external
 * tooling (Playwright runner, devtools console) can read the trail directly
 * without parsing console output.
 */
export function getPerfTrail(originPrefix: string | RegExp = /^perf:/): readonly LogEntry[] {
  const re = typeof originPrefix === 'string' ? new RegExp(`^${originPrefix}`) : originPrefix
  return logger.trail.filter((e) => re.test(e.metadata.origin ?? ''))
}

/**
 * Dumps the logger's in-memory trail (optionally filtered by origin prefix)
 * as a single JSON message to the console so it can be copy-pasted out of
 * Metro or logcat in one go.
 *
 * In dev builds this is exposed as `globalThis.__dumpPerfTrail` so you can
 * invoke it from the React Native debugger console.
 */
export function dumpPerfTrail(originPrefix: string | RegExp = /^perf:/): void {
  const filtered = getPerfTrail(originPrefix)
  // Route the export through the logger itself so it lands in the console
  // transport and inherits any other transports that are attached.
  logger.info(`perf-trail export — ${filtered.length} entries`, {
    origin: 'perf:export',
    type: 'debug',
    entries: filtered,
  })
}

/**
 * Dev-only theme switch hook used by the Playwright perf runner. Calling
 * UnistylesRuntime.setTheme directly bypasses ThemeProvider's persistence
 * effect — that's intentional here, the perf scenario only cares about the
 * render fan-out, not about what gets stored in AsyncStorage.
 */
const setThemeForTest = (name: 'pnyxDark' | 'pnyxLight'): void => {
  UnistylesRuntime.setTheme(name)
}

if (__DEV__) {
  // Expose on globalThis for easy access from the debugger console and from
  // external tooling (Playwright perf runner).
  const g = globalThis as unknown as {
    __dumpPerfTrail?: typeof dumpPerfTrail
    __getPerfTrail?: typeof getPerfTrail
    __setTheme?: typeof setThemeForTest
    __startHeapSampler?: typeof startHeapSampler
  }
  g.__dumpPerfTrail = dumpPerfTrail
  g.__getPerfTrail = getPerfTrail
  g.__setTheme = setThemeForTest
  // Opt-in only: a 2s heap:sample tick drowns the dev log stream when no
  // leak hunt is underway. Call __startHeapSampler() from the debugger
  // console (or tooling) when you need it.
  g.__startHeapSampler = startHeapSampler
}
