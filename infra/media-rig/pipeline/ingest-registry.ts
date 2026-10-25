/**
 * Ingest Cardano Token Registry logos as kind='ft-logo'. The logo is a base64
 * image embedded in the mapping file (no IPFS, no network) — the fetch phase reads
 * it straight from disk via the `registry:<subject>` canonical. Fingerprint is the
 * same CIP-14 function so keys line up with the wallet.
 *
 * Does NOT clobber existing CIP-25 NFT rows (ON CONFLICT DO NOTHING).
 *
 * Usage: bun run ingest-registry.ts <registry-dir> <assets.db>
 */
import {readdirSync} from 'node:fs'
import {Database} from 'bun:sqlite'
import {assetFingerprint} from './vendor/asset-fingerprint.js'

const [, , regDir = '../data/token-registry', dbPath = '../data/assets.db'] = process.argv
const mapDir = `${regDir}/mappings`
const db = new Database(dbPath)

const ins = db.prepare(`
  INSERT INTO asset (fingerprint, policy_id, asset_name_hex, kind, cip_class, mint_slot, mint_tx,
                     image_raw, canonical, source_uris, scheme, declared_mime, name_match)
  VALUES ($fp,$pol,$name,'ft-logo','registry',0,NULL,$img,$canon,$uris,'data-registry',NULL,'subject')
  ON CONFLICT(fingerprint) DO NOTHING
`)

const files = readdirSync(mapDir).filter((f) => f.endsWith('.json'))
let seen = 0,
  withLogo = 0,
  inserted = 0,
  badSubject = 0
const HEX = /^[0-9a-f]*$/i
const tx = db.transaction((rows: any[]) => {
  for (const r of rows) inserted += ins.run(r).changes
})
let batch: any[] = []

for (const f of files) {
  seen++
  let j: any
  try {
    j = JSON.parse(require('node:fs').readFileSync(`${mapDir}/${f}`, 'utf8'))
  } catch {
    continue
  }
  const subject: string = j.subject ?? f.replace(/\.json$/, '')
  if (subject.length < 56 || !HEX.test(subject)) {
    badSubject++
    continue
  }
  const pol = subject.slice(0, 56).toLowerCase()
  const nameHex = subject.slice(56).toLowerCase()
  const logo = j.logo?.value
  if (typeof logo !== 'string' || logo.length === 0) continue
  withLogo++
  const fp = assetFingerprint(`${pol}.${nameHex}`)
  if (fp === null) continue
  const canon = `registry:${subject}`
  batch.push({
    $fp: fp,
    $pol: pol,
    $name: nameHex,
    $img: canon,
    $canon: canon,
    $uris: JSON.stringify([canon]),
  })
  if (batch.length >= 1000) {
    tx(batch)
    batch = []
  }
}
if (batch.length) tx(batch)

console.log(JSON.stringify({registry_files: seen, with_logo: withLogo, bad_subject: badSubject, ft_logo_inserted: inserted}, null, 2))
db.close()
