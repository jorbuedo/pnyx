/**
 * Re-resolve rows currently marked scheme 'other'/'none' with the corrected resolver
 * (recovers ipfs:// CIDv1 base58btc/base36 and other forms the first pass mislabelled).
 * Re-evaluates ALL source_uris and picks the first fetchable one.
 *
 * Usage: bun run fixup-resolve.ts <assets.db>
 */
import {Database} from 'bun:sqlite'
import {resolve} from './uri.js'

const [, , dbPath = '../data/assets.db'] = process.argv
const db = new Database(dbPath)
db.exec('PRAGMA journal_mode=WAL;')
const rows = db.query(`SELECT fingerprint, image_raw, source_uris FROM asset WHERE scheme IN ('other','none')`).all() as any[]
console.error(`re-resolving ${rows.length} other/none rows...`)

const upd = db.prepare(`UPDATE asset SET scheme=$scheme, canonical=$canon, image_raw=$img WHERE fingerprint=$fp`)
let recovered = 0
const tx = db.transaction((rs: any[]) => {
  for (const r of rs) {
    const uris: string[] = (() => {
      try {
        return JSON.parse(r.source_uris ?? '[]')
      } catch {
        return [r.image_raw]
      }
    })()
    for (const u of uris) {
      const res = resolve(u)
      if (res.scheme !== 'none' && res.scheme !== 'other') {
        upd.run({$fp: r.fingerprint, $scheme: res.scheme, $canon: res.canonical, $img: u})
        recovered++
        break
      }
    }
  }
})
tx(rows)
console.log(JSON.stringify({examined: rows.length, recovered}, null, 2))
db.close()
