/**
 * Build a per-transaction CSV of the wallet's activity for tax / accounting
 * export: one row per asset movement (a tx's `ownDelta` leg) with the date, tx
 * type, asset, signed amount, unit price **at the tx's time**, and fiat value.
 *
 * Pure — the caller injects the asset-info resolver, the fiat-at-time resolver
 * ({@link FiatAtTime}), and a date formatter. Numbers are emitted invariant
 * (dot decimal, no grouping) so any spreadsheet imports them cleanly. A leg the
 * resolver can't price leaves the price/value cells blank (never a fabricated 0).
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import type {FiatAtTime} from '../../hooks/useCardanoPortfolioHistory'
import type {Cip113Marks} from './cip113/activity'
import {activityType} from './history-grouping'

export type CsvAssetInfo = {readonly ticker: string; readonly decimals: number}

export type ActivityCsvDeps = {
  /** Display info for an asset id (`undefined` = ADA). */
  readonly infoOf: (assetId: string | undefined) => CsvAssetInfo
  /** Fiat value of a quantity at a time (the activity resolver). */
  readonly fiatOf: FiatAtTime
  /** Active fiat code (column headers). */
  readonly currency: string
  /** Locale date-time formatter for a unix-ms timestamp. */
  readonly formatDate: (ms: number) => string
  /**
   * The active CIP-113 deployment's on-chain marks; empty where none is shipped.
   *
   * Passed in rather than read here so this stays pure, and required rather than optional so an
   * export cannot silently label a programmable-token transaction "Smart Contract" by omission.
   */
  readonly cip113: Cip113Marks
}

/** Invariant decimal string: fixed to `places`, trailing zeros trimmed. */
const num = (n: number, places: number): string => {
  if (!Number.isFinite(n)) return ''
  const s = n.toFixed(Math.min(Math.max(places, 0), 20))
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** RFC-4180 field: quote when it contains a comma, quote, or newline. */
const field = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

const abs = (q: bigint): bigint => (q < 0n ? -q : q)
const wholeUnits = (q: bigint, decimals: number): number => Number(q) / 10 ** decimals

/**
 * CSV text (CRLF-terminated rows, a header row first) for `txs`. Skips
 * timestamp-less (pending) txs and zero-quantity legs.
 */
export const buildActivityCsv = (txs: readonly ReviewedTransaction[], deps: ActivityCsvDeps): string => {
  const {infoOf, fiatOf, currency, formatDate} = deps
  const {cip113} = deps
  const header = ['Date', 'Type', 'Asset', 'Amount', `Unit price (${currency})`, `Value (${currency})`, 'Tx hash']
  const rows: string[] = [header.map(field).join(',')]

  for (const tx of txs) {
    if (tx.timestamp === undefined) continue
    const ms = Date.parse(tx.timestamp)
    if (!Number.isFinite(ms)) continue
    const ts = Math.floor(ms / 1000)
    const date = formatDate(ms)
    const type = activityType(tx, cip113)

    for (const leg of tx.ownDelta) {
      if (leg.quantity === 0n) continue
      const info = infoOf(leg.assetId)
      const amount = wholeUnits(leg.quantity, info.decimals) // signed
      const fiat = fiatOf(leg.assetId ?? '', abs(leg.quantity), info.decimals, ts)
      const unitPrice = fiat !== null && amount !== 0 ? fiat.value / Math.abs(amount) : null
      const value = fiat !== null ? (leg.quantity < 0n ? -fiat.value : fiat.value) : null
      rows.push(
        [
          date,
          type,
          info.ticker,
          num(amount, info.decimals),
          unitPrice === null ? '' : num(unitPrice, 8),
          value === null ? '' : num(value, 2),
          tx.hash ?? '',
        ]
          .map(field)
          .join(','),
      )
    }
  }
  return rows.join('\r\n')
}
