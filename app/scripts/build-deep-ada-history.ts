#!/usr/bin/env bun
/**
 * Reduce Kraken's downloadable OHLCVT daily CSVs into the compact deep ADA→fiat
 * history JSON the app fetches (`services/price-history/deep-ada-history.ts`).
 *
 * Kraken publishes per-pair OHLCVT archives (complete + quarterly incrementals):
 *   complete:     https://drive.google.com/file/d/1ptNqWYidLkhb2VAKuLCxmp2OXEfGO-AP/view
 *   incrementals: https://drive.google.com/drive/folders/15RSlNuW_h0kVM8or8McOGOMfHeBFvFGI
 * Download the ZIP, extract the 1440-minute (daily) CSVs for the ADA pairs.
 * Each CSV has no header; columns are `timestamp,open,high,low,close,volume,trades`
 * with `timestamp` in unix **seconds** (daily rows land on midnight UTC).
 *
 * Usage:
 *   bun app/scripts/build-deep-ada-history.ts \
 *     USD=ADAUSD_1440.csv EUR=ADAEUR_1440.csv --out=deep-ada-history.json
 *
 * Then upload the output to R2 and point `EXPO_PUBLIC_DEEP_ADA_HISTORY_URL` at it.
 * Re-run each quarter with the incremental CSVs to refresh (older rows are
 * immutable; the app only needs `close` per day).
 *
 * @module
 */

import {readFileSync, writeFileSync} from 'node:fs'

/** Parse a Kraken OHLCVT daily CSV into ascending `[unixSec, close]` rows, deduped by day. */
const reduceCsv = (text: string): Array<[number, number]> => {
  const byTs = new Map<number, number>()
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue
    const cols = line.split(',')
    const ts = Number(cols[0])
    const close = Number(cols[4])
    if (Number.isFinite(ts) && Number.isFinite(close)) byTs.set(ts, close)
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0])
}

const main = (): void => {
  const args = process.argv.slice(2)
  const fiats: Record<string, Array<[number, number]>> = {}
  let out = 'deep-ada-history.json'

  for (const arg of args) {
    if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq <= 0) {
      console.error(`Bad argument: "${arg}" — expected FIAT=path.csv or --out=path.json`)
      process.exit(1)
    }
    const fiat = arg.slice(0, eq).toUpperCase()
    const path = arg.slice(eq + 1)
    fiats[fiat] = reduceCsv(readFileSync(path, 'utf8'))
  }

  if (Object.keys(fiats).length === 0) {
    console.error('No input CSVs. Example: USD=ADAUSD_1440.csv EUR=ADAEUR_1440.csv --out=deep-ada-history.json')
    process.exit(1)
  }

  const dataset = {asset: 'ADA', interval: '1d', fiats}
  writeFileSync(out, JSON.stringify(dataset))
  const summary = Object.entries(fiats)
    .map(([f, rows]) => `${f}=${rows.length}`)
    .join(', ')
  console.log(`Wrote ${out} (${summary} daily closes).`)
}

main()
