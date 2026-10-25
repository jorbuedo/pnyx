/**
 * What we are spending at Koios, and what we had spent when it refused us.
 *
 * A 429 used to be unattributable. The pacer holds the app to 90 requests per 10s
 * against a documented 100, and nothing logged a single request — so when a device
 * was refused four seconds into a ~20-call gap scan there was no way to tell our own
 * traffic from the endpoint shedding load, and the question stayed open until the
 * refusal body was compared against Koios's own HAProxy config. The tally makes the
 * next one answerable from the log alone.
 *
 * Volume also matters beyond the 10-second window nobody was near: the tiers are
 * 5,000 requests a day unauthenticated and 50,000 authenticated, and at the pacer's
 * ceiling — 540 a minute — the authenticated day is gone in an hour and a half of
 * continuous scanning. `sinceLaunch` is what makes that visible before it bites.
 *
 * Requests reach here from the provider's own pacing chokepoint, so a call that goes
 * around the provider (asset metadata, `asset_nft_address`) must spend the same budget
 * through `RequestBudget.acquire` to be counted — otherwise the tally under-reports by
 * exactly the traffic that is hardest to see.
 *
 * @module
 */

import {RequestBudget} from '@evolution-sdk/evolution'
import {logger} from '../../logger'
import {classifyKoiosRefusal} from './koios-refusal'

const ORIGIN = 'koios-meter'

/** One request, as the tally remembers it. */
export type MeteredRequest = {
  readonly at: number
  readonly path: string
  readonly status: number
  /** How long the pacer held it back. Non-zero means the window was full. */
  readonly waitedMs: number
}

export type Tally = {
  readonly total: number
  /** Requests the endpoint refused with a 429. */
  readonly refused: number
  /** Requests the pacer had to hold back — the window was already full. */
  readonly held: number
  /** Busiest paths first, so a report names what was spending. Capped at {@link TOP_PATHS}. */
  readonly byPath: readonly {readonly path: string; readonly count: number}[]
  /** Distinct paths the cap left out of {@link byPath}. */
  readonly otherPaths: number
  /** Requests those left-out paths account for, so the listed counts can be reconciled. */
  readonly otherRequests: number
}

/** How much history the tally keeps. Longer than any limit window, short enough to bound it. */
export const METER_HISTORY_MS = 60_000

/** The window Koios enforces its per-credential limit over. */
const BURST_WINDOW_MS = 10_000

/** Paths named in a report. Enough to identify the spender, not a full histogram. */
const TOP_PATHS = 5

/** Drop what has aged out of the kept history. */
export const dropBefore = (requests: readonly MeteredRequest[], cutoff: number): readonly MeteredRequest[] =>
  requests.filter((r) => r.at > cutoff)

/**
 * Tally the requests at or after `since`.
 *
 * Ties in the path counts keep the order they were first seen, so a report of a
 * uniform walk reads the same twice rather than shuffling.
 */
export const tally = (requests: readonly MeteredRequest[], since: number): Tally => {
  const live = requests.filter((r) => r.at >= since)
  const counts = new Map<string, number>()
  let refused = 0
  let held = 0
  for (const r of live) {
    counts.set(r.path, (counts.get(r.path) ?? 0) + 1)
    if (r.status === 429) refused += 1
    if (r.waitedMs > 0) held += 1
  }
  const ranked = [...counts.entries()].map(([path, count]) => ({path, count})).sort((a, b) => b.count - a.count)
  const byPath = ranked.slice(0, TOP_PATHS)
  return {
    total: live.length,
    refused,
    held,
    byPath,
    // ⚠️ **What the cap dropped, counted.** Without this the breakdown reads as a complete
    // account of the window, and it is not — twice on 2026-09-08 an absent `/credential_utxos`
    // was taken as proof the UTxO fetch had never run, when it was the top-5 cut hiding it.
    // A bounded report that does not say it is bounded is worse than no report.
    otherPaths: ranked.length - byPath.length,
    otherRequests: ranked.slice(TOP_PATHS).reduce((sum, entry) => sum + entry.count, 0),
  }
}

/** `{'/address_utxos': 18, '/tip': 2}` — a log field, not prose. */
export const pathCounts = (t: Tally): Record<string, number> =>
  Object.fromEntries(t.byPath.map(({path, count}) => [path, count]))

export type MeterState = {
  readonly requests: readonly MeteredRequest[]
  readonly sinceLaunch: number
  readonly heldLoggedAt: number
  readonly volumeLoggedAt: number
}

/** At most one saturation line and one volume line per interval, whatever the traffic. */
const HELD_LOG_INTERVAL_MS = 30_000
const VOLUME_LOG_INTERVAL_MS = 60_000

export type MeterLine = {
  readonly level: 'debug' | 'warn'
  readonly message: string
  readonly data: Record<string, unknown>
}

/**
 * Fold one report into the tally and say what should be logged.
 *
 * Pure, so the reporting rule is testable without an observer, a clock or a logger:
 * the caller applies `state` and emits `lines`.
 */
export const meter = (
  state: MeterState,
  report: RequestBudget.RequestReport,
  now: number,
): {readonly state: MeterState; readonly lines: readonly MeterLine[]} => {
  const requests = [
    ...dropBefore(state.requests, now - METER_HISTORY_MS),
    {at: now, path: report.path, status: report.status, waitedMs: report.waitedMs},
  ]
  const sinceLaunch = state.sinceLaunch + 1
  const next: MeterState = {...state, requests, sinceLaunch}
  const lines: MeterLine[] = []

  const burst = tally(requests, now - BURST_WINDOW_MS)
  const minute = tally(requests, now - METER_HISTORY_MS)
  const spend = {
    inLast10s: burst.total,
    inLast60s: minute.total,
    sinceLaunch,
    paths: pathCounts(minute),
    // Only when the cap actually bit. Emitting zeros on every line would be noise, and a
    // reader seeing these fields at all is the signal that `paths` is incomplete.
    ...(minute.otherPaths > 0 ? {unlistedPaths: minute.otherPaths, unlistedRequests: minute.otherRequests} : {}),
  }

  const refusal = report.status === 429 ? classifyKoiosRefusal(`429 ${report.refusalBody ?? ''}`) : null
  if (refusal !== null) {
    lines.push({
      level: 'warn',
      message: 'Koios refused a request as rate-limited',
      data: {
        origin: ORIGIN,
        kind: refusal.kind,
        detail: refusal.detail,
        path: report.path,
        host: report.host,
        ...spend,
      },
    })
    // A refusal already carries the spend block a volume line would, so it stands in
    // for one: one line per interval unless something happened.
    return {state: {...next, volumeLoggedAt: now}, lines}
  }

  if (report.waitedMs > 0 && now - state.heldLoggedAt >= HELD_LOG_INTERVAL_MS) {
    lines.push({
      level: 'debug',
      message: 'the Koios pacer is holding requests back — the window is full',
      data: {origin: ORIGIN, waitedMs: report.waitedMs, inWindow: report.inWindow, ...spend},
    })
    return {state: {...next, heldLoggedAt: now, volumeLoggedAt: now}, lines}
  }

  if (now - state.volumeLoggedAt >= VOLUME_LOG_INTERVAL_MS) {
    lines.push({level: 'debug', message: 'Koios request volume', data: {origin: ORIGIN, ...spend}})
    return {state: {...next, volumeLoggedAt: now}, lines}
  }

  return {state: next, lines}
}

/** The state a fresh process starts from. `-Infinity` so the first line is not withheld. */
export const emptyMeter = (): MeterState => ({
  requests: [],
  sinceLaunch: 0,
  heldLoggedAt: Number.NEGATIVE_INFINITY,
  volumeLoggedAt: Number.NEGATIVE_INFINITY,
})

let state = emptyMeter()
let installed = false

/**
 * Start metering, once per process. Idempotent — every rail construction calls it.
 *
 * Installed from `cardanoRailLayer` rather than lazily from each call site, because
 * the budget holds **one** observer: a second installer would take the slot from
 * whoever had it. Anything issuing Koios requests before the first rail exists goes
 * uncounted, which is a few requests at startup and not worth a listener registry.
 *
 * The observer must not throw: it runs on the request path, and a throw here would
 * fail the request it is only supposed to count.
 */
export const installKoiosMeter = (): void => {
  if (installed) return
  installed = true
  RequestBudget.setObserver((report) => {
    try {
      const now = Date.now()
      const result = meter(state, report, now)
      state = result.state
      for (const line of result.lines) {
        if (line.level === 'warn') logger.warn(line.message, line.data)
        else logger.debug(line.message, line.data)
      }
    } catch (e) {
      // A counter must never be able to fail a request. Reported rather than
      // swallowed, so a broken tally is a visible bug and not a quiet gap.
      logger.warn('the Koios meter could not record a request', {origin: ORIGIN, error: String(e)})
    }
  })
  logger.debug('Koios request metering installed', {origin: ORIGIN})
}

/** Test seam: forget everything counted so far. */
export const resetKoiosMeter = (): void => {
  state = emptyMeter()
  installed = false
  RequestBudget.setObserver(null)
}
