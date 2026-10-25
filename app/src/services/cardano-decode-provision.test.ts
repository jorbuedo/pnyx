/**
 * Drift guard: production code provides the app's decode layer, never a backend directly.
 *
 * Effect resolves the innermost `provide`, so a call site that builds its own backend shadows the
 * app's. Nine production sites were in that state when this was written, `cardanoRailLayer` among
 * them — which is every Cardano read, build and submit in the app — and each one silently sat on
 * the backend being retired while the default had already moved.
 *
 * ⚠️ The guard now names the backend that SHIPS, not the one that was retired. It originally
 * matched `PureTs(Codec|Decode)Layer`, and matching only a name that no longer exists anywhere is
 * a guard that passes by having nothing to find. What it protects is unchanged: one provision
 * point, so swapping or wrapping the backend is one file's decision rather than nine.
 *
 * ⚠️ The codec half is gone because the service is: nothing in the app requires `Codec` any more,
 * so there is no provision to guard. Only `Decode` is left to name a backend for.
 *
 * Tests are exempt by design. A test is the caller, and naming the backend it means to exercise is
 * the correct thing for it to do.
 *
 * @module
 */

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const APP_ROOT = join(__dirname, '..', '..')
const ROOTS = [join(APP_ROOT, 'src'), join(APP_ROOT, 'app')]

/**
 * `cardano-decode-layer.ts` is where the layer is defined, so it is the one module that names a
 * backend. `extension/` is outside `ROOTS` already: it is not bundled into the mobile app.
 */
const ALLOWED = new Set(['src/services/cardano-decode-layer.ts'])

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

/**
 * A provision or a construction, not a mention: the many comments naming a backend to explain the
 * rule are fine, and `stripComments` below is what keeps them so.
 */
const PROVIDES_BACKEND =
  /Effect\.provide\(\s*EvolutionDecodeLayer\s*\)|Layer\.mergeAll\([^)]*EvolutionDecodeLayer|makeEvolutionDecode\s*\(/

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('production code provides the app decode layer, not a backend', () => {
  it('has no production site building or providing a decode backend of its own', () => {
    const offenders = ROOTS.flatMap((root) => walk(root))
      .map(relative)
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => PROVIDES_BACKEND.test(stripComments(readFileSync(join(APP_ROOT, rel), 'utf8'))))

    expect(
      offenders,
      `These provide a decode backend directly:\n${offenders.join('\n')}\n\n` +
        'Provide `cardanoDecodeLayer` from src/services/cardano-decode-layer.ts instead. ' +
        "A hard-wired backend shadows the app's, so a change to how decoding is built reaches " +
        'every site but this one.',
    ).toEqual([])
  })
})
