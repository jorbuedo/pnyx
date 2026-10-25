#!/usr/bin/env bun
import {spawnSync} from 'node:child_process'
/**
 * Project cleanup script.
 *
 * Usage:
 *   bun run clean          — remove build artifacts (dist, build, *.tsbuildinfo, .expo)
 *   bun run clean:all      — above + node_modules (nuclear reset)
 *
 * How it works:
 *   1. Runs each workspace's own "clean" script (if defined) via `bun run`
 *   2. Walks workspace directories and removes remaining build artifacts
 *   3. In nuclear mode, also removes node_modules and bun.lock
 *
 * All directory walks skip node_modules to stay fast. Uses Node.js fs APIs
 * instead of `find` for portability and reliability.
 */
import {type Dirent, existsSync, readdirSync, readFileSync, rmSync} from 'node:fs'
import {join, resolve} from 'node:path'

const root = process.cwd()
const nuclear = process.argv.includes('--nuclear')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Names to skip when walking directories. */
const SKIP = new Set(['node_modules', '.git', '.expo'])

/** Build artifact directory names to delete. */
const ARTIFACT_DIRS = new Set(['dist', 'build', 'extension-dist'])

/** File patterns to delete. */
const isArtifactFile = (name: string) => name.endsWith('.tsbuildinfo')

/**
 * Walk a directory tree up to `maxDepth`, calling `onDir` for each
 * directory and `onFile` for each file. Skips directories in SKIP set.
 */
function walk(
  dir: string,
  maxDepth: number,
  onDir: (path: string, name: string) => boolean, // return true to prune
  onFile: (path: string, name: string) => void,
  depth = 0,
): void {
  if (depth > maxDepth) return
  // ⚠️ Not `ReturnType<typeof readdirSync>`: that resolves the unparameterised overload, while
  // `withFileTypes` returns `Dirent[]`. Invisible until `scripts/` gained a tsconfig (2026-10-19).
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, {withFileTypes: true})
  } catch {
    return // directory may have been deleted by a workspace clean script
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      const pruned = onDir(fullPath, entry.name)
      if (!pruned) {
        walk(fullPath, maxDepth, onDir, onFile, depth + 1)
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      onFile(fullPath, entry.name)
    }
  }
}

/** Silently remove a path. */
function rm(p: string, what: string): void {
  try {
    rmSync(p, {recursive: true, force: true})
    console.log(`  rm ${what}`)
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// 1. Run each workspace's own "clean" script
// ---------------------------------------------------------------------------
console.log('Running workspace clean scripts...\n')
const wsResult = spawnSync('bun', ['run', '--filter', '*', '--if-present', 'clean'], {cwd: root, stdio: 'inherit'})
// Fallback: try the older --workspaces flag if --filter didn't work
if (wsResult.status !== 0) {
  spawnSync('bun', ['--filter', '*', 'clean'], {cwd: root, stdio: 'inherit'})
}

// ---------------------------------------------------------------------------
// 2. Resolve workspace directories
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  workspaces?: string[]
}

// Get unique top-level dirs from workspace globs (e.g. "packages", "apps")
const workspaceDirs = [...new Set((pkg.workspaces ?? []).map((w: string) => w.split('/')[0] ?? w))].filter((d) =>
  existsSync(join(root, d)),
)

// ---------------------------------------------------------------------------
// 3. Remove build artifacts
// ---------------------------------------------------------------------------
console.log('\nRemoving build artifacts...\n')

// Root-level artifacts
for (const name of ARTIFACT_DIRS) {
  const p = join(root, name)
  if (existsSync(p)) rm(p, name)
}
// Root-level tsbuildinfo
try {
  for (const entry of readdirSync(root)) {
    if (isArtifactFile(entry)) rm(join(root, entry), entry)
  }
} catch {
  /* ignore */
}

// Walk workspace directories
for (const dir of workspaceDirs) {
  const absDir = resolve(root, dir)
  walk(
    absDir,
    6, // max depth — deep enough to reach nested workspace-package build artifacts
    (path, name) => {
      if (ARTIFACT_DIRS.has(name)) {
        rm(path, path.replace(`${root}/`, ''))
        return true // prune — don't descend into deleted dir
      }
      return false
    },
    (path, name) => {
      if (isArtifactFile(name)) {
        rm(path, path.replace(`${root}/`, ''))
      }
    },
  )
}

// Remove tsbuildinfo files stored inside node_modules/.tmp/ (not reached by walk
// because node_modules is in the SKIP set). Many packages set
// "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.tsbuildinfo" so these must be
// cleaned to avoid stale incremental state that prevents emission after clean.
for (const dir of workspaceDirs) {
  const absDir = resolve(root, dir)
  walk(
    absDir,
    6,
    (_path, _name) => false,
    (path, name) => {
      // Detect package.json to find workspace roots, then clean their node_modules/.tmp
      if (name === 'package.json') {
        const pkgDir = join(path, '..')
        const tmpDir = join(pkgDir, 'node_modules', '.tmp')
        if (existsSync(tmpDir)) {
          rm(tmpDir, tmpDir.replace(`${root}/`, ''))
        }
      }
    },
  )
}
// Also clean root node_modules/.tmp
const rootTmp = join(root, 'node_modules', '.tmp')
if (existsSync(rootTmp)) {
  rm(rootTmp, 'node_modules/.tmp')
}

// ---------------------------------------------------------------------------
// 4. Remove .expo caches
// ---------------------------------------------------------------------------
const expoDir = join(root, 'app', '.expo')
if (existsSync(expoDir)) rm(expoDir, 'app/.expo')

// ---------------------------------------------------------------------------
// 5. Nuclear clean — also remove node_modules and lockfile
// ---------------------------------------------------------------------------
if (nuclear) {
  console.log('\n🧹 Nuclear clean: removing node_modules...\n')

  // Remove all node_modules directories (walk manually, prune after delete)
  const removeNodeModules = (dir: string, maxDepth: number, depth = 0): void => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, {withFileTypes: true})
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git') continue
      const fullPath = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        rm(fullPath, fullPath.replace(`${root}/`, ''))
        // Don't descend — it's deleted
      } else {
        removeNodeModules(fullPath, maxDepth, depth + 1)
      }
    }
  }

  removeNodeModules(root, 5)
}

console.log('\n✅ Clean complete.\n')
