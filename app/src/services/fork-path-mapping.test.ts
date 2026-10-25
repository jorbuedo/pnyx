/**
 * Drift guard: every tsconfig that declares `paths` must still map the fork.
 *
 * ⚠️ **`paths` REPLACES the inherited map rather than merging with it.** `app/tsconfig.json`
 * declares `@/*` for its own source alias, and that one line silently dropped
 * `tsconfig.base.json`'s `@evolution-sdk/*` entries for the app's whole project. With no mapping,
 * the fork resolved through its package `exports` to `./src/*.ts` — its SOURCE, type-checked under
 * our strictness, which its own tsconfig deliberately does not set. 296 errors in code that is
 * green in its own repo.
 *
 * ⚠️ **It stayed hidden because `tsc -b` is incremental.** The step-4 and step-5 swaps that first
 * gave this project a path to the fork were committed with a green `bun run check`, because the app
 * project was never rebuilt. Editing an unrelated file in the submodule forced the rebuild, and the
 * breakage surfaced two commits after it was introduced.
 *
 * So this compares the two maps as DATA. A new fork package added to the base config and forgotten
 * here fails, which is the mistake this file exists to make loud.
 *
 * @module
 */

import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')

/** Read a tsconfig, tolerating the `//` comments TypeScript allows and JSON does not. */
const readTsconfig = (relative: string): {compilerOptions?: {paths?: Record<string, string[]>}} => {
  const raw = readFileSync(join(REPO_ROOT, relative), 'utf8')
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(withoutComments)
}

const forkEntries = (paths: Record<string, string[]> | undefined): Record<string, string[]> =>
  Object.fromEntries(Object.entries(paths ?? {}).filter(([key]) => key.startsWith('@evolution-sdk/')))

describe('fork path mapping', () => {
  const base = forkEntries(readTsconfig('tsconfig.base.json').compilerOptions?.paths)
  const app = forkEntries(readTsconfig('app/tsconfig.json').compilerOptions?.paths)

  it('the base config maps the fork at all', () => {
    // If this is empty the rest of the file is comparing nothing to nothing.
    expect(Object.keys(base).length).toBeGreaterThan(0)
  })

  it('every fork mapping in the base config is also in the app project', () => {
    const missing = Object.keys(base).filter((key) => app[key] === undefined)
    expect(
      missing,
      `app/tsconfig.json declares its own \`paths\`, which REPLACES the inherited map.\n` +
        `These fork entries exist in tsconfig.base.json but not there:\n  ${missing.join('\n  ')}\n\n` +
        "Without them the app type-checks the fork's SOURCE under our strictness. Copy them across.",
    ).toEqual([])
  })

  it('the two maps agree on every target, so one cannot drift to source while the other points at dist', () => {
    const differing = Object.keys(base).filter(
      (key) => app[key] !== undefined && JSON.stringify(app[key]) !== JSON.stringify(base[key]),
    )
    expect(
      differing,
      `Fork mapping(s) disagree between tsconfig.base.json and app/tsconfig.json:\n  ${differing.join('\n  ')}`,
    ).toEqual([])
  })

  it('every fork mapping targets dist, never src', () => {
    // The whole point: the fork's own tsconfig sets neither `exactOptionalPropertyTypes` nor the
    // unused-local checks, so its source does not type-check under ours. Only its emitted
    // declarations do.
    for (const [key, targets] of Object.entries({...base, ...app})) {
      for (const target of targets) {
        expect(target, `${key} must resolve to the fork's built declarations`).toContain('/dist/')
        expect(target, `${key} must not reach the fork's source`).not.toContain('/src/')
      }
    }
  })
})
