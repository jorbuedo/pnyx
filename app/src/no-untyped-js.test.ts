/**
 * Drift guard: the source tree is TypeScript. No `.mjs`, no `.cjs`, and `.js` only where a tool
 * loads the file itself.
 *
 * This exists because of what untyped JavaScript cost in the codec seam. `evolution-codec.mjs` and
 * `evolution-decode.mjs` were ~1,380 lines of byte-level signing code written as plain JavaScript
 * so a retired differential harness could `import` them under `node` without a build step. Their
 * boundary was described by hand-written `.d.mts` files, which TypeScript TRUSTS without checking
 * the body against them — so when an upstream merge replaced `InlineDatum.raw` with the
 * `OriginalBytes` side channel, the adapter kept passing `raw:`, the property was silently ignored,
 * and the declaration kept reporting the right shape. Converting the two files to TypeScript
 * surfaced that plus unchecked parallel-array indexing, `undefined` reaching encoders, and an
 * auxiliary_data built with no metadata.
 *
 * A hand-written declaration beside untyped code is strictly worse than no declaration: it reads as
 * a checked boundary and is an unchecked assertion.
 *
 * @module
 */

import {readdirSync, statSync} from 'node:fs'
import {join, relative, sep} from 'node:path'
import {describe, expect, it} from 'vitest'

const ROOT = join(__dirname, '..', '..')

/** Trees whose modules are compiled and type-checked. */
const TYPED_ROOTS = ['packages', 'services', 'harness', join('app', 'src'), join('app', 'app')]

// `.wrangler` is wrangler's local state: it writes generated `.js` bundles under `tmp/` on
// every `dev`/`deploy`. Generated, gitignored, and never source — the same class as `dist`.
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.wrangler'])

/**
 * Metro resolver targets, not modules the app imports.
 *
 * `metro.config.js` maps Node core module ids (`net`, `tls`, `zlib`, …) and a few unbundleable
 * vendor paths onto these by absolute path, and they answer with CommonJS `module.exports`. They
 * are substitutions made by the bundler rather than code the program calls, which is why they are
 * the one place a `.js` still earns its extension here.
 *
 * ⚠️ This list may shrink, never grow. A new entry means a new untyped module in the source tree,
 * which is the thing this file exists to prevent.
 */
const RESOLVER_SHIMS = [
  'app/src/platform/empty-module.js',
  'app/src/platform/sentry-lazy-load-stub.js',
  'app/src/platform/sentry-show-report-dialog-stub.js',
  'app/src/platform/trezor-native-adapter-stub.js',
  'app/src/platform/ws-shim.js',
  'app/src/platform/zlib-shim.js',
]

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const sourceFiles = (): string[] =>
  TYPED_ROOTS.flatMap((root) => {
    const dir = join(ROOT, root)
    try {
      return walk(dir)
    } catch {
      // A root that does not exist is a stale entry in this list, not an empty tree: say which.
      throw new Error(`no-untyped-js: typed root ${root} does not exist`)
    }
  }).map((f) => relative(ROOT, f).split(sep).join('/'))

describe('the source tree is TypeScript', () => {
  it('scans a tree it actually found', () => {
    // ⚠️ A scan that found nothing would pass vacuously. Pinned before it is used.
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(2000)
    // A file with an independent reason to exist and to stay TypeScript: `env.ts` is the only
    // module allowed to read `process.env.EXPO_PUBLIC_*`, which `no-raw-env.test.ts` enforces.
    // (It used to pin the codec adapter, which moved to `@evolution-sdk/wallet-codec` — a tree
    // this guard does not scan, so the pin would have gone quietly vacuous.)
    expect(files).toContain('app/src/config/env.ts')
  })

  it('has no .mjs or .cjs anywhere', () => {
    const found = sourceFiles().filter((f) => /\.(mjs|cjs)$/.test(f))
    expect(
      found,
      'ESM/CJS source modules are banned outright. Write TypeScript: bun and vitest run it directly, ' +
        'and Metro transpiles it. There is no tool here that needs the extension.',
    ).toEqual([])
  })

  it('has no hand-written .d.mts or .d.cts declarations', () => {
    // These are the specific hazard: a declaration TypeScript trusts, beside a body nothing checks.
    const found = sourceFiles().filter((f) => /\.d\.(mts|cts)$/.test(f))
    expect(found, 'a hand-written declaration beside untyped code asserts a boundary instead of checking it').toEqual(
      [],
    )
  })

  it('has no .js or .jsx outside the named resolver shims', () => {
    const allowed = new Set(RESOLVER_SHIMS)
    const found = sourceFiles().filter((f) => /\.(js|jsx)$/.test(f) && !allowed.has(f))
    expect(
      found,
      'a new untyped module in the typed source tree. Write it in TypeScript, or if a tool must load ' +
        'the file itself, keep it outside these roots next to the other tool config.',
    ).toEqual([])
  })

  it('still needs every resolver shim it exempts', () => {
    // An exemption for a file that no longer exists is an exemption that stops being examined.
    const present = new Set(sourceFiles())
    const stale = RESOLVER_SHIMS.filter((f) => !present.has(f))
    expect(stale, 'remove these from RESOLVER_SHIMS: the list may shrink, never grow').toEqual([])
  })
})
