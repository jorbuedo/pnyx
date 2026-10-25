/**
 * Calibration sample: fetch + normalise a small stratified sample of real assets
 * to MEASURE (a) fetch hit-rate per scheme and (b) the true average 720px-WebP
 * size — turning the checkpoint's size projection from a 5× guess into a number.
 * Uses public gateway rotation only (no local kubo yet) so it's a lower bound on
 * the eventual hit-rate.
 *
 * Usage: bun run calibrate.ts <assets.db> [perScheme]
 */
import {Database} from 'bun:sqlite'
import {readFileSync} from 'node:fs'
import sharp from 'sharp'

const [, , dbPath = '../data/assets.db', perArg] = process.argv
const N = perArg ? Number(perArg) : 400
const db = new Database(dbPath)

const GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://4everland.io/ipfs/',
  'https://cf-ipfs.com/ipfs/',
]
const UA = 'pnyx-media-blob/0.1 (+cardano native-asset media archival; https://media.pxkq.uk)'
const CAP = 50 * 1024 * 1024
const TIMEOUT = 12000

type Row = {fingerprint: string; scheme: string; canonical: string; image_raw: string}

const sample = (scheme: string, n: number): Row[] =>
  db.query(
    `SELECT fingerprint, scheme, canonical, image_raw FROM asset
     WHERE scheme=? AND canonical IS NOT NULL
     ORDER BY substr(fingerprint, ${scheme.length % 5} + 3) LIMIT ?`,
  ).all(scheme, n) as Row[]

const fetchCap = async (url: string): Promise<{bytes: Uint8Array; mime: string} | {err: string}> => {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const r = await fetch(url, {signal: ctl.signal, headers: {'User-Agent': UA, Accept: 'image/*,*/*'}, redirect: 'follow'})
    if (!r.ok) return {err: `http ${r.status}`}
    const len = Number(r.headers.get('content-length') ?? 0)
    if (len > CAP) return {err: 'too-large'}
    const buf = new Uint8Array(await r.arrayBuffer())
    if (buf.length > CAP) return {err: 'too-large'}
    return {bytes: buf, mime: r.headers.get('content-type') ?? ''}
  } catch (e: any) {
    return {err: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e).slice(0, 40)}
  } finally {
    clearTimeout(t)
  }
}

/** Sniff container from magic bytes (declared mime is unreliable). */
const sniff = (b: Uint8Array): string => {
  const h = (n: number) => b[n]
  if (b.length < 12) return 'unknown'
  if (h(0) === 0x89 && h(1) === 0x50) return 'png'
  if (h(0) === 0xff && h(1) === 0xd8) return 'jpeg'
  if (h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46) return 'gif'
  if (h(0) === 0x52 && h(1) === 0x49 && h(8) === 0x57 && h(9) === 0x45) return 'webp'
  if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70) return 'video' // ftyp
  const head = new TextDecoder().decode(b.slice(0, 256)).trim().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return 'svg'
  if (h(0) === 0x42 && h(1) === 0x4d) return 'bmp'
  return 'unknown'
}

const resolveSource = async (r: Row): Promise<{bytes: Uint8Array; via: string} | {err: string}> => {
  if (r.scheme === 'data') {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(r.canonical)
    if (!m) return {err: 'bad-data-uri'}
    const bytes = m[2] ? Uint8Array.from(Buffer.from(m[3], 'base64')) : new TextEncoder().encode(decodeURIComponent(m[3]))
    return {bytes, via: 'data-uri'}
  }
  if (r.scheme === 'data-registry') {
    const subject = r.canonical.replace('registry:', '')
    try {
      const j = JSON.parse(readFileSync(`../data/token-registry/mappings/${subject}.json`, 'utf8'))
      return {bytes: Uint8Array.from(Buffer.from(j.logo.value, 'base64')), via: 'registry'}
    } catch (e: any) {
      return {err: 'registry-read'}
    }
  }
  if (r.scheme === 'arweave') {
    const g = await fetchCap(`https://arweave.net/${r.canonical}`)
    return 'err' in g ? g : {bytes: g.bytes, via: 'arweave'}
  }
  if (r.scheme === 'http') {
    const url = r.canonical.replace(/^http:/, 'https:')
    const g = await fetchCap(url)
    return 'err' in g ? g : {bytes: g.bytes, via: 'http'}
  }
  // ipfs: rotate gateways until one serves
  let lastErr = 'not-found'
  for (const gw of GATEWAYS) {
    const g = await fetchCap(gw + r.canonical)
    if (!('err' in g)) return {bytes: g.bytes, via: `ipfs-gateway:${new URL(gw).host}`}
    lastErr = g.err
    if (g.err === 'too-large') break
  }
  return {err: lastErr}
}

const enc = (bytes: Uint8Array, animated: boolean) =>
  sharp(bytes, {animated, limitInputPixels: 500_000_000, pages: animated ? -1 : 1})
    .resize(720, 720, {fit: 'inside', withoutEnlargement: true})
    .webp({quality: 80, effort: 4})
    .toBuffer()

/** Returns still size always, and animated size when the source is multi-frame. */
const normalise = async (
  bytes: Uint8Array,
  kind: string,
): Promise<{still: number; anim: number | null; frames: number} | {err: string}> => {
  if (kind === 'video' || kind === 'unknown') return {err: `unsupported:${kind}`}
  try {
    const meta = await sharp(bytes, {animated: true}).metadata()
    const frames = meta.pages ?? 1
    const still = (await enc(bytes, false)).length
    const anim = frames > 1 ? (await enc(bytes, true)).length : null
    return {still, anim, frames}
  } catch {
    return {err: 'decode-failed'}
  }
}

// stratified sample
const plan: [string, number][] = [
  ['ipfs', N],
  ['http', Math.round(N * 0.15)],
  ['arweave', Math.round(N * 0.15)],
  ['data', Math.round(N * 0.1)],
  ['data-registry', Math.round(N * 0.05)],
]
const rows = plan.flatMap(([s, n]) => sample(s, n))
console.error(`sampling ${rows.length} assets...`)

const results: any[] = []
const CONC = 24
let idx = 0
const worker = async () => {
  while (idx < rows.length) {
    const r = rows[idx++]
    const src = await resolveSource(r)
    if ('err' in src) {
      results.push({scheme: r.scheme, status: src.err.startsWith('unsupported') ? 'unsupported' : src.err, srcBytes: 0, outBytes: 0})
      continue
    }
    const kind = sniff(src.bytes)
    const norm = await normalise(src.bytes, kind)
    results.push({
      scheme: r.scheme, via: src.via, sniff: kind, srcBytes: src.bytes.length,
      status: 'err' in norm ? norm.err : 'ok',
      still: 'err' in norm ? 0 : norm.still,
      anim: 'err' in norm ? null : norm.anim,
      frames: 'err' in norm ? 0 : norm.frames,
    })
  }
}
await Promise.all(Array.from({length: CONC}, worker))

// aggregate
const bySchemeStat: Record<string, {n: number; ok: number}> = {}
const stillSizes: number[] = []
const animAsStill: number[] = [] // still-encode size for animated sources
const animAsAnim: number[] = [] // animated-encode size for animated sources
const statusCount: Record<string, number> = {}
const sniffCount: Record<string, number> = {}
let animCount = 0
for (const r of results) {
  bySchemeStat[r.scheme] ??= {n: 0, ok: 0}
  bySchemeStat[r.scheme].n++
  statusCount[r.status] = (statusCount[r.status] ?? 0) + 1
  if (r.sniff) sniffCount[r.sniff] = (sniffCount[r.sniff] ?? 0) + 1
  if (r.status === 'ok') {
    bySchemeStat[r.scheme].ok++
    stillSizes.push(r.still)
    if (r.anim != null) {
      animCount++
      animAsStill.push(r.still)
      animAsAnim.push(r.anim)
    }
  }
}
const stats = (arr: number[]) => {
  if (!arr.length) return {n: 0, mean_kb: 0, median_kb: 0, p90_kb: 0}
  const s = [...arr].sort((a, b) => a - b)
  return {
    n: s.length,
    mean_kb: +(s.reduce((a, b) => a + b, 0) / s.length / 1024).toFixed(1),
    median_kb: +(s[Math.floor(s.length / 2)] / 1024).toFixed(1),
    p90_kb: +(s[Math.floor(s.length * 0.9)] / 1024).toFixed(1),
  }
}
const okCount = results.filter((r) => r.status === 'ok').length
const meanStill = stillSizes.reduce((a, b) => a + b, 0) / (stillSizes.length || 1)
// mean under "animated policy" = static stills as-is + animated encoded animated
const meanAnimPolicy =
  (stillSizes.filter((_, i) => true).reduce((a, b) => a + b, 0) - animAsStill.reduce((a, b) => a + b, 0) + animAsAnim.reduce((a, b) => a + b, 0)) /
  (stillSizes.length || 1)

console.log(JSON.stringify({
  sampled: results.length,
  overall_ok_rate: +((100 * okCount) / results.length).toFixed(1),
  by_scheme: Object.fromEntries(Object.entries(bySchemeStat).map(([k, v]) => [k, `${v.ok}/${v.n} (${((100 * v.ok) / v.n).toFixed(0)}%)`])),
  status_counts: statusCount,
  sniff_counts: sniffCount,
  animated_ok: animCount,
  size_all_stills: stats(stillSizes),
  size_animated_sources: {as_still: stats(animAsStill), as_animated_webp: stats(animAsAnim)},
  mean_kb_still_policy: +(meanStill / 1024).toFixed(1),
  mean_kb_animated_policy: +(meanAnimPolicy / 1024).toFixed(1),
}, null, 2))
db.close()
