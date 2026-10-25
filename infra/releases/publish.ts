#!/usr/bin/env bun

/**
 * Publish a pre-release build to R2, where the landing page can offer it.
 *
 * This is the *delivery* half only. It does not build anything: the build commands live with the
 * app (`app/scripts/build-preview.ts`), and keeping them apart means a failed upload never costs
 * a rebuild, and a rebuild is never triggered by a typo in a bucket name.
 *
 * ```sh
 * cd app && bun run preview:build:android        # → app/dist/pnyx-preview.apk
 * bun infra/releases/publish.ts android app/dist/pnyx-preview.apk
 * ```
 *
 * What it writes:
 *
 * - **R2** `pnyx-releases/builds/<name>` — the artifact, keyed by platform + version + short
 *   commit, so a key is never reused and the landing page can cache it for ever. It has to be R2:
 *   a Workers static asset is capped at 25 MiB and the APK is ~225 MB. It is served by the
 *   bucket's own custom domain, `downloads.pxkq.uk`, so no Worker runs for a download either.
 * - **The site** `services/landing/public/pnyx/releases.json` — the manifest the page reads,
 *   merged rather than replaced so publishing Android cannot erase a published iOS build. Then
 *   `wrangler deploy`, because that file is a *static asset*.
 *
 * ⚠️ **The manifest is an asset on purpose, not an R2 object.** Static assets are free, unlimited
 * and never invoke a Worker. Together with the custom domain above, that makes the whole site —
 * page, screenshots, manifest, downloads — cost **no Worker requests at all**; `pnyx-landing` has
 * no script left to run. Reading the manifest from R2 at request time would have put one back.
 *
 * ⚠️ **`--remote` is not optional** on the build upload. Without it `wrangler r2 object put`
 * writes the local miniflare store and reports success, so the upload looks done and the bucket
 * is untouched.
 *
 * @module
 */

import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {basename, join} from 'node:path'

const BUCKET = 'pnyx-releases'
const ROOT = new URL('../..', import.meta.url).pathname
const SITE = join(ROOT, 'services/landing')
/** Served at `/pnyx/releases.json` as a static asset — see the module note on why. */
const MANIFEST_PATH = join(SITE, 'public/pnyx/releases.json')
/**
 * The bucket's own public hostname — an R2 custom domain, so a download is served straight from
 * R2 with **no Worker in the path at all**. `builds/` is the key prefix, exposed as-is.
 */
const DOWNLOAD_BASE = 'https://downloads.pxkq.uk/builds'

/**
 * `ios-sim` is a Simulator `.app` zip, not a phone build. It is here because it is the **only**
 * iOS artifact that can be handed to someone outside our Apple team: it is unsigned, so it needs
 * no Developer Program membership. See this folder's README for why a free-signed device build is
 * not an option.
 */
const PLATFORMS = ['android', 'ios', 'ios-sim'] as const
type Platform = (typeof PLATFORMS)[number]

/** One published build. The page renders these fields directly, so changing one is a page change. */
type Release = {
  readonly platform: Platform
  /** The artifact's file name, which is also its key under `builds/`. */
  readonly file: string
  readonly url: string
  readonly version: string
  readonly commit: string
  readonly bytes: number
  readonly sha256: string
  /** ISO 8601, UTC. */
  readonly published: string
  /** Which `--env` the artifact was built with: what backend and chain it points at. */
  readonly buildEnv: string
}

type Manifest = {
  readonly updated: string
  readonly releases: Partial<Record<Platform, Release>>
}

const run = (cmd: string, args: readonly string[]): string =>
  execFileSync(cmd, args, {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']}).trim()

const wrangler = (args: readonly string[]): string => run('bunx', ['wrangler', ...args])

const fail = (message: string): never => {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

/**
 * The content type matters: Android refuses to treat an `application/octet-stream` body as an
 * installable package in some browsers, and the Worker passes R2's stored type straight through.
 */
const contentTypeFor = (file: string): string => {
  if (file.endsWith('.apk')) return 'application/vnd.android.package-archive'
  if (file.endsWith('.ipa')) return 'application/octet-stream'
  if (file.endsWith('.zip')) return 'application/zip'
  return fail(`Unsupported artifact extension: ${file}. Expected .apk, .ipa or .zip.`)
}

/** The extension each platform's artifact is expected to arrive with. */
const EXTENSIONS: Record<Platform, string> = {android: 'apk', ios: 'ipa', 'ios-sim': 'zip'}

const readManifest = (): Manifest => {
  if (!existsSync(MANIFEST_PATH)) {
    // The normal state of the first publish. Starting empty is right: the merge only ever adds.
    console.warn('  no existing manifest; starting a new one')
    return {updated: '', releases: {}}
  }

  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  } catch (error) {
    return fail(`${MANIFEST_PATH} is not valid JSON (${String(error)}). Fix it before publishing.`)
  }
}

const main = (): void => {
  const [platformArg, artifact, ...rest] = process.argv.slice(2)
  const buildEnv = rest.find((a) => a.startsWith('--env='))?.slice(6) ?? 'preview'

  if (!platformArg || !artifact || !(PLATFORMS as readonly string[]).includes(platformArg)) {
    console.error('Usage: bun infra/releases/publish.ts <android|ios|ios-sim> <artifact> [--env=preview]')
    process.exit(1)
  }
  const platform = platformArg as Platform

  const stat = (() => {
    try {
      return statSync(artifact)
    } catch (error) {
      return fail(`Cannot read ${artifact} (${String(error)}). Build it first — see this folder's README.`)
    }
  })()

  const version = (JSON.parse(readFileSync(join(ROOT, 'app/package.json'), 'utf8')) as {version: string}).version
  const commit = run('git', ['rev-parse', '--short', 'HEAD'])
  const dirty = run('git', ['status', '--porcelain']) !== ''
  if (dirty) console.warn('⚠ The working tree is dirty, so this artifact is not reproducible from `commit` alone.')

  const ext = EXTENSIONS[platform]
  if (!artifact.endsWith(`.${ext}`)) {
    fail(`A ${platform} artifact should be a .${ext}, but got ${basename(artifact)}.`)
  }
  const file = `pnyx-${version}-${commit}-${platform}.${ext}`
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex')

  console.log(`\nPublishing ${basename(artifact)}`)
  console.log(`  platform  ${platform} (${buildEnv})`)
  console.log(`  version   ${version} @ ${commit}`)
  console.log(`  size      ${(stat.size / 1024 / 1024).toFixed(1)} MiB`)
  console.log(`  sha256    ${sha256}`)

  console.log('\nUploading the build...')
  wrangler([
    'r2',
    'object',
    'put',
    `${BUCKET}/builds/${file}`,
    '--remote',
    '--file',
    artifact,
    '--content-type',
    contentTypeFor(file),
    // The Worker used to add this; R2 has to carry it now, or a browser may render the file
    // instead of saving it.
    '--content-disposition',
    `attachment; filename="${file}"`,
  ])

  console.log('Merging the manifest...')
  const previous = readManifest()
  const release: Release = {
    platform,
    file,
    url: `${DOWNLOAD_BASE}/${file}`,
    version,
    commit,
    bytes: stat.size,
    sha256,
    published: new Date().toISOString(),
    buildEnv,
  }
  const manifest: Manifest = {
    updated: release.published,
    releases: {...previous.releases, [platform]: release},
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

  // The manifest is a static asset, so the site has to be redeployed for the page to see it.
  // Deploying is cheap and uploads only what changed — the screenshots are already there.
  console.log('Deploying the site...')
  execFileSync('bunx', ['wrangler', 'deploy'], {cwd: SITE, stdio: 'inherit'})

  console.log(`\n✓ Published. ${release.url}`)
  console.log(`  Commit ${MANIFEST_PATH.replace(`${ROOT}/`, '')} so the repo records what is live.\n`)
}

main()
