/**
 * Every caught error logs (CLAUDE.md). This fails when a file gains a **new** silent handler.
 *
 * Why a baseline rather than zero: the rule arrived after the code did — 183 sites across 87 files at the
 * time of writing. Failing on all of them would mean a permanently red suite, which teaches everyone to
 * ignore the guard. So `silent-catch-baseline.json` pins the count per file: a new silent handler fails,
 * and fixing one asks you to lower the number, so it can only travel one way. The sweep to empty it is
 * under way; an empty baseline is the end state, not a broken test.
 *
 * What it can see: handlers with **no error parameter at all** (`.catch(() => …)`,
 * `catchAll(() => Effect.succeed…)`, and any paramless `catch {`) — the mechanical cases, where nothing
 * was even captured to log. A handler that takes the error and then ignores it looks identical to a good
 * one from here; that is a review matter, and the rule covers it even though this test cannot.
 *
 * ⚠️ **The `catch` pattern was `catch \{\s*\}` — empty only — until 2026-08-22.** Three shapes slipped
 * through it: a non-empty paramless catch (`catch { setItems([]) }`, which was reporting a failed read
 * as "no pending reviews"), a comment between the braces, and a promise with no rejection handler at
 * all. Widening it to any paramless `catch` surfaced ~250 sites that had never been counted, so the
 * baseline below is not a record of new debt — it is the first honest measurement of an old one. A
 * promise missing its `.catch` entirely is still invisible here; that wants a lint rule, not a grep.
 *
 * ⚠️ Passing means you added no *new* silent handler. It does not mean your error path says anything
 * useful.
 */

import {execFileSync} from 'node:child_process'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'

import baseline from './silent-catch-baseline.json'

const repoRoot = path.resolve(__dirname, '../../..')

const PATTERNS = [
  String.raw`\.catch\(\(\) =>`,
  String.raw`catchAll\(\(\) => Effect\.(succeed|void)`,
  // Any **paramless** `catch {`, not just an empty one. `catch (e) {` is excluded by the missing
  // paren, which is the point: this pattern is the "nothing was even captured" class, and a body or a
  // comment between the braces does not change that. `catch { setItems([]) }` used to slip through and
  // was rendering a failed read as "no pending reviews"; a comment alone also defeated `\s*`.
  String.raw`catch \{`,
]

const SEARCH_ROOTS = ['app/src', 'app/app', 'packages']

/**
 * Per-file counts from one `rg`. `roots` is swapped for a fixture directory by the
 * mechanism check below, so both run the *same* invocation.
 *
 * rg exits 1 when nothing matches, which `execFileSync` raises — an empty codebase is
 * the goal of this rule, so that is a result, not a failure. Any other status is a
 * broken search and rethrows.
 */
const countsIn = (roots: readonly string[], cwd: string): Record<string, number> => {
  let out: string
  try {
    out = execFileSync(
      'rg',
      [
        '--no-heading',
        '-c',
        ...PATTERNS.flatMap((p) => ['-e', p]),
        '-g',
        '*.ts',
        '-g',
        '*.tsx',
        '-g',
        '!*.test.ts',
        '-g',
        '!*.test.tsx',
        '-g',
        '!**/dist/**',
        '-g',
        '!**/node_modules/**',
        ...roots,
      ],
      {cwd, encoding: 'utf8'},
    )
  } catch (e) {
    const status = (e as {status?: unknown}).status
    if (status === 1) return {}
    throw e
  }
  const counts: Record<string, number> = {}
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const at = line.lastIndexOf(':')
    counts[line.slice(0, at)] = Number.parseInt(line.slice(at + 1), 10)
  }
  return counts
}

/** Current counts per file, from the same search that produced the baseline. */
const currentCounts = (): Record<string, number> => withoutExempt(countsIn(SEARCH_ROOTS, repoRoot))

/**
 * One sample of every pattern, in a file the production search would accept (`.ts`, not
 * `.test.ts`). Written outside the repo so the real search never sees it.
 */
const writeFixture = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'silent-catch-'))
  writeFileSync(
    path.join(dir, 'fixture.ts'),
    [
      'export const a = () => p.catch(() => undefined)',
      'export const b = () => e.pipe(Effect.catchAll(() => Effect.succeed(null)))',
      'export const c = () => e.pipe(Effect.catchAll(() => Effect.void))',
      'export const d = () => {',
      '  try {',
      '    f()',
      '  } catch {}',
      '}',
      'export const e = () => {',
      '  try {',
      '    f()',
      // The three shapes the empty-only pattern used to miss.
      '  } catch { fallback() }',
      '}',
      'export const g = () => {',
      '  try {',
      '    f()',
      '  } catch {',
      '    // explained, but not logged',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  return dir
}

const BASELINE = baseline as Record<string, number>

/**
 * The two places where this rule cannot apply, because the thing that failed is the logging.
 *
 * `packages/logger/logger.ts` catches a transport throwing: logging that would re-enter the
 * transport that just threw, which is the loop the catch exists to break.
 * `packages/migrations/load.ts` wraps a logger call so an ultra-hostile environment where the
 * logger itself throws synchronously does not take the migration down with it.
 *
 * Both carry the reasoning in a comment at the site. Exempt rather than baselined, so an empty
 * baseline stays the reachable end state rather than a number that can never go below two.
 */
const CANNOT_LOG = new Set(['packages/logger/logger.ts', 'packages/migrations/load.ts'])

const withoutExempt = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([file]) => !CANNOT_LOG.has(file)))

describe('silent error handlers', () => {
  it('the search itself works — a broken one must fail loudly, not report a clean codebase', () => {
    // Against the codebase this can only ever be "0 files", which is both the goal of the
    // rule and what a broken `rg` invocation looks like. So the mechanism is proven on a
    // fixture that definitely contains every pattern.
    const dir = writeFixture()
    // Six matching lines: `.catch`, both `catchAll` variants, and three paramless `catch` shapes —
    // empty, non-empty, and comment-only. The last two are the ones the empty-only pattern missed.
    expect(countsIn(['.'], dir)).toEqual({'./fixture.ts': 6})
  })

  it('no file gains a silent handler', () => {
    const current = currentCounts()
    const regressions = Object.entries(current)
      .filter(([file, count]) => count > (BASELINE[file] ?? 0))
      .map(([file, count]) => `${file}: ${BASELINE[file] ?? 0} → ${count}`)
    expect(
      regressions,
      'A caught error must log (CLAUDE.md). Log it, or if you removed one instead, lower the count in ' +
        'app/src/logger/silent-catch-baseline.json.',
    ).toEqual([])
  })

  it('the baseline has no stale entries, so fixed files cannot hide a later regression', () => {
    const current = currentCounts()
    const stale = Object.entries(BASELINE)
      .filter(([file, count]) => (current[file] ?? 0) < count)
      .map(([file, count]) => `${file}: baseline ${count}, actual ${current[file] ?? 0}`)
    expect(stale, 'Fixed some? Lower these in silent-catch-baseline.json to lock the improvement in.').toEqual([])
  })
})
