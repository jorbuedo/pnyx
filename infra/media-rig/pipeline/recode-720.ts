/**
 * Recode the parked 720px calibration outputs into the current 256px still layout.
 *
 * resized variants their geometry is already correct (`fit: inside`, never enlarged) — downscaling
 * is a clean second generation, measured at ~35dB PSNR against a single-generation 256. That beats
 *
 * Only touches rows that are still retryable — an asset the crawl has already banked keeps its
 * single-generation image.
 */
import {Database} from 'bun:sqlite'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import sharp from 'sharp'

sharp.concurrency(1)
sharp.cache(false)

const [, , dbPath, parkedDir, outDir] = process.argv
const SIZE = 256
const db = new Database(dbPath)
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;')
const RETRYABLE = `status IS NULL OR status IN ('pending','not-found','timeout','error','gateway-error')`
const isRetryable = db.prepare(`SELECT 1 FROM asset WHERE fingerprint=? AND (${RETRYABLE})`)
const update = db.prepare(
  `UPDATE asset SET status='ok', resolved_via='local-720-recode', out_bytes=$ob, sha256=$sha,
   attempts=attempts+1, last_error=NULL WHERE fingerprint=$fp AND (${RETRYABLE})`,
)

const fps = readdirSync(parkedDir).filter((f) => f.startsWith('asset1'))
let done = 0, skipped = 0, failed = 0, bytes = 0
const shards = new Set<string>()

for (const fp of fps) {
  if (!isRetryable.get(fp)) { skipped++; continue }
  const src = `${parkedDir}/${fp}/720.webp`
  if (!existsSync(src)) { skipped++; continue }
  try {
    const out = await sharp(readFileSync(src), {animated: false, pages: 1, limitInputPixels: 5e8})
      .resize(SIZE, SIZE, {fit: 'inside', withoutEnlargement: true})
      .webp({quality: 80, effort: 4})
      .toBuffer()
    const shard = fp.slice(6, 8)
    if (!shards.has(shard)) { mkdirSync(`${outDir}/media/${shard}`, {recursive: true}); shards.add(shard) }
    // tmp+rename: the crawl may be writing the same key concurrently, and a reader
    // (or the rsync to the Pi) must never see a partial file.
    const final = `${outDir}/media/${shard}/${fp}.${SIZE}.webp`
    const tmp = `${final}.${process.pid}.tmp`
    writeFileSync(tmp, out)
    renameSync(tmp, final)
    update.run({$fp: fp, $ob: out.length, $sha: createHash('sha256').update(out).digest('hex')})
    done++; bytes += out.length
  } catch (e) {
    failed++
    process.stderr.write(`  recode failed ${fp}: ${String(e).slice(0, 70)}\n`)
  }
}
console.log(JSON.stringify({parked: fps.length, recoded: done, skippedAlreadyOk: skipped, failed, outMB: +(bytes / 1048576).toFixed(1)}, null, 2))
db.close()
