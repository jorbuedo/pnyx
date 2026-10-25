/**
 * Drift guard: `src/config/env.ts` is the app's only reader of `process.env.EXPO_PUBLIC_*`, and the
 * manifest lists every variable that exists.
 *
 * Without this the system decays in the two ways it is built to prevent. A new raw read elsewhere
 * gets its own `??` default and we are back to a value that is right in one environment and silently
 * wrong in another. A read that never reaches the manifest is a variable the build gate cannot
 * require — which is exactly how `env/.env.production` came to declare no service URL with nothing
 * anywhere reporting it.
 *
 * @module
 */

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {READ_ENV_NAMES} from './env'
import {ENV_MANIFEST} from './env-manifest'

const APP_ROOT = join(__dirname, '..', '..')
const ROOTS = [join(APP_ROOT, 'src'), join(APP_ROOT, 'app')]

/**
 * Files allowed to read `process.env.EXPO_PUBLIC_*` directly.
 *
 * `env.ts` is the manifest's own reader. `scripts/` is out of scope entirely: those run in Node and
 * are not bundled, so Expo's inlining constraint — the reason app reads must be centralised — does
 * not apply to them.
 */
const ALLOWED = new Set(['src/config/env.ts'])

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const relative = (absolute: string): string => absolute.slice(APP_ROOT.length + 1).replaceAll('\\', '/')

/** Matches a real read, not the many doc comments that name the pattern to explain the constraint. */
const RAW_READ = /process\s*(\?)?\.\s*env\s*(\?)?\.\s*EXPO_PUBLIC_[A-Z0-9_]+/

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('no raw EXPO_PUBLIC reads outside the manifest', () => {
  it('is the only module reading process.env.EXPO_PUBLIC_*', () => {
    const offenders = ROOTS.flatMap((root) => walk(root))
      .map(relative)
      .filter((rel) => !ALLOWED.has(rel))
      // Tests legitimately set and read these to exercise absence; only production sources are bound
      // by the rule.
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => RAW_READ.test(stripComments(readFileSync(join(APP_ROOT, rel), 'utf8'))))

    expect(
      offenders,
      `These read process.env.EXPO_PUBLIC_* directly:\n${offenders.join('\n')}\n\n` +
        'Add an accessor in src/config/env.ts and an entry in src/config/env-manifest.ts instead. A ' +
        'read outside the manifest is a variable the build gate cannot require, and it will grow a ' +
        'default that is wrong in some environment.',
    ).toEqual([])
  })

  it('reads exactly the variables the manifest declares', () => {
    const declared = [...ENV_MANIFEST.map((spec) => spec.name)].sort()
    // Both directions matter: a read with no manifest entry is ungated, and an entry nothing reads is
    // a rename that lost its call site.
    expect([...READ_ENV_NAMES].sort()).toEqual(declared)
  })

  it('declares a purpose for every variable, so a gate failure explains itself', () => {
    const undocumented = ENV_MANIFEST.filter((spec) => spec.purpose.trim() === '').map((spec) => spec.name)
    expect(undocumented).toEqual([])
  })

  it('gives every enum its allowed values', () => {
    const unconstrained = ENV_MANIFEST.filter(
      (spec) => spec.kind === 'enum' && (spec.allowed === undefined || spec.allowed.length === 0),
    ).map((spec) => spec.name)
    expect(unconstrained).toEqual([])
  })
})
