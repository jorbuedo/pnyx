import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

/**
 * The `Decode` backend the app drives on implements every method the app can reach.
 *
 * ⚠️ **Nothing checks this at compile time.** The backend is built by a factory returning an
 * object literal and the app reaches it through a service tag, so a method missing from it is a
 * hole in the service object and the first caller gets `undefined is not a function` at runtime
 * with a green type-check behind it.
 *
 * ⚠️ **It used to cover `Codec` too, and that half is gone because nothing calls a codec.** The
 * file was first "Evolution implements everything pure-TS does" — a proxy that died with that
 * backend — then "every method this tree calls on a codec receiver exists on the instance", which
 * held while there were such calls. There are none: `@pnyx/cardano-core`'s tiers call Evolution
 * directly and so does the app. A guard over a surface nothing reaches cannot fail, so it was
 * removed rather than left to read as coverage.
 *
 * What covers the bytes instead: `packages/cardano-core/tier-differential.test.ts` holds every
 * tier operation against the codec byte for byte, and the fork's own `Golden.test.ts` holds 238
 * vectors against the adapter.
 *
 * @module
 */

const ROOT = join(__dirname, '../../..')
const ROOTS = ['app', 'packages', 'services', 'harness']
const SKIP = new Set(['node_modules', 'dist', '.git', 'build', 'coverage', 'cardano-effect'])

const sources = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path)
  }
  return out
}

/**
 * Method names called on a receiver named `decode` (bare, or under `rail.` / `deps.`).
 *
 * Deliberately a source scan rather than a list someone maintains: a list goes stale the first
 * time a call site is added, and going stale here looks exactly like passing.
 */
const calledOn = (receiver: 'decode'): ReadonlySet<string> => {
  const pattern = new RegExp(String.raw`\b(?:rail\.|deps\.)?${receiver}\.([a-zA-Z][a-zA-Z0-9]*)\(`, 'g')
  const names = new Set<string>()
  for (const root of ROOTS) {
    for (const file of sources(join(ROOT, root))) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) names.add(match[1] as string)
    }
  }
  return names
}

const functionsOf = (backend: object): ReadonlySet<string> =>
  new Set(Object.keys(backend).filter((key) => typeof (backend as Record<string, unknown>)[key] === 'function'))

describe('the driving decode backend covers what the app reaches', () => {
  it('implements every decode method the source calls', async () => {
    const {make: makeEvolutionDecode} = await import('@evolution-sdk/review/Decode')
    const called = calledOn('decode')

    // A scan that found nothing would pass vacuously, so it is pinned before it is used.
    expect(called.size).toBeGreaterThan(0)
    expect(called.has('plutusData')).toBe(true)

    const missing = [...called].filter((method) => !functionsOf(makeEvolutionDecode()).has(method)).sort()
    expect(
      missing,
      `the driving backend is missing ${missing.length} decode method(s) the source calls. ` +
        'That is a hole in the service object, not an uncompared method.',
    ).toEqual([])
  })
})
