#!/usr/bin/env bun
/**
 * Fetches a first-party icon for every `dapps.recommended` entry and rewrites
 * each entry's `logo` to point at our config bucket.
 *
 * Curation-time job, not a build step and not anything a device runs: each icon
 * is pulled once from the dApp's own origin, rasterized, and republished from
 * `config.pxkq.uk`, so no client ever calls out to decorate a tile. See the
 * module doc of `dapp-icons.ts` for why that matters.
 *
 * Usage — dev first, then preview; prod is the last step, not the first:
 *   bunx wrangler r2 object get pnyx-config/dev.json --remote --pipe > /tmp/dev.json
 *   bun scripts/build-dapp-icons.ts --config /tmp/dev.json
 *   # …review the report and build/dapp-icons/, then run the publish script it wrote
 *
 *   --check     resolve and report, write nothing
 *   --all       re-fetch every entry, including hand-set first-party logos
 *   --out DIR   where the PNGs land (default: build/dapp-icons)
 *   --base URL  public base of the config bucket (default: the config URL below)
 *
 * The job never invents an icon. An entry it cannot resolve keeps whatever
 * `logo` it had — usually none — and is listed as unresolved for a human to
 * source artwork for or drop from the list. A tile with the wrong picture is a
 * worse outcome than a tile with no picture.
 */
import {createHash} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, join, resolve} from 'node:path'
import sharp from 'sharp'
import {
  type ArtworkCandidate,
  collidingEntries,
  duplicateIds,
  entriesNeedingIcons,
  iconObjectKey,
  iconPublicUrl,
  iconsFromManifest,
  isRasterizable,
  manifestUrl,
  pngFromIco,
  type RecommendedEntry,
  resolveHref,
  selectArtwork,
} from './dapp-icons'

const WALLET_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_BASE = 'https://config.pxkq.uk'
const BUCKET = 'pnyx-config'
const ENVS = ['dev', 'preview', 'prod']
/** 128pt tile at 3× — the largest the grid renders, so one asset serves every density. */
const ICON_PX = 384
const FETCH_TIMEOUT_MS = 45_000
const CONCURRENCY = 6

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}
const check = process.argv.includes('--check')
const all = process.argv.includes('--all')
const configPath = arg('config')
const envArg = arg('env')
const outDir = resolve(WALLET_ROOT, arg('out') ?? 'build/dapp-icons')
const baseUrl = arg('base') ?? DEFAULT_BASE

if (!configPath) {
  console.error('✗ --config <file> is required: the remote-config JSON to read and rewrite.')
  console.error('  bunx wrangler r2 object get pnyx-config/prod.json --remote --pipe > /tmp/prod.json')
  process.exit(1)
}
if (!existsSync(configPath)) {
  console.error(`✗ no such config file: ${configPath}`)
  process.exit(1)
}

/**
 * Which `<env>.json` this run may publish to, derived from the source filename
 * rather than chosen at publish time. The rewritten config carries whatever
 * `features`, `banners` and `maintenance` the source had, so a file fetched from
 * `dev` and published to `prod` would push dev's flags to production in one
 * command, with nothing in the way.
 */
const env = envArg ?? ENVS.find((e) => basename(configPath).startsWith(e))
if (!env) {
  console.error(`✗ cannot tell which environment ${basename(configPath)} came from.`)
  console.error(`  Name it <env>.json (${ENVS.join(' | ')}), or pass --env explicitly.`)
  process.exit(1)
}

type Outcome =
  | {readonly id: string; readonly ok: true; readonly kind: string; readonly from: string; readonly bytes: number}
  | {readonly id: string; readonly ok: false; readonly reason: string}

class FetchTimeout extends Error {
  constructor(url: string) {
    super(`timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`)
  }
}

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some hosts serve a bare 403 to a default agent, which would read as
        // "this dApp has no icon" rather than "we were turned away".
        'User-Agent': 'Mozilla/5.0 (compatible; PnyxIconBot/1.0; curation-time icon fetch)',
        Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
      },
    })
  } catch (e) {
    // An AbortError here is our own timer, not the host saying anything — report
    // the wait, so a slow site is never filed next to a real refusal.
    if (e instanceof Error && e.name === 'AbortError') throw new FetchTimeout(url)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Every candidate for a dApp, best-first: page markup, then manifest, then `/favicon.ico`. */
const candidatesFor = async (uri: string): Promise<{candidates: ArtworkCandidate[]; note: string | null}> => {
  const page = await fetchWithTimeout(uri)
  if (!page.ok) return {candidates: [], note: `page returned HTTP ${page.status}`}
  const finalUrl = page.url || uri
  const html = await page.text()

  const candidates = [...selectArtwork(html, finalUrl)]

  const manifestHref = manifestUrl(html, finalUrl)
  if (manifestHref) {
    try {
      const res = await fetchWithTimeout(manifestHref)
      if (res.ok) candidates.push(...iconsFromManifest(await res.json(), res.url || manifestHref))
      else console.warn(`  · manifest ${manifestHref} returned HTTP ${res.status}`)
    } catch (e) {
      console.warn(`  · manifest ${manifestHref} could not be read`, {error: String(e)})
    }
  }

  const ico = resolveHref('/favicon.ico', finalUrl)
  if (ico) candidates.push({url: ico, kind: 'favicon.ico', size: null})

  // Manifest icons are appended after page markup, so re-sort to restore the
  // documented preference order across all three sources.
  const RANK = ['apple-touch-icon', 'manifest', 'link-icon', 'favicon.ico', 'og:image']
  candidates.sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind) || (b.size ?? 0) - (a.size ?? 0))
  return {candidates, note: null}
}

/** PNG bytes for the first candidate that actually decodes, or `null`. */
const rasterize = async (
  candidates: readonly ArtworkCandidate[],
): Promise<{png: Buffer; kind: string; from: string} | null> => {
  for (const candidate of candidates) {
    try {
      const res = await fetchWithTimeout(candidate.url)
      if (!res.ok) {
        console.warn(`  · ${candidate.kind} ${candidate.url} returned HTTP ${res.status}`)
        continue
      }
      let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(await res.arrayBuffer())
      if (bytes.length === 0) {
        console.warn(`  · ${candidate.kind} ${candidate.url} was empty`)
        continue
      }
      if (!isRasterizable(candidate.url)) {
        const unwrapped = pngFromIco(bytes)
        if (!unwrapped) {
          console.warn(`  · ${candidate.kind} ${candidate.url} is not a format sharp reads (BMP-only ICO?)`)
          continue
        }
        bytes = unwrapped
      }
      const png = await sharp(bytes, {animated: false})
        .resize(ICON_PX, ICON_PX, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 0}})
        .png()
        .toBuffer()
      return {png, kind: candidate.kind, from: candidate.url}
    } catch (e) {
      console.warn(`  · ${candidate.kind} ${candidate.url} failed to decode`, {error: String(e)})
    }
  }
  return null
}

const sourceBytes = await readFile(configPath)
const config = JSON.parse(sourceBytes.toString('utf8')) as {
  dapps?: {recommended?: RecommendedEntry[]}
}

/**
 * Digest of the object **currently on the bucket**, so the publish script can
 * refuse if someone else writes before it runs.
 *
 * Read from the bucket rather than hashing `configPath`: the config passed in is
 * routinely an edited copy — that is the whole point of the Case A/C workflow —
 * so hashing it would compare the bucket against bytes it never held and refuse
 * every legitimate publish. Returns `null` when wrangler cannot read the object
 * (not authenticated, object absent, offline); the guard is then omitted and the
 * script says so rather than pretending to protect something.
 */
const remoteDigest = async (): Promise<string | null> => {
  try {
    const proc = Bun.spawn(['bunx', 'wrangler', 'r2', 'object', 'get', `${BUCKET}/${env}.json`, '--remote', '--pipe'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
    const bytes = new Uint8Array(buf)
    if (code !== 0 || bytes.length === 0) {
      console.warn(`  · could not read ${env}.json from the bucket (wrangler exit ${code})`)
      return null
    }
    return createHash('sha256').update(bytes).digest('hex')
  } catch (e) {
    console.warn('  · could not read the current bucket object', {error: String(e)})
    return null
  }
}
const recommended = config.dapps?.recommended
if (!Array.isArray(recommended) || recommended.length === 0) {
  console.error('✗ the config carries no dapps.recommended array — nothing to do.')
  process.exit(1)
}

const dupes = duplicateIds(recommended)
if (dupes.length > 0) {
  console.error(`✗ dapps.recommended has duplicate ids: ${dupes.join(', ')}`)
  console.error('  Each id keys one icon object and one favourite, so a duplicate makes two dApps')
  console.error('  share both. Give each entry its own id before running this.')
  process.exit(1)
}

const collisions = collidingEntries(recommended)
const sameUrl = collisions.filter((c) => c.kind === 'url')
if (sameUrl.length > 0) {
  for (const {value, ids} of sameUrl) console.error(`✗ ${ids.join(' and ')} both open ${value}`)
  console.error('  Two rows opening one page is never right — drop all but one before running this.')
  process.exit(1)
}
for (const {value, ids} of collisions.filter((c) => c.kind === 'name')) {
  console.warn(`! ${ids.join(' and ')} are both named "${value}" — usually a marketing site beside its app.`)
}

const targets = entriesNeedingIcons(recommended, baseUrl, all)
console.log(
  `${recommended.length} recommended entries, ${targets.length} to resolve` +
    `${check ? ' (check mode, nothing will be written)' : ''}`,
)
if (targets.length === 0) process.exit(0)
if (!check) await mkdir(outDir, {recursive: true})

const outcomes: Outcome[] = []
const queue = [...targets]
const worker = async () => {
  for (;;) {
    const entry = queue.shift()
    if (!entry) return
    try {
      const {candidates, note} = await candidatesFor(entry.uri)
      if (candidates.length === 0) {
        outcomes.push({id: entry.id, ok: false, reason: note ?? 'the page declares no artwork'})
        continue
      }
      const raster = await rasterize(candidates)
      if (!raster) {
        outcomes.push({id: entry.id, ok: false, reason: `none of ${candidates.length} candidates decoded`})
        continue
      }
      if (!check) await writeFile(join(outDir, `${entry.id}.png`), raster.png)
      outcomes.push({id: entry.id, ok: true, kind: raster.kind, from: raster.from, bytes: raster.png.length})
    } catch (e) {
      outcomes.push({id: entry.id, ok: false, reason: String(e)})
    }
  }
}
await Promise.all(Array.from({length: CONCURRENCY}, worker))

const resolved = outcomes.filter((o): o is Extract<Outcome, {ok: true}> => o.ok)
const unresolved = outcomes.filter((o): o is Extract<Outcome, {ok: false}> => !o.ok)

console.log(`\n✓ resolved ${resolved.length}/${targets.length}`)
for (const o of [...resolved].sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`  ${o.id.padEnd(28)} ${o.kind.padEnd(17)} ${(o.bytes / 1024).toFixed(1)}kb  ${o.from}`)
}
if (unresolved.length > 0) {
  console.log(`\n⚠ unresolved ${unresolved.length} — these keep whatever logo they had (usually none):`)
  for (const o of [...unresolved].sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${o.id.padEnd(28)} ${o.reason}`)
  }
  console.log('  Source artwork by hand for these, or drop them from the list.')
}
const banner = resolved.filter((o) => o.kind === 'og:image')
if (banner.length > 0) {
  console.log(
    `\n⚠ ${banner.length} fell through to og:image, which is usually a wide social banner —` +
      ` look at these before publishing: ${banner.map((o) => o.id).join(', ')}`,
  )
}

if (check) process.exit(unresolved.length > 0 ? 1 : 0)

const updated = {
  ...config,
  dapps: {
    ...config.dapps,
    recommended: recommended.map((e) =>
      resolved.some((o) => o.id === e.id) ? {...e, logo: iconPublicUrl(baseUrl, e.id)} : e,
    ),
  },
}
const rewritten = `${configPath}.with-icons.json`
await writeFile(rewritten, `${JSON.stringify(updated, null, 2)}\n`)

console.log(`\nWrote ${resolved.length} PNGs to ${outDir}`)
console.log(`Wrote the rewritten config to ${rewritten}`)
const baseDigest = await remoteDigest()
const publishScript = join(outDir, 'publish.sh')
await writeFile(
  publishScript,
  [
    '#!/bin/sh',
    `# Generated by build-dapp-icons.ts from ${basename(configPath)}. Publishes to ${env}.json.`,
    '# Review the PNGs before running this.',
    '#',
    '# `--remote` is mandatory on every call: without it wrangler writes a local',
    '# miniflare copy and reports success while the real bucket stays untouched.',
    'set -e',
    '',
    ...(env === 'prod'
      ? [
          '# Prod is opt-in. Curation runs on dev and preview; reaching production',
          '# should be a decision someone types, not the default a script inherits.',
          'if [ "$CONFIRM" != "prod" ]; then',
          '  echo "This publishes to PRODUCTION. Re-run as: CONFIRM=prod sh $0"',
          '  exit 1',
          'fi',
          '',
        ]
      : []),
    '# The config put below replaces the WHOLE object, carrying the features, banners,',
    '# maintenance flags and allowedLinks as they were when it was fetched. If someone',
    '# has edited the bucket since — flipped maintenance during an incident, say —',
    '# publishing would silently revert them. So refuse unless the bucket still holds',
    '# what it held when this script was generated.',
    ...(baseDigest === null
      ? [
          '# NOTE: the bucket could not be read when this script was generated, so there',
          '# is no concurrent-write guard below. Check the object by hand before running.',
        ]
      : [
          `expected=${baseDigest}`,
          'current=$(mktemp)',
          `bunx wrangler r2 object get ${BUCKET}/${env}.json --remote --pipe > "$current"`,
          'actual=$(sha256sum < "$current" | cut -d" " -f1)',
          'rm -f "$current"',
          'if [ "$actual" != "$expected" ]; then',
          `  echo "x ${env}.json changed since this script was generated - someone else has published."`,
          '  echo "  Re-run the icon job against the current file rather than overwriting theirs."',
          '  exit 1',
          'fi',
        ]),
    '',
    ...[...resolved]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(
        (o) =>
          `bunx wrangler r2 object put ${BUCKET}/${iconObjectKey(o.id)} --remote` +
          ` --file=${join(outDir, `${o.id}.png`)} --content-type=image/png --cache-control="public, max-age=86400"`,
      ),
    '',
    `bunx wrangler r2 object put ${BUCKET}/${env}.json --remote` +
      ` --file=${rewritten} --content-type=application/json --cache-control="public, max-age=300"`,
    '',
  ].join('\n'),
  {mode: 0o755},
)
console.log(`Wrote the publish script to ${publishScript}`)
console.log(`\n\u26a0 Publishing replaces the whole of ${env}.json, not just the dapps block.`)
console.log(`  Everything else is carried through from ${basename(configPath)} as it was when you fetched it;`)
console.log('  the script refuses to run if the bucket has moved since.')
console.log(`\nReview the PNGs, then:  ${env === 'prod' ? `CONFIRM=prod sh ${publishScript}` : `sh ${publishScript}`}`)
console.log(`Verify:                 curl -s ${baseUrl}/${env}.json | head -c 400`)
