/**
 * Drift guard: web APIs that Hermes does not implement must not appear in bundled code.
 *
 * The failure this exists for is not "a feature degrades". `AbortSignal.timeout()` is usually
 * written as an argument to `fetch`, so it is evaluated BEFORE the request — and on Hermes it
 * throws `TypeError: AbortSignal.timeout is not a function`. Nothing is fetched at all, and the
 * nearest `catch` reports that as a network failure. Two shipped features were inert on device
 * this way: the CIP-171 provenance card rendered "could not check" for every script, and Trezor's
 * external coin definitions looked like a permanent 404.
 *
 * **Nothing else could have caught it.** TypeScript accepts these — they are in `lib.dom`, which
 * describes browsers, not Hermes. Node 18+ implements them, so unit tests and any `bun`/`node`
 * harness run against the real endpoint both pass. The gap is only visible on a device, which is
 * why it needs a guard rather than a habit.
 *
 * Scope is the **React Native bundle**: `app` plus every workspace package reachable
 * from its dependencies, resolved transitively here so adding a dependency extends the scan
 * without anyone remembering to. `services/` is deliberately out — those are Cloudflare Workers,
 * where these APIs exist and are the right thing to use.
 *
 * The replacement is always the same shape, and the repo has had it since before this guard:
 * an `AbortController`, a `setTimeout` that calls `abort()`, and a `finally` that clears the
 * timer. See `services/pnyx-session.ts` (`fetchWithDeadline`).
 *
 * @module
 */

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const APP_ROOT = join(__dirname, '..', '..')
const REPO_ROOT = join(APP_ROOT, '..')

/**
 * The statics to refuse, and what we actually know about each.
 *
 * `timeout` is **measured**: it threw on a Pixel emulator (RN 0.83.6, Hermes) on 2026-09-30, and
 * the log line naming it is what made the two dead features findable in one read. `any` is banned
 * on the same evidence standard we would want for `timeout` — same vintage, same `lib.dom`
 * provenance, and it was sitting on the very next line of the same call. It has NOT been observed
 * throwing, because `timeout` threw first. Banning it costs nothing: the hand-rolled controller
 * covers both, and a static nobody can rely on is not worth confirming on a device.
 */
const BANNED = ['timeout', 'any'] as const

const CALL = new RegExp(String.raw`AbortSignal\s*\.\s*(${BANNED.join('|')})\s*\(`)

/**
 * Source with comments removed, so the prose that must name these APIs — this file's own module
 * doc among it — is not mistaken for a call. Block comments go entirely; line comments go only
 * when they start the line, which keeps `foo() // note` intact and leaves a URL's `//` alone.
 */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')

const workspaceLocations = (): ReadonlyMap<string, string> => {
  const found = new Map<string, string>()
  for (const base of ['packages', join('packages', 'hardware')]) {
    const dir = join(REPO_ROOT, base)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const manifest = join(dir, entry, 'package.json')
      if (!existsSync(manifest)) continue
      const {name} = JSON.parse(readFileSync(manifest, 'utf8')) as {name?: string}
      if (name !== undefined) found.set(name, join(dir, entry))
    }
  }
  return found
}

const pnyxDependenciesOf = (packageDir: string): readonly string[] => {
  const manifest = join(packageDir, 'package.json')
  if (!existsSync(manifest)) return []
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  return Object.keys({...pkg.dependencies, ...pkg.peerDependencies}).filter((n) => n.startsWith('@pnyx/'))
}

/** Every workspace package that can reach the RN bundle, via the app's dependency closure. */
const bundledPackageDirs = (): readonly string[] => {
  const locations = workspaceLocations()
  const seen = new Set<string>()
  const pending = [...pnyxDependenciesOf(APP_ROOT)]
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || seen.has(name)) continue
    const dir = locations.get(name)
    if (dir === undefined) continue
    seen.add(name)
    pending.push(...pnyxDependenciesOf(dir))
  }
  return [...seen].map((name) => locations.get(name) as string)
}

const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'android' || entry === 'ios') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const scanned = (): readonly string[] => [
  ...walk(join(APP_ROOT, 'src')),
  ...walk(join(APP_ROOT, 'app')),
  ...bundledPackageDirs().flatMap((dir) => walk(dir)),
]

const relative = (absolute: string): string => absolute.slice(REPO_ROOT.length + 1).replaceAll('\\', '/')

describe('APIs Hermes does not implement', () => {
  it('scans the app and every package that reaches the bundle', () => {
    const files = scanned()
    // A guard that silently scanned nothing would pass forever.
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => relative(f).startsWith('packages/hardware/'))).toBe(true)
    expect(files.some((f) => relative(f).startsWith('app/src/'))).toBe(true)
  })

  it('finds no call to a banned AbortSignal static', () => {
    const offenders = scanned()
      .filter((file) => CALL.test(code(readFileSync(file, 'utf8'))))
      .map(relative)
      .sort()
    // Listed by path so a failure names the file to fix, not just a count.
    expect(offenders).toEqual([])
  })

  it('does not scan the Workers, where these APIs are correct', () => {
    expect(scanned().some((f) => relative(f).startsWith('services/'))).toBe(false)
  })
})
