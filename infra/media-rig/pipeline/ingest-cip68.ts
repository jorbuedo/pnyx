/**
 * Ingest CIP-68 datum-sourced media (cip68.jsonl) into assets.db. Same fingerprint
 * function + URI resolver as CIP-25, so keys and schemes line up. Latest slot wins.
 *
 * Usage: bun run ingest-cip68.ts <cip68.jsonl> <assets.db>
 */
import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'
import {Database} from 'bun:sqlite'
import {assetFingerprint} from './vendor/asset-fingerprint.js'
import {resolve} from './uri.js'

const [, , inPath = '../data/cip68.jsonl', dbPath = '../data/assets.db'] = process.argv
const db = new Database(dbPath)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')

const upsert = db.prepare(`
  INSERT INTO asset (fingerprint, policy_id, asset_name_hex, kind, cip_class, mint_slot, mint_tx,
                     image_raw, canonical, source_uris, scheme, declared_mime, name_match)
  VALUES ($fp,$pol,$name,$kind,$cip,$slot,NULL,$img,$canon,$uris,$scheme,NULL,'cip68-datum')
  ON CONFLICT(fingerprint) DO UPDATE SET
    mint_slot=$slot, image_raw=$img, canonical=$canon, source_uris=$uris, scheme=$scheme,
    cip_class=$cip, name_match='cip68-datum'
  WHERE excluded.mint_slot > asset.mint_slot
`)

const rl = createInterface({input: createReadStream(inPath), crlfDelay: Infinity})
let lines = 0,
  inserted = 0,
  noUri = 0
const tx = db.transaction((rows: any[]) => {
  for (const r of rows) inserted += upsert.run(r).changes
})
let batch: any[] = []
const KIND: Record<string, string> = {nft222: 'nft', ft333: 'ft-logo', rft444: 'nft', unresolved: 'nft'}

for await (const line of rl) {
  if (!line) continue
  lines++
  let rec: {slot: number; policy: string; name: string; image: string; kind: string}
  try {
    rec = JSON.parse(line)
  } catch {
    continue
  }
  const fp = assetFingerprint(`${rec.policy}.${rec.name}`)
  if (fp === null) continue
  const {scheme, canonical} = resolve(rec.image)
  if (scheme === 'none' || scheme === 'other') {
    noUri++
    continue
  }
  batch.push({
    $fp: fp,
    $pol: rec.policy,
    $name: rec.name,
    $kind: KIND[rec.kind] ?? 'nft',
    $cip: `cip68-${rec.kind}`,
    $slot: rec.slot,
    $img: rec.image,
    $canon: canonical,
    $uris: JSON.stringify([rec.image]),
    $scheme: scheme,
  })
  if (batch.length >= 2000) {
    tx(batch)
    batch = []
  }
}
if (batch.length) tx(batch)

console.log(JSON.stringify({lines, inserted, no_usable_uri: noUri}, null, 2))
db.close()
