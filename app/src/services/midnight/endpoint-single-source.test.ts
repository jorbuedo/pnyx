/**
 * Drift guard: `services/midnight/networks.ts` is the only module that resolves a Midnight endpoint.
 *
 * This exists because the same mistake was made in four places and then forgotten. Two build-time
 * variables, `EXPO_PUBLIC_MIDNIGHT_INDEXER_URL` and `EXPO_PUBLIC_MIDNIGHT_NODE_URL`, supplied endpoints
 * for the **funds** rail — whose network is a runtime selector — so `.env.preview`'s mainnet indexer
 * refused a correctly-derived preprod address with `expected HRP mn_dust, but was mn_dust_preprod`.
 * Four modules resolved endpoints, two of them exported a function called `midnightIndexerUrl` meaning
 * *different chains*, and three separate comments asserted the wrong model, which is what made it look
 * deliberate.
 *
 * Prose cannot hold that line; this can. A fifth copy fails here instead of on a device.
 *
 * @module
 */

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

const APP_ROOT = join(__dirname, '..', '..', '..')
const ROOTS = [join(APP_ROOT, 'src'), join(APP_ROOT, 'app')]

/** The single source. */
const ALLOWED_HOSTS = new Set(['src/services/midnight/networks.ts'])

/**
 * This guard names every pattern it forbids, so it matches itself. Excluded by exact path rather than
 * by excluding tests wholesale — a test that hardcodes an endpoint is still a copy worth failing on.
 */
const SELF = 'src/services/midnight/endpoint-single-source.test.ts'

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const files = ROOTS.flatMap((root) => walk(root)).map((full) => ({
  rel: full.slice(APP_ROOT.length + 1).replaceAll('\\', '/'),
  text: readFileSync(full, 'utf8'),
}))

describe('a Midnight endpoint has exactly one source', () => {
  it('finds the files it is meant to be checking', () => {
    // A walk that silently matched nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.rel === 'src/services/midnight/networks.ts')).toBe(true)
  })

  it('hardcodes a Midnight indexer or node host in no production module', () => {
    // Matches the real hosts, not a scheme, so a doc URL in prose is not a false positive.
    //
    // Tests are out of scope deliberately: `networks.test.ts` asserts the table's exact URLs, which is
    // the *pin* on the single source rather than a copy of it, and a URL used as a fixture ships
    // nothing. The risk this guards is a production module resolving its own endpoint.
    const host = /(indexer|rpc)\.[a-z]+\.midnight\.network/
    const offenders = files
      .filter((f) => !ALLOWED_HOSTS.has(f.rel) && !/\.test\.tsx?$/.test(f.rel))
      .filter((f) => host.test(f.text))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('reads no endpoint URL out of an EXPO_PUBLIC_MIDNIGHT_* variable', () => {
    // ⚠️ The specific defect: a funds endpoint cannot come from a build-time constant, because the
    // funds network is chosen at runtime by the selector. Both variables were deleted; this stops a
    // well-meaning reintroduction.
    const offenders = files
      .filter((f) => /EXPO_PUBLIC_MIDNIGHT_(INDEXER|NODE)_URL/.test(f.text))
      .map((f) => f.rel)
      // networks.ts names them in its own history note, which is the one place that should.
      .filter((rel) => !ALLOWED_HOSTS.has(rel) && rel !== SELF)
    expect(offenders).toEqual([])
  })

  it('keeps one name per chain, so no two modules export the same resolver name', () => {
    // `midnightIndexerUrl` used to mean the identity chain in one module and the funds rail in
    // another, one of them re-exported through a barrel. Whichever a caller imported, it type-checked.
    const declaring = files
      .filter((f) => f.rel !== SELF && /export const midnightIndexerUrl\b/.test(f.text))
      .map((f) => f.rel)
      .sort()
    expect(declaring).toEqual(['src/services/midnight/contract-state.ts'])
  })
})
