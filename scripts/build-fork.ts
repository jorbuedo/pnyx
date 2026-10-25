/**
 * Builds the `evolution-sdk` fork that Pnyx resolves `@evolution-sdk/*` from, and refuses the Pnyx
 * build when it cannot. Runs as the first step of `bun run build`.
 *
 * ⚠️ **Three things about the fork's build break Pnyx's, and all three are automated here.**
 *
 * 1. **`pnpm build` in the fork exits 1 on a healthy tree.** Its root build is `turbo build` over a
 *    workspace that includes `docs` and `examples/*`; `docs#build` fails on a clean clone (30
 *    fumadocs/acorn MDX parse errors) and fails *again* after the `effect` repoint below (Turbopack
 *    will not follow a symlink out of the fork's tree). Neither failure touches anything Pnyx
 *    consumes, but `&&` does not know that. This builds `--filter './packages/*'` instead: 14 tasks,
 *    no docs, no examples.
 * 2. **Unbuilt dists do not fail as "unbuilt".** Pnyx's tsconfig paths point at the fork's
 *    `dist/*.d.ts`; with no dist, resolution falls through to the fork's SOURCE and our stricter
 *    config reports thousands of errors inside somebody else's package (measured: 2,124).
 * 3. **Two copies of `effect` do not type-check against each other**, and a Pnyx `bun install` that
 *    changes the workspace set materialises bun's layout over pnpm's symlinks, undoing the repoint.
 *    So the repoint is re-applied here on every run rather than documented as a one-off.
 *
 * The package list is derived from `tsconfig.base.json`, not written here: those paths are what
 * production actually resolves, so a package added there is covered without touching this file.
 *
 * @module
 */

import {execFileSync} from 'node:child_process'
import {existsSync, lstatSync, readFileSync, readlinkSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const FORK_DIR = 'evolution-sdk'
const checkOnly = process.argv.includes('--check-only')
const force = process.argv.includes('--force')

/** Where the fork may live: a sibling checkout in this repo, a `vendor/` submodule in the snapshot. */
const FORK_ROOTS: readonly {readonly label: string; readonly path: string}[] = [
  {label: 'sibling checkout', path: resolve(REPO_ROOT, '..', FORK_DIR)},
  {label: 'vendor/ submodule', path: join(REPO_ROOT, 'vendor', FORK_DIR)},
]

const fail: (lines: readonly string[]) => never = (lines) => {
  console.error(`\n${lines.join('\n')}\n`)
  process.exit(2)
}

/** Strips `//` and block comments so `tsconfig.base.json` can be read as JSON. */
function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return JSON.parse(out)
}

/** `@evolution-sdk/<name>` → the declaration file Pnyx resolves it to, from `tsconfig.base.json`. */
function consumedDeclarations(): ReadonlyMap<string, string> {
  const config = parseJsonc(readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8'))
  const paths = (config as {compilerOptions?: {paths?: Record<string, string[]>}}).compilerOptions?.paths
  if (paths === undefined)
    fail(['tsconfig.base.json has no compilerOptions.paths, so the fork packages cannot be derived.'])
  const found = new Map<string, string>()
  for (const [specifier, targets] of Object.entries(paths)) {
    // The `/*` subpath entries point at a wildcard, not a file; the bare specifier is the sentinel.
    if (!specifier.startsWith('@evolution-sdk/') || specifier.endsWith('/*')) continue
    const target = targets[0]
    if (target !== undefined) found.set(specifier, resolve(REPO_ROOT, target))
  }
  if (found.size === 0) fail(['No `@evolution-sdk/*` path mappings in tsconfig.base.json.'])
  return found
}

/** Every `effect` under the fork, as the documented one-liner finds them. */
function effectCopies(forkPath: string): readonly string[] {
  const out = execFileSync('find', [forkPath, '-path', '*/node_modules/effect'], {encoding: 'utf8'})
  return out.split('\n').filter((line) => line.length > 0)
}

type Problem = {readonly what: string; readonly detail: string}

function verify(forkPath: string): readonly Problem[] {
  const problems: Problem[] = []

  for (const [specifier, declaration] of consumedDeclarations()) {
    if (!existsSync(declaration)) {
      problems.push({what: `${specifier} has no built declaration`, detail: relative(REPO_ROOT, declaration)})
    }
  }

  const ours = join(REPO_ROOT, 'node_modules', 'effect')
  for (const copy of effectCopies(forkPath)) {
    const stat = lstatSync(copy)
    if (!stat.isSymbolicLink()) {
      problems.push({what: 'a second `effect` the fork resolves instead of ours', detail: relative(REPO_ROOT, copy)})
      continue
    }
    const target = resolve(dirname(copy), readlinkSync(copy))
    if (target !== ours) {
      problems.push({
        what: '`effect` symlinked somewhere other than ours',
        detail: `${relative(REPO_ROOT, copy)} -> ${target}`,
      })
    } else if (!existsSync(copy)) {
      problems.push({
        what: 'a dangling `effect` symlink',
        detail: `${relative(REPO_ROOT, copy)} (run \`bun install\` first)`,
      })
    }
  }
  return problems
}

const run = (command: string, args: readonly string[], cwd: string): void => {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, [...args], {cwd, stdio: 'inherit'})
}

const found = FORK_ROOTS.find((root) => existsSync(join(root.path, 'package.json')))
if (found === undefined) {
  fail([
    `No \`${FORK_DIR}\` checkout found. Pnyx cannot build without it.`,
    '',
    '  In a clone of the public snapshot:  git submodule update --init',
    `  In the private repo: clone the fork beside this one, as a sibling named ${FORK_DIR}`,
  ])
}

const problems = verify(found.path)
if (problems.length === 0 && !force) {
  console.log(`evolution-sdk (${found.label}) is built, and one \`effect\` is resolved across it.`)
  process.exit(0)
}

if (checkOnly) {
  fail([
    `The evolution-sdk fork (${found.label}) is not ready, so this build would fail:`,
    '',
    ...problems.map((p) => `  - ${p.what}: ${p.detail}`),
    '',
    '  Fix it with:  bun scripts/build-fork.ts',
  ])
}

if (!existsSync(join(REPO_ROOT, 'node_modules', 'effect'))) {
  fail(['Pnyx has no `node_modules/effect` to repoint the fork at. Run `bun install` first.'])
}

if (!existsSync(join(found.path, 'node_modules'))) {
  run('pnpm', ['install'], found.path)
}

// ⚠️ `--filter './packages/*'` is the point of this script: the fork's own `turbo build` also builds
// `docs`, which fails for two unrelated reasons and neither of them is ours.
run('pnpm', ['exec', 'turbo', 'build', '--filter', './packages/*'], found.path)

// Re-applied every run: a Pnyx `bun install` that changes the workspace set replaces these symlinks
// with real directories, and pnpm's own install resets them too.
const ours = join(REPO_ROOT, 'node_modules', 'effect')
const replaced = effectCopies(found.path).filter((copy) => {
  const stat = lstatSync(copy)
  return !stat.isSymbolicLink() || resolve(dirname(copy), readlinkSync(copy)) !== ours
})
for (const copy of replaced) {
  execFileSync('rm', ['-rf', copy])
  execFileSync('ln', ['-s', ours, copy])
}
console.log(
  `\nrepointed ${replaced.length} \`effect\` cop${replaced.length === 1 ? 'y' : 'ies'} at ${relative(REPO_ROOT, ours)}`,
)

const remaining = verify(found.path)
if (remaining.length > 0) {
  fail(['The fork still is not ready after building it:', '', ...remaining.map((p) => `  - ${p.what}: ${p.detail}`)])
}
console.log(`\nevolution-sdk (${found.label}) is built, and one \`effect\` is resolved across it.`)
