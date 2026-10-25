/**
 * Pure view-model for the Connected dApps screen: turns persisted
 * {@link DappSession}s plus the known wallet groups into render-ready rows.
 * No React, no storage — see `docs/CONNECTED_DAPPS.md`.
 *
 * @module
 */

import type {ChainType, DappSession} from '@pnyx/dapp-connector'

/** The relative-time units `useI18n().formatRelativeTime` is called with here. */
export type ConnectedAgeUnit = 'minute' | 'hour' | 'day'

export type ConnectedDappRow = {
  /** Stable list key. */
  readonly id: string
  /** Normalized origin, e.g. `https://app.example` — the accessible label. */
  readonly origin: string
  /** Origin without its scheme, for display. */
  readonly host: string
  readonly chainType: ChainType
  /**
   * Display name of the wallet group the grant is bound to, or null when that
   * group no longer exists — callers omit the segment rather than inventing one.
   */
  readonly walletName: string | null
  /** Which derived account of that wallet the grant exposes. */
  readonly accountIndex: number
  /**
   * When the grant lapses. `never` for a until-revoked grant; otherwise a
   * positive offset + unit, ready for `formatRelativeTime` ("in 5 days").
   */
  readonly expiry:
    | {readonly kind: 'never'}
    | {readonly kind: 'in'; readonly value: number; readonly unit: ConnectedAgeUnit}
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Strip the scheme (and any trailing slash) for display. */
export const displayHost = (origin: string): string => origin.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '')

/** Negate for the past-facing offset Intl expects, without producing `-0`. */
const past = (n: number): number => (n === 0 ? 0 : -n)

/**
 * Coarsest unit that still reads as informative, for a span in ms.
 *
 * Elapsed time floors ("2 hours ago" while it's been 2h59m, the usual
 * convention); a countdown rounds, because flooring understates it by up to a
 * whole unit — a 7-day grant approved moments ago would read "in 6 days".
 * Rounding up to a unit's ceiling promotes to the next one, so no "in 24 hours".
 */
const coarsest = (span: number, mode: 'floor' | 'round'): {value: number; unit: ConnectedAgeUnit} => {
  const scale = (ms: number) => (mode === 'floor' ? Math.floor(span / ms) : Math.round(span / ms))
  if (span < HOUR_MS) {
    const minutes = scale(MINUTE_MS)
    return minutes >= 60 ? {value: 1, unit: 'hour'} : {value: minutes, unit: 'minute'}
  }
  if (span < DAY_MS) {
    const hours = scale(HOUR_MS)
    return hours >= 24 ? {value: 1, unit: 'day'} : {value: hours, unit: 'hour'}
  }
  return {value: scale(DAY_MS), unit: 'day'}
}

/**
 * How long ago the grant was approved, as a negative offset + unit. Clock skew
 * (a future timestamp) clamps to "now".
 */
export const connectedAge = (connectedAt: number, now: number): {value: number; unit: ConnectedAgeUnit} => {
  const {value, unit} = coarsest(Math.max(0, now - connectedAt), 'floor')
  return {value: past(value), unit}
}

/**
 * How long until the grant lapses. A `null` expiry never does. An already-lapsed
 * expiry clamps to zero — the manager prunes those, so it only shows under clock
 * skew, and "in 0 minutes" beats a negative countdown.
 */
export const expiresIn = (
  expiresAt: number | null,
  now: number,
): {kind: 'never'} | {kind: 'in'; value: number; unit: ConnectedAgeUnit} => {
  if (expiresAt === null) return {kind: 'never'}
  return {kind: 'in', ...coarsest(Math.max(0, expiresAt - now), 'round')}
}

/**
 * Build the rows, newest grant first. `walletNames` maps groupId → display name;
 * a session whose group is absent still renders (the grant is real and must stay
 * revocable) but without a wallet name.
 */
export const buildConnectedDappRows = (
  sessions: readonly DappSession[],
  walletNames: ReadonlyMap<string, string>,
  now: number,
): ConnectedDappRow[] =>
  [...sessions]
    .sort((a, b) => b.connectedAt - a.connectedAt)
    .map((session) => ({
      id: session.id,
      origin: session.origin,
      host: displayHost(session.origin),
      chainType: session.chainType,
      walletName: walletNames.get(session.groupId) ?? null,
      accountIndex: session.accountIndex,
      expiry: expiresIn(session.expiresAt, now),
    }))
