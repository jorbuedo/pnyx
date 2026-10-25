/**
 * Fetch + normalise phase. Resumable, idempotent, gateway-rotating. Reads pending
 * assets from assets.db, fetches the source (local kubo + public IPFS gateways,
 * arweave, http, inline data, registry), sniffs bytes, normalises to a SIZE-px WebP
 * still (SIZE env, default 256), writes out/media/{shard}/{fingerprint}.{SIZE}.webp
 * where shard is fingerprint[6:8], and records the outcome back into the DB.
 *
 * Design notes:
 *  - Local kubo is tried LAST for IPFS, so a `ipfs-local` win = content the public
 *    gateways could not serve → a direct measurement of kubo's marginal coverage.
 *  - A CID is only 'not-found' after ALL gateways fail; 429/5xx are retried with
 *    backoff; a gateway that errors repeatedly is dropped for the rest of the run.
 *  - status='ok' is never re-fetched. not-found/timeout/error are retried on re-run.
 *  - Animated sources are stored as their FIRST FRAME only — see normalise().
 *  - Memory is bounded on purpose: rows stream in keyset batches (BATCH), libvips keeps
 *    no cache and one thread, and a decode is capped at MAX_PIXELS. This box has 3.7 GB
 *    and the crawl is one of four services on it.
 *
 * Usage: LIMIT=3000 SCHEMES=ipfs,http,arweave,data CONC=48 SIZE=256 bun run fetch.ts <assets.db> <outDir>
 *        BATCH=2000 MAX_PIXELS=50000000 TOTAL=<retryable count, for the progress line>
 */
import {Database} from 'bun:sqlite'
import {createHash} from 'node:crypto'
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import sharp from 'sharp'

// libvips keeps an operation cache and spawns a thread pool PER CALL sized to the core
// count. With CONC workers each calling sharp, that multiplies into hundreds of MB of
// decoded-image cache on a box with 3.7 GB. Neither helps a one-shot thumbnail: every
// source is decoded exactly once and never revisited.
sharp.cache(false)
sharp.concurrency(1)

const [, , dbPath = '../data/assets.db', outDir = '../out'] = process.argv
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity
const CONC = process.env.CONC ? Number(process.env.CONC) : 48
const SIZE = Number(process.env.SIZE ?? 256)
const SCHEMES = process.env.SCHEMES?.split(',')
const REGISTRY = '../data/token-registry/mappings'

// Probed 2026-09-11 against known-live CIDs from this corpus, ordered fastest-first.
// Order is a hint only: the runtime circuit breaker below drops whatever misbehaves.
// Dropped: trustless-gateway.link (406 on every request — it wants IPLD raw/car, not */*)
//          4everland.io (all timeouts; its snapshot.* host answers 5/5 and is kept)
const PUBLIC_GATEWAYS = process.env.GATEWAYS?.split(',') ?? [
  // Re-probed 2026-09-11 validating IMAGE BYTES, not HTTP status — dag.w3s.link and
  // ipfs.decoo.io answer 200 with an HTML page and would poison assets (see fetchIpfs).
  // Ordered by measured median; the runtime breaker reorders reality.
  //   68-530ms, 5/5 : raribleuserdata, filebase, ipfsscan, snapshot.4everland
  //   641-886ms, 5/5: dget.top, orbitor.dev x4 (near-identical latency, so possibly
  //                   one backend behind four names — do not count as four buckets)
  //   429 at probe : ipfs.io / dweb.link / w3s.link / nftstorage.link, all Protocol
  //                   Labs / Storacha infra failing as a block, i.e. one IP-keyed
  //                   limiter. Kept: throttled is not broken, and they recover.
  'https://ipfs.raribleuserdata.com/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://gateway.ipfsscan.io/ipfs/',
  'https://snapshot.4everland.link/ipfs/',
  'https://dget.top/ipfs/',
  'https://apac.orbitor.dev/ipfs/',
  'https://ipfs.orbitor.dev/ipfs/',
  'https://latam.orbitor.dev/ipfs/',
  'https://eu.orbitor.dev/ipfs/',
  'https://4everland.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
  'https://nftstorage.link/ipfs/',
]
// Port is overridable: on the Pi, :8080 is nginx serving the media tree, so a
// hardcoded 8080 would silently score every kubo read as a public-gateway miss.
const KUBO = process.env.KUBO_GATEWAY ?? 'http://127.0.0.1:8080/ipfs/' // tried LAST → its wins measure marginal coverage
const IPFS_GATEWAYS = [...PUBLIC_GATEWAYS, KUBO]
const ARWEAVE = ['https://arweave.net/', 'https://ar-io.net/']
const UA = 'pnyx-media-blob/0.1 (+cardano native-asset media archival; https://media.pxkq.uk)'
const CAP = 50 * 1024 * 1024
// A decode allocates roughly 4 bytes per pixel, so the old 500 MP ceiling let one 50 MB
// source ask for 2 GB on a 3.7 GB box — a decompression bomb with the door held open.
// 50 MP (about 7000x7000) is far beyond anything a 256 px thumbnail can use, and measured
// at 10 rejects in the first 4,400 processed. A source over it lands as 'decode-failed'
// with 'Input image exceeds pixel limit' in last_error. That status is NOT retryable, so
// raising this later needs the rows reopened too:
//   UPDATE asset SET status='pending' WHERE last_error LIKE '%exceeds pixel limit%';
const MAX_PIXELS = Number(process.env.MAX_PIXELS ?? 50_000_000)
const TIMEOUT = 15000
const KUBO_TIMEOUT = Number(process.env.KUBO_TIMEOUT ?? 15000) // DHT lookups are slow, but a miss must not stall a worker for 45s

const db = new Database(dbPath)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;')
const update = db.prepare(`UPDATE asset SET status=$st, resolved_via=$via, src_mime=$mime, src_bytes=$sb,
  out_bytes=$ob, sha256=$sha, attempts=attempts+1, last_error=$err WHERE fingerprint=$fp`)

const retryable = `status IS NULL OR status IN ('pending','not-found','timeout','error','gateway-error')`
const STATUS = process.env.STATUS?.split(',')
// STATUS=pending → work only newly-ingested rows; default is every retryable status.
const selectable = STATUS ? `status IN (${STATUS.map((s) => `'${s}'`).join(',')})` : retryable
const where = `(${selectable})` + (SCHEMES ? ` AND scheme IN (${SCHEMES.map((s) => `'${s}'`).join(',')})` : '')
// Rows are STREAMED in keyset batches, never materialised. `.all()` over an unbounded
// retryable set loaded 2,896,360 rows (~1.5 GB of JS strings) on a 3.7 GB box, which is
// what the OOM killer took out roughly hourly — six kills on 2026-10-18 alone, so the
// crawl never lived long enough to finish a pass. BATCH trades query count for RSS.
const BATCH = Number(process.env.BATCH ?? 2000)
const RECENT = process.env.ORDER === 'recent' // newest mints first: coverage is worst where assets are newest
const SAMPLE = Boolean(process.env.SAMPLE) // pseudo-random order for representative validation

if (SAMPLE && !Number.isFinite(LIMIT)) {
  // substr(fingerprint, 9) is unindexed, so paging it would re-sort the whole table per
  // batch. SAMPLE is a validation mode; bound it rather than quietly changing its order.
  console.error('fetch: SAMPLE needs a finite LIMIT — it sorts the whole table')
  process.exit(1)
}

type PendingRow = {
  fingerprint: string
  kind: string
  scheme: string
  canonical: string
  source_uris: string
  mint_slot?: number // selected only for ORDER=recent, where it is half the cursor
}

const cols = `fingerprint, kind, scheme, canonical, source_uris${RECENT ? ', mint_slot' : ''}`
// Keyset, not OFFSET: a processed row can leave the retryable set, which shifts every
// later offset and silently skips work. The cursor only ever moves forward, so each pass
// visits a row once even though 'not-found' and 'timeout' stay retryable.
const batchQuery = SAMPLE
  ? db.query(`SELECT ${cols} FROM asset WHERE ${where} ORDER BY substr(fingerprint, 9) LIMIT ?`)
  : RECENT
    ? db.query(`SELECT ${cols} FROM asset WHERE ${where}
        AND ($slot IS NULL OR mint_slot < $slot OR (mint_slot = $slot AND fingerprint > $fp))
        ORDER BY mint_slot DESC, fingerprint LIMIT $n`)
    : db.query(`SELECT ${cols} FROM asset WHERE ${where}
        AND ($fp IS NULL OR fingerprint > $fp) ORDER BY fingerprint LIMIT $n`)

let cursor: {fp: string; slot: number} | null = null
let remaining = LIMIT

const nextBatch = (): PendingRow[] => {
  if (remaining <= 0) return []
  const n = Number.isFinite(remaining) ? Math.min(BATCH, remaining) : BATCH
  const got = (
    SAMPLE
      ? batchQuery.all(n)
      : RECENT
        ? batchQuery.all({$slot: cursor?.slot ?? null, $fp: cursor?.fp ?? null, $n: n})
        : batchQuery.all({$fp: cursor?.fp ?? null, $n: n})
  ) as PendingRow[]
  const last = got[got.length - 1]
  if (last) cursor = {fp: last.fingerprint, slot: last.mint_slot ?? 0}
  remaining = SAMPLE ? 0 : remaining - got.length // SAMPLE is one bounded shot, not a page
  return got
}

// run-fetch.sh already counts the retryable set for its log line; reuse it rather than
// repeating a 10M-row scan here just to print a denominator.
const TOTAL = process.env.TOTAL ? Number(process.env.TOTAL) : null
console.error(
  `fetch: streaming in batches of ${BATCH} (schemes=${SCHEMES ?? 'all'}, conc=${CONC}, total=${TOTAL ?? 'unknown'})`,
)

// runtime gateway health (circuit breaker) + hit accounting
const deadGw = new Set<string>()
const gwFails = new Map<string, number>()
const gwWins: Record<string, number> = {}
const status: Record<string, number> = {}
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1)

type Fetched = {bytes: Uint8Array; mime: string; via: string}
const fetchOnce = async (url: string, timeout: number): Promise<Fetched | {err: string; retryable: boolean}> => {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {'User-Agent': UA, Accept: 'image/*,*/*'},
      redirect: 'follow',
    })
    if (!r.ok) return {err: `http ${r.status}`, retryable: r.status === 429 || r.status >= 500}
    const len = Number(r.headers.get('content-length') ?? 0)
    if (len > CAP) return {err: 'too-large', retryable: false}
    const buf = new Uint8Array(await r.arrayBuffer())
    if (buf.length > CAP) return {err: 'too-large', retryable: false}
    return {bytes: buf, mime: r.headers.get('content-type') ?? '', via: url}
  } catch (e: any) {
    const to = e?.name === 'AbortError'
    return {err: to ? 'timeout' : String(e?.message ?? e).slice(0, 60), retryable: true}
  } finally {
    clearTimeout(t)
  }
}

// Only genuine HEALTH failures (timeout / connection error) count toward marking a
// gateway dead — a 404 means "this CID isn't here", not "this gateway is down". A
// random sample is ~18% dead CIDs, so counting 404s would wrongly kill healthy gateways.
// A strike-out must EXPIRE. `deadGw` used to be permanent for the run, which is
// fine for an hour-long pass and catastrophic for a multi-day one: on 2026-09-11 a
// rate-limit episode struck out every gateway in turn, after which fetchIpfs skipped
// them all and converted 5.7M assets into 'not-found' at 2000/s without a single
// request. Cooldowns are exponential (1m, 2m, 4m … capped at 30m) so a throttled
// gateway rejoins on its own once the rate window passes.
const COOLDOWN_BASE_MS = 60_000
const COOLDOWN_MAX_MS = 30 * 60_000
let gwCursor = 0
const gwCooldownUntil = new Map<string, number>()
const gwStrikeRounds = new Map<string, number>()

const gwAvailable = (gw: string): boolean => (gwCooldownUntil.get(gw) ?? 0) <= Date.now()

const noteGw = (gw: string, ok: boolean, healthFail: boolean) => {
  if (ok) {
    gwFails.set(gw, 0)
    gwStrikeRounds.delete(gw)
    gwCooldownUntil.delete(gw)
  } else if (healthFail) {
    const n = (gwFails.get(gw) ?? 0) + 1
    gwFails.set(gw, n)
    if (n >= 40) {
      const round = (gwStrikeRounds.get(gw) ?? 0) + 1
      gwStrikeRounds.set(gw, round)
      const cool = Math.min(COOLDOWN_BASE_MS * 2 ** (round - 1), COOLDOWN_MAX_MS)
      gwCooldownUntil.set(gw, Date.now() + cool)
      gwFails.set(gw, 0) // fresh 40 strikes after it comes back
      deadGw.add(gw) // retained purely for the end-of-run report
      process.stderr.write(`  [gw] ${new URL(gw).host} cooling down ${Math.round(cool / 1000)}s (round ${round})\n`)
    }
  }
}
const isHealthFail = (err: string): boolean => err === 'timeout' || !err.startsWith('http ')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** IPFS: rotate gateways (public first, kubo last), retry retryables with backoff. */
const fetchIpfs = async (cidPath: string): Promise<Fetched | {err: string}> => {
  let lastErr = 'not-found'
  let nonImage = 0

  // If every gateway is cooling down, WAIT. Returning 'not-found' here is what
  // destroyed a whole pass: it is indistinguishable from "the CID is gone" but
  // means "we did not look". Bounded so a worker cannot hang forever.
  if (IPFS_GATEWAYS.every((gw) => !gwAvailable(gw))) {
    const soonest = Math.min(...IPFS_GATEWAYS.map((gw) => gwCooldownUntil.get(gw) ?? 0))
    const waitMs = Math.max(0, Math.min(soonest - Date.now(), 60_000))
    if (waitMs > 0) await sleep(waitMs + 250)
    if (IPFS_GATEWAYS.every((gw) => !gwAvailable(gw))) return {err: 'gateway-error'}
  }

  // Every request used to start at IPFS_GATEWAYS[0], so a 10-gateway rotation
  // behaved like a 1-gateway one: the head host absorbed the entire run until it
  // throttled, then the next, and so on until all were struck out. Offsetting the
  // start per call fans the load out. Kubo stays pinned LAST, so an `ipfs-local`
  // win still means "no public gateway could serve this".
  const pub = IPFS_GATEWAYS.filter((g) => g !== KUBO)
  const off = gwCursor++ % (pub.length || 1)
  const rotated = [...pub.slice(off), ...pub.slice(0, off)]
  // KUBO_FIRST: public gateways are rate-limited third parties and measurably the
  // binding constraint (CONC 64 scored WORSE than 32 — pure throttling). Our own
  // node has no such ceiling and the link is only 7% used, so for the bulk crawl we
  // ask it first and keep the gateways as fallback. Set KUBO_FIRST=0 to restore the
  // original last-place ordering, where an `ipfs-local` win measures the marginal
  // coverage kubo adds over the public gateways.
  const hasKubo = IPFS_GATEWAYS.includes(KUBO)
  const order = !hasKubo ? rotated : process.env.KUBO_FIRST === '0' ? [...rotated, KUBO] : [KUBO, ...rotated]

  for (const gw of order) {
    if (!gwAvailable(gw)) continue
    const isKubo = gw === KUBO
    for (let attempt = 0; attempt < (isKubo ? 1 : 2); attempt++) {
      const res = await fetchOnce(gw + cidPath, isKubo ? KUBO_TIMEOUT : TIMEOUT)
      if ('bytes' in res) {
        // A gateway can answer 200 with an HTML error page or a DAG/CAR payload.
        // Accepting that would record the asset as 'decode-failed', which is NOT in
        // the retryable set — one misbehaving gateway would permanently strip assets
        // from the corpus. So a non-image body is THIS GATEWAY's miss: rotate on.
        // Only when every gateway returns a non-image is it the asset's problem.
        if (sniff(res.bytes) === 'unknown') {
          lastErr = 'not-image'
          nonImage++
          noteGw(gw, false, false)
          break
        }
        noteGw(gw, true, false)
        return {...res, via: isKubo ? 'ipfs-local' : `ipfs-gateway:${new URL(gw).host}`}
      }
      lastErr = res.err
      noteGw(gw, false, isHealthFail(res.err))
      if (res.err === 'too-large') return {err: 'too-large'}
      if (!res.retryable) break
      await sleep(300 * (attempt + 1))
    }
  }
  // 'not-found' is retryable; a later run with a healthier gateway set can recover it.
  if (nonImage > 0 && lastErr === 'not-image') return {err: 'not-found'}
  return {err: lastErr === 'timeout' ? 'timeout' : 'not-found'}
}

const resolveSource = async (r: any): Promise<Fetched | {err: string}> => {
  if (r.scheme === 'data') {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(r.canonical)
    if (!m) return {err: 'error'}
    try {
      const bytes = m[2]
        ? Uint8Array.from(Buffer.from(m[3], 'base64'))
        : new TextEncoder().encode(decodeURIComponent(m[3]))
      return {bytes, mime: m[1] || '', via: 'data-uri'}
    } catch {
      return {err: 'error'}
    }
  }
  if (r.scheme === 'data-registry') {
    try {
      const j = JSON.parse(readFileSync(`${REGISTRY}/${r.canonical.replace('registry:', '')}.json`, 'utf8'))
      return {bytes: Uint8Array.from(Buffer.from(j.logo.value, 'base64')), mime: '', via: 'registry'}
    } catch {
      return {err: 'not-found'}
    }
  }
  if (r.scheme === 'arweave') {
    let lastErr = 'not-found'
    for (const gw of ARWEAVE) {
      const res = await fetchOnce(gw + r.canonical, TIMEOUT)
      if ('bytes' in res) return {...res, via: 'arweave'}
      lastErr = res.err
    }
    return {err: lastErr === 'timeout' ? 'timeout' : 'not-found'}
  }
  if (r.scheme === 'http') {
    const res = await fetchOnce(r.canonical.replace(/^http:/, 'https:'), TIMEOUT)
    if ('bytes' in res) return {...res, via: 'http'}
    return {err: res.err === 'timeout' ? 'timeout' : res.err === 'too-large' ? 'too-large' : 'not-found'}
  }
  if (r.scheme === 'ipfs') return fetchIpfs(r.canonical)
  return {err: 'not-found'}
}

/** Magic-byte sniff (declared mime is unreliable — `img/png` etc. exist). */
const sniff = (b: Uint8Array): string => {
  if (b.length < 12) return 'unknown'
  if (b[0] === 0x89 && b[1] === 0x50) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'webp'
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02)) return 'video' // mpeg
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video' // ftyp mp4/mov
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio' // ID3
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0c && b[4] === 0x6a) return 'jp2'
  const head = new TextDecoder().decode(b.slice(0, 256)).trim().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return 'svg'
  return 'unknown'
}

/**
 * First frame only — never animated. Measured on this corpus: an animated source
 * encodes to ~2.0 MB as animated WebP (p90 5.4 MB) versus ~23 KB as a still, a 6x
 * multiplier on the whole blob for detail the UI never shows, since AssetMedia
 * renders a still at 240pt.
 */
const normalise = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(bytes, {animated: false, pages: 1, limitInputPixels: MAX_PIXELS})
      .resize(SIZE, SIZE, {fit: 'inside', withoutEnlargement: true})
      .webp({quality: 80, effort: 4})
      .toBuffer(),
  )

const shardsMade = new Set<string>()
let done = 0
const t0 = Date.now()
const processOne = async (r: any) => {
  const src = await resolveSource(r)
  const set = (st: string, o: Partial<any> = {}) => {
    update.run({
      $fp: r.fingerprint,
      $st: st,
      $via: o.via ?? null,
      $mime: o.mime ?? null,
      $sb: o.sb ?? null,
      $ob: o.ob ?? null,
      $sha: o.sha ?? null,
      $err: o.err ?? null,
    })
    bump(status, st)
  }
  if ('err' in src) return set(src.err)
  const kind = sniff(src.bytes)
  if (kind === 'video' || kind === 'audio')
    return set('unsupported', {via: src.via, mime: src.mime, sb: src.bytes.length, err: `sniff:${kind}`})
  if (kind === 'unknown')
    return set('decode-failed', {via: src.via, mime: src.mime, sb: src.bytes.length, err: 'sniff:unknown'})
  let out: Uint8Array
  try {
    out = await normalise(src.bytes)
  } catch (e: any) {
    return set('decode-failed', {
      via: src.via,
      mime: src.mime,
      sb: src.bytes.length,
      err: String(e?.message ?? e).slice(0, 60),
    })
  }
  // Shard on the two chars after the constant `asset1` prefix: ~1k dirs instead of
  // a directory per asset, which halves inode use at 7.5M assets and keeps the
  // Mac->Pi transfer sane.
  const shard = r.fingerprint.slice(6, 8)
  if (!shardsMade.has(shard)) {
    mkdirSync(`${outDir}/media/${shard}`, {recursive: true})
    shardsMade.add(shard)
  }
  // Written through a dot-prefixed temp + rename: on the Pi this tree IS the live
  // nginx root, and a half-written file served once is cached `immutable` for a year.
  const dest = `${outDir}/media/${shard}/${r.fingerprint}.${SIZE}.webp`
  const tmp = `${outDir}/media/${shard}/.${r.fingerprint}.${SIZE}.webp.tmp`
  writeFileSync(tmp, out)
  renameSync(tmp, dest)
  const sha = createHash('sha256').update(out).digest('hex')
  if (src.via.startsWith('ipfs')) bump(gwWins, src.via)
  set('ok', {via: src.via, mime: src.mime, sb: src.bytes.length, ob: out.length, sha})
}

// One shared queue refilled from the cursor. `take` is synchronous and bun:sqlite is
// synchronous, so no two workers can interleave inside a refill.
let queue: PendingRow[] = []
let qi = 0
let drained = false
const take = (): PendingRow | undefined => {
  if (qi >= queue.length) {
    if (drained) return undefined
    queue = nextBatch()
    qi = 0
    if (queue.length === 0) {
      drained = true
      return undefined
    }
  }
  return queue[qi++]
}

const worker = async () => {
  for (let r = take(); r !== undefined; r = take()) {
    try {
      await processOne(r)
    } catch (e: any) {
      update.run({
        $fp: r.fingerprint,
        $st: 'error',
        $via: null,
        $mime: null,
        $sb: null,
        $ob: null,
        $sha: null,
        $err: String(e?.message ?? e).slice(0, 60),
      })
      bump(status, 'error')
    }
    if (++done % 200 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1)
      process.stderr.write(`  ${done}${TOTAL ? `/${TOTAL}` : ''} (${rate}/s) ${JSON.stringify(status)}\n`)
    }
  }
}
await Promise.all(Array.from({length: CONC}, worker))

console.log(
  JSON.stringify(
    {
      processed: done,
      status,
      ipfs_gateway_wins: gwWins,
      kubo_marginal: gwWins['ipfs-local'] ?? 0,
      dead_gateways: [...deadGw],
    },
    null,
    2,
  ),
)
db.close()
