/**
 * Runs the height watchdog once. Installed as a 5-minute LaunchDaemon by `bin/install-watchdog.sh`.
 *
 * Separate from `height-watchdog.ts` so that module stays importable by its test: `tsconfig.tests.json`
 * deliberately omits the `bun` types (they supply a conflicting `fetch` and break fetch mocks), so a
 * single module touching `Bun.*` would fail the test pass. This is the same shape as the reason
 * `learn()` in readahead-proxy.ts was untestable -- the side effects live in their own file.
 */

import {decide, INITIAL_STATE, type Sample, type WatchdogState} from './height-watchdog.js'

const PG = process.env.PNYX_PG_CONTAINER ?? 'pnyx-pg-mainnet'
const INDEXER = process.env.PNYX_INDEXER_CONTAINER ?? 'pnyx-chain-indexer-mainnet'
const STATE_PATH = process.env.PNYX_WATCHDOG_STATE ?? `${process.env.HOME}/pnyx-midnight/watchdog-state.json`

const log = (level: 'info' | 'warn' | 'error', message: string, kvs: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({t: new Date().toISOString(), level, message, ...kvs}))

const podman = (args: string[]): {ok: boolean; out: string; err: string} => {
  const p = Bun.spawnSync(['podman', ...args])
  return {
    ok: p.exitCode === 0,
    out: new TextDecoder().decode(p.stdout).trim(),
    err: new TextDecoder().decode(p.stderr).trim(),
  }
}

const readSample = (): Sample => {
  const h = podman(['exec', PG, 'psql', '-U', 'indexer', '-d', 'indexer', '-tAc', 'select max(height) from blocks'])
  if (!h.ok) return {readable: false, error: `height query failed: ${h.err || h.out || 'no output'}`}
  const height = Number(h.out)
  if (!Number.isInteger(height)) return {readable: false, error: `height query returned ${JSON.stringify(h.out)}`}

  const state = podman(['inspect', INDEXER, '--format', '{{.State.Running}}'])
  if (!state.ok) return {readable: false, error: `inspect failed: ${state.err || state.out || 'no output'}`}
  return {readable: true, height, containerRunning: state.out === 'true'}
}

const loadState = async (): Promise<WatchdogState> => {
  const file = Bun.file(STATE_PATH)
  if (!(await file.exists())) {
    log('info', 'no watchdog state yet, starting fresh', {path: STATE_PATH})
    return INITIAL_STATE
  }
  try {
    return {...INITIAL_STATE, ...((await file.json()) as Partial<WatchdogState>)}
  } catch (e) {
    // A corrupt state file must not wedge the watchdog, but it does reset the stall count, so say so.
    log('warn', 'watchdog state unreadable, starting fresh', {path: STATE_PATH, error: String(e)})
    return INITIAL_STATE
  }
}

const prev = await loadState()
const {act, next} = decide(prev, readSample(), Date.now())

switch (act.action) {
  case 'advancing':
    log('info', 'height advancing', act)
    break
  case 'first-sample':
    log('info', 'first height sample, nothing to compare yet', act)
    break
  case 'unreadable':
    log('warn', 'could not read height, state left untouched', act)
    break
  case 'hold':
    log('warn', 'height has not moved', act)
    break
  case 'restart': {
    log('warn', 'height stuck, restarting the indexer', {...act, container: INDEXER})
    const r = podman(['restart', INDEXER])
    if (r.ok) log('info', 'indexer restarted', {container: INDEXER, attempt: act.attempt})
    else log('error', 'indexer restart failed', {container: INDEXER, error: r.err || r.out || 'no output'})
    break
  }
  case 'escalate':
    // Nothing on this box has an alerting channel yet, so this is as loud as it gets: a level
    // `error` line here and one in the unified system log. A human is needed at this point --
    // restarting has already been tried MAX_RESTARTS times and did not take.
    log('error', 'height STILL stuck after the restart budget, needs a human', {...act, container: INDEXER})
    Bun.spawnSync(['/usr/bin/logger', '-t', 'pnyx-watchdog', `indexer stuck at height ${act.height}`])
    break
}

await Bun.write(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`)
