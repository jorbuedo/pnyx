/**
 * What the app actually does between a reload and standing still.
 *
 * Reads a captured dev-log stream (the Metro console, or anything carrying the same
 * `LEVEL <iso> LEVEL [origin] message {json}` lines) and prints a timeline of one boot:
 * which subsystems ran, when each first and last spoke, how long the app was busy after
 * the bundle loaded, and where the network time went.
 *
 * The question it exists to answer is "why is this slow when we already have persisted
 * state" — so it separates **cache reads** (fast, and evidence the persisted state IS
 * being used) from **chain reads** (the part that has to happen), and shows the gaps
 * where nothing is logged at all.
 *
 *   bun app/scripts/boot-timeline.ts <logfile>
 *
 * Capture a log with the dev log stream running, e.g.
 *   tail -F metro.log > boot.log   # then force-stop and relaunch the app
 *
 * @module
 */

type Entry = {
  readonly at: number
  readonly level: string
  readonly origin: string
  readonly message: string
  readonly meta: Record<string, unknown>
}

const LINE = /^\s*(DEBUG|INFO|WARN|ERROR)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\w+\s+\[([^\]]+)\]\s+(.*)$/

const parse = (text: string): readonly Entry[] => {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (m === null) continue
    const [, level = '', iso = '', origin = '', rest = ''] = m
    const brace = rest.indexOf('{')
    let meta: Record<string, unknown> = {}
    if (brace >= 0) {
      try {
        meta = JSON.parse(rest.slice(brace)) as Record<string, unknown>
      } catch {
        // A truncated or multi-line payload. The message and timing still count, and
        // reporting a parse failure per line would bury the timeline it is printing.
        meta = {}
      }
    }
    out.push({
      at: Date.parse(iso),
      level,
      origin,
      message: (brace >= 0 ? rest.slice(0, brace) : rest).trim(),
      meta,
    })
  }
  return out
}

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`)
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n))

/** Requests, split by whether they left the device. */
const HOST = /"url":"https?:\/\/([^/"]+)([^"?]*)/

const main = (): void => {
  const path = process.argv[2]
  if (path === undefined) {
    console.error('usage: bun app/scripts/boot-timeline.ts <logfile>')
    process.exit(1)
  }
  const text = require('node:fs').readFileSync(path, 'utf8') as string
  const entries = parse(text)
  if (entries.length === 0) {
    console.error('no parseable log lines — is this a dev-log-stream capture?')
    process.exit(1)
  }

  // ⚠️ Anchor on the LAST `App starting`, not on the first line captured. A capture
  // usually opens while the previous process is still talking, and a failed launch
  // (the dev launcher's Fabric crash) leaves a whole boot's worth of lines in front of
  // the one being measured. Anchoring on the first line reported those as boot time.
  const boot = [...entries].reverse().find((e) => e.message.includes('App starting'))
  const t0 = boot?.at ?? entries[0]?.at ?? 0
  const measured = entries.filter((e) => e.at >= t0)
  const last = measured[measured.length - 1]?.at ?? t0
  const rel = (at: number) => ms(at - t0)

  const bySubsystem = new Map<string, {first: number; last: number; count: number}>()
  for (const e of measured) {
    const cur = bySubsystem.get(e.origin)
    if (cur === undefined) bySubsystem.set(e.origin, {first: e.at, last: e.at, count: 1})
    else bySubsystem.set(e.origin, {first: cur.first, last: e.at, count: cur.count + 1})
  }

  console.log(`\n=== boot timeline — ${measured.length} entries over ${ms(last - t0)} ===`)
  console.log(boot === undefined ? '(no "App starting" found; anchored on the first line)\n' : '')
  console.log(`${pad('subsystem', 30)} ${pad('first', 8)} ${pad('last', 8)} ${pad('span', 8)} lines`)
  console.log('-'.repeat(70))
  const ordered = [...bySubsystem.entries()].sort((a, b) => a[1].first - b[1].first)
  for (const [origin, s] of ordered) {
    if (origin === 'dev-fetch') continue
    console.log(
      `${pad(origin, 30)} ${pad(rel(s.first), 8)} ${pad(rel(s.last), 8)} ${pad(ms(s.last - s.first), 8)} ${s.count}`,
    )
  }

  // Where the network time went, by host and path prefix.
  const requests = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line.includes('fetch started')) continue
    const m = HOST.exec(line)
    if (m === null) continue
    const [, host = '', path0 = ''] = m
    const key = `${host}${path0.replace(/\/api\/v\d+/, '')}`
    requests.set(key, (requests.get(key) ?? 0) + 1)
  }
  if (requests.size > 0) {
    console.log('\n=== requests this boot ===\n')
    const total = [...requests.values()].reduce((a, b) => a + b, 0)
    for (const [key, n] of [...requests.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(n).padStart(4)}  ${key}`)
    }
    console.log(`${String(total).padStart(4)}  TOTAL`)
  }

  // The lines that name a phase boundary, so the long poles are readable in order.
  const MILESTONES = [
    'App starting',
    'Wallet provider initialized',
    'Wallet data store initialized',
    'Cardano discovery started',
    'Cardano discovery finished',
    'Walking a history window',
    'Recorded a history window',
    'History backfill paused',
    'dust sync finished',
    'Chain wallet sync completed',
  ]
  console.log('\n=== milestones ===\n')
  for (const e of measured) {
    if (!MILESTONES.some((m) => e.message.includes(m))) continue
    const detail = Object.entries(e.meta)
      .filter(([k]) =>
        ['durationMs', 'deriveMs', 'derivations', 'chainId', 'reason', 'complete', 'scanned'].includes(k),
      )
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ')
    console.log(`${pad(rel(e.at), 8)} ${pad(e.origin, 22)} ${e.message}${detail ? `  ${detail}` : ''}`)
  }

  // Quiet stretches: the app is doing something the logs do not name, and those are the
  // gaps worth instrumenting next.
  console.log('\n=== gaps over 1s with nothing logged ===\n')
  for (let i = 1; i < measured.length; i++) {
    const prev = measured[i - 1]
    const cur = measured[i]
    if (prev === undefined || cur === undefined) continue
    const gap = cur.at - prev.at
    if (gap < 1000) continue
    console.log(`${pad(rel(prev.at), 8)} +${pad(ms(gap), 8)} after [${prev.origin}] ${prev.message.slice(0, 60)}`)
  }
  console.log()
}

main()
