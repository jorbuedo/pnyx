// The exact set of files the sponsor host needs, and nothing more.
//
// The box never runs `bun install` (`docs/SPONSOR_HOST.md`), so the tree is pushed from a machine that
// has a known-good `node_modules`. Pushing the whole thing means 22 GB, almost all of it the React
// Native tree for an app that never runs here. So walk the real import graph from the sponsor entry
// point instead and push its closure — currently ~330 MB.
//
// Subsetting a working install is deliberate: it preserves bun's hoisting exactly as laid down. A fresh
// partial install does not, which is how the containerisation attempt died
// (`export 'Clock' not found in @midnight-ntwrk/wallet-sdk-utilities`).
//
// The closure errs towards including too much — package-level `dependencies` are followed whether or
// not a given module is reached. The one deliberate exclusion is type-only imports, which is what keeps
// the 41 MB `contract/managed` build output off a host that must not care which contract is deployed.
//
// Verification is empirical, not by inspection: `push.sh` boots the entry point on the box afterwards,
// which resolves the whole static graph. A missing package surfaces as `Cannot find module`.
import fs from 'node:fs'
import path from 'node:path'
import {runtimeSpecifiers} from './specifiers.js'

/**
 * ⚠️ **Both entry points.** The router imports no wallet, no ledger and no prover; the wallet imports all
 * three. Walking only one of them would ship a tree that loads the process you tested and fails on the
 * other at the next restart.
 */
const ENTRIES = ['services/content/src/sponsor-server.ts', 'services/content/src/sponsor-router.ts']

export type Closure = {
  /** Repo-relative source files reachable from the entry point. */
  readonly sources: readonly string[]
  /** Repo-relative workspace package directories (`packages/chain-client`, …). */
  readonly workspaces: readonly string[]
  /** Package names under `node_modules`, transitively closed over their manifests. */
  readonly packages: readonly string[]
}

const exists = (p: string) => fs.existsSync(p)
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))

/**
 * Resolve `@pnyx/x/sub` through the package's `exports` map.
 *
 * Workspace packages export TypeScript source directly, so there is no build step to run before a push
 * and no `dist/` to go stale.
 */
const resolveWorkspace = (root: string, spec: string, workspaces: Set<string>): string | null => {
  const [scope, name, ...rest] = spec.split('/')
  const link = path.join(root, 'node_modules', `${scope}/${name}`)
  if (!exists(link)) return null
  const real = fs.realpathSync(link)
  workspaces.add(path.relative(root, real))
  const pkg = readJson(path.join(real, 'package.json'))
  const sub = rest.length > 0 ? `./${rest.join('/')}` : '.'
  const entry = pkg.exports?.[sub]
  const target = typeof entry === 'string' ? entry : (entry?.import ?? entry?.default ?? pkg.main)
  return target === undefined ? null : path.join(real, target)
}

/** Resolve a relative specifier, accounting for the `.js`-extension-in-TypeScript convention. */
const resolveRelative = (from: string, spec: string): string | null => {
  const base = path.resolve(path.dirname(from), spec)
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, path.join(base, 'index.ts')]
  return candidates.find(exists) ?? null
}

const packageNameOf = (spec: string): string => {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts.slice(0, 1).join('/')
}

/** Package directories inside a `node_modules`, flattening one level of `@scope`. */
const packageDirs = (nodeModules: string): string[] => {
  const out: string[] = []
  for (const entry of fs.readdirSync(nodeModules, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      if (entry.isDirectory()) out.push(...fs.readdirSync(full).map((scoped) => path.join(full, scoped)))
      continue
    }
    out.push(full)
  }
  return out
}

/**
 * Manifests of the nested `node_modules` copies inside a package, at any depth.
 *
 * bun hoists what it can and nests only on version conflict, so a nested copy's own dependencies are
 * usually satisfied from the root — meaning they are needed on the box but named by no top-level
 * manifest. Skipping this level ships a tree that resolves locally and fails at boot
 * (`inherits`, via `docker-modem`'s nested `readable-stream`).
 */
const nestedManifests = (dir: string): string[] => {
  const found: string[] = []
  const visit = (pkgDir: string) => {
    const nested = path.join(pkgDir, 'node_modules')
    if (!exists(nested)) return
    for (const child of packageDirs(nested)) {
      const manifest = path.join(child, 'package.json')
      if (exists(manifest)) found.push(manifest)
      visit(child)
    }
  }
  visit(dir)
  return found
}

export const sponsorClosure = (root: string): Closure => {
  const sources = new Set<string>()
  const workspaces = new Set<string>()
  const externals = new Set<string>()
  const unresolved: string[] = []

  const walk = (file: string) => {
    const rel = path.relative(root, file)
    if (sources.has(rel)) return
    sources.add(rel)
    for (const spec of runtimeSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue
      if (spec.startsWith('.')) {
        const next = resolveRelative(file, spec)
        if (next === null) unresolved.push(`${spec} (from ${rel})`)
        else walk(next)
        continue
      }
      if (spec.startsWith('@pnyx/')) {
        const next = resolveWorkspace(root, spec, workspaces)
        if (next === null) unresolved.push(`${spec} (from ${rel})`)
        else walk(next)
        continue
      }
      externals.add(packageNameOf(spec))
    }
  }

  for (const entry of ENTRIES) walk(path.join(root, entry))

  if (unresolved.length > 0) {
    throw new Error(`unresolved imports — the closure would be incomplete:\n  ${unresolved.join('\n  ')}`)
  }

  // Close over declared manifests rather than over reached modules: a package that resolves only by
  // hoisting luck is a real hazard here (`@pnyx/chain-client` had exactly that bug), and a manifest
  // walk is the cheap way to stay ahead of it.
  const packages = new Set<string>()
  const queue = [...externals]
  const missing: string[] = []
  while (queue.length > 0) {
    const name = queue.pop() as string
    if (packages.has(name)) continue
    const dir = path.join(root, 'node_modules', name)
    if (!exists(dir)) {
      missing.push(name)
      continue
    }
    packages.add(name)
    const manifest = path.join(dir, 'package.json')
    if (!exists(manifest)) continue
    for (const file of [manifest, ...nestedManifests(dir)]) {
      const pkg = readJson(file)
      const deps = {...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies}
      for (const dep of Object.keys(deps)) {
        // Workspace deps are reached through the source walk; a nested copy travels with the parent
        // directory, but whatever *it* needs may only exist at the root.
        if (dep.startsWith('@pnyx/')) continue
        if (exists(path.join(root, 'node_modules', dep))) queue.push(dep)
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`not installed — run \`bun install\` first:\n  ${missing.join('\n  ')}`)
  }

  return {
    sources: [...sources].sort(),
    workspaces: [...workspaces].sort(),
    packages: [...packages].sort(),
  }
}

/**
 * The closure as an rsync `--files-from` manifest.
 *
 * Workspace packages are reached through `node_modules/@pnyx/*`, which bun installs as symlinks into
 * `packages/`. Both ends are listed: rsync preserves the link, and the target has to exist for it to
 * resolve on the box.
 */
export const filesFrom = (closure: Closure): string => {
  const lines = [
    'package.json',
    ...closure.sources,
    ...closure.workspaces.flatMap((dir) => [`${dir}/package.json`, `node_modules/@pnyx/${path.basename(dir)}`]),
    ...closure.packages.map((name) => `node_modules/${name}`),
  ]
  return `${lines.join('\n')}\n`
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd()
  const closure = sponsorClosure(root)
  console.error(
    `[closure] ${closure.sources.length} sources, ${closure.workspaces.length} workspace packages, ${closure.packages.length} node_modules packages`,
  )
  process.stdout.write(filesFrom(closure))
}
