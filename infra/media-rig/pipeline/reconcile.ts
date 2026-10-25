/**
 * Reconcile raw CIP-25 (label 721) metadata records → a deduped, fingerprinted
 * asset→media table in SQLite. Handles the 721 shape traps:
 *  - policy/assetName keys as text OR bytes (junk int keys skipped)
 *  - assetName raw-vs-hex, disambiguated against the tx's actual mints (ground truth)
 *  - image as string OR array-of-strings (CIP-25 chunks >64 bytes) → concatenated
 *  - files[] fallback when no top-level image (tolerant of non-standard src/mType keys)
 * Latest mint slot wins per asset. Fingerprint = wallet's vendored CIP-14 function.
 *
 * Usage: bun run reconcile.ts <meta721.jsonl> <out.db> [limitLines]
 */
import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'
import {Database} from 'bun:sqlite'
import {assetFingerprint} from './vendor/asset-fingerprint.js'
import {resolve} from './uri.js'

// ---- tagged-Metadatum helpers -------------------------------------------------
type MD =
  | {int: string}
  | {bytes: string}
  | {text: string}
  | {arr: MD[]}
  | {map: [MD, MD][]}

const asText = (m: MD | undefined): string | null =>
  m && 'text' in m ? m.text : null
/** A metadatum used as a key/string: text as-is, bytes as hex. */
const keyStr = (m: MD | undefined): string | null =>
  m == null ? null : 'text' in m ? m.text : 'bytes' in m ? m.bytes.toLowerCase() : null
const mapEntries = (m: MD | undefined): [MD, MD][] =>
  m && 'map' in m ? m.map : []
/** Look up a text-keyed field in a metadatum map. */
const field = (m: MD | undefined, key: string): MD | undefined => {
  for (const [k, v] of mapEntries(m)) if (asText(k) === key) return v
  return undefined
}
/** Resolve a CIP-25 string value: text, or array-of-text concatenated (chunked >64b). */
const concatStr = (m: MD | undefined): string | null => {
  if (m == null) return null
  if ('text' in m) return m.text
  if ('arr' in m) {
    const parts = m.arr.map((x) => ('text' in x ? x.text : 'bytes' in x ? x.bytes : null))
    if (parts.some((p) => p === null)) return null
    return parts.join('')
  }
  return null
}

const HEX_RE = /^[0-9a-fA-F]*$/
const utf8 = new TextEncoder()
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Candidate on-chain asset-name hexes for a metadata key, most-likely first. */
const nameHexCandidates = (keyNode: MD): string[] => {
  if ('bytes' in keyNode) return [keyNode.bytes.toLowerCase()]
  if ('text' in keyNode) {
    const t = keyNode.text
    const cands: string[] = []
    if (t.length % 2 === 0 && HEX_RE.test(t)) cands.push(t.toLowerCase()) // already-hex convention
    cands.push(toHex(utf8.encode(t))) // raw-name convention
    return [...new Set(cands)]
  }
  return []
}

// ---- URI extraction + scheme classification ----------------------------------
/** Pull the best media URI from a per-asset CIP-25 field map. Returns ordered candidates. */
const mediaUris = (fields: MD | undefined): string[] => {
  const out: string[] = []
  const img = concatStr(field(fields, 'image'))
  if (img && img.trim()) out.push(img.trim())
  // files[] fallback — tolerate standard (src/mediaType) and common non-standard keys
  const files = field(fields, 'files')
  if (files && 'arr' in files) {
    for (const f of files.arr) {
      const mt = asText(field(f, 'mediaType')) ?? asText(field(f, 'mType')) ?? asText(field(f, 'type')) ?? ''
      const src =
        concatStr(field(f, 'src')) ?? concatStr(field(f, 'file')) ?? concatStr(field(f, 'uri'))
      if (src && src.trim() && (mt === '' || mt.startsWith('image') || mt.startsWith('img'))) {
        const s = src.trim()
        if (!out.includes(s)) out.push(s)
      }
    }
  }
  return out
}

// ---- CIP-67 name-prefix class -------------------------------------------------
const cip67 = (nameHex: string): string => {
  const p = nameHex.slice(0, 8).toLowerCase()
  if (p === '000643b0') return 'cip68-ref100'
  if (p === '000de140') return 'cip68-nft222'
  if (p === '0014df10') return 'cip68-ft333'
  if (p === '001bc280') return 'cip68-rft444'
  return 'plain'
}

// ---- main ---------------------------------------------------------------------
const [, , inPath = '../data/meta721.jsonl', outPath = '../data/assets.db', limitArg] = process.argv
const limit = limitArg ? Number(limitArg) : Infinity

const db = new Database(outPath)
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
db.exec(`CREATE TABLE IF NOT EXISTS asset (
  fingerprint TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL, asset_name_hex TEXT NOT NULL,
  kind TEXT NOT NULL, cip_class TEXT NOT NULL,
  mint_slot INTEGER NOT NULL, mint_tx TEXT,
  image_raw TEXT, canonical TEXT, source_uris TEXT NOT NULL, scheme TEXT,
  declared_mime TEXT, name_match TEXT,
  status TEXT DEFAULT 'pending', resolved_via TEXT, src_mime TEXT,
  src_bytes INTEGER, out_bytes INTEGER, sha256 TEXT,
  attempts INTEGER DEFAULT 0, last_error TEXT
)`)

const upsert = db.prepare(`
  INSERT INTO asset (fingerprint, policy_id, asset_name_hex, kind, cip_class, mint_slot, mint_tx,
                     image_raw, canonical, source_uris, scheme, declared_mime, name_match)
  VALUES ($fp,$pol,$name,$kind,$cip,$slot,$tx,$img,$canon,$uris,$scheme,$mime,$nm)
  ON CONFLICT(fingerprint) DO UPDATE SET
    policy_id=$pol, asset_name_hex=$name, cip_class=$cip, mint_slot=$slot, mint_tx=$tx,
    image_raw=$img, canonical=$canon, source_uris=$uris, scheme=$scheme, declared_mime=$mime, name_match=$nm
  WHERE excluded.mint_slot > asset.mint_slot
`)

const rl = createInterface({input: createReadStream(inPath), crlfDelay: Infinity})
let lines = 0,
  emitted = 0,
  noMedia = 0,
  unmatchedName = 0,
  matched1to1 = 0
const tx = db.transaction((rows: any[]) => {
  for (const r of rows) upsert.run(r)
})
let batch: any[] = []

const flush = () => {
  if (batch.length) {
    tx(batch)
    batch = []
  }
}

for await (const line of rl) {
  if (!line) continue
  lines++
  if (lines > limit) break
  let rec: {slot: number; tx: string; mints: [string, string, number][]; m721: MD}
  try {
    rec = JSON.parse(line)
  } catch {
    continue
  }
  // ground-truth minted names grouped by policy
  const mintByPolicy = new Map<string, Set<string>>()
  for (const [pol, name] of rec.m721 && rec.mints ? rec.mints : []) {
    const key = pol.toLowerCase()
    if (!mintByPolicy.has(key)) mintByPolicy.set(key, new Set())
    mintByPolicy.get(key)!.add(name.toLowerCase())
  }

  for (const [pKey, pVal] of mapEntries(rec.m721)) {
    const policyId = keyStr(pKey)
    if (policyId === null || policyId.length !== 56 || !HEX_RE.test(policyId)) continue // skip version/copyright/junk
    const pol = policyId.toLowerCase()
    const minted = mintByPolicy.get(pol) ?? new Set<string>()
    const assetEntries = mapEntries(pVal)

    for (const [aKey, aVal] of assetEntries) {
      // resolve on-chain asset name hex
      const cands = nameHexCandidates(aKey)
      let nameHex: string | null = null
      let nameMatch = 'hex'
      for (const c of cands) {
        if (minted.has(c)) {
          nameHex = c
          break
        }
      }
      if (nameHex === null) {
        // 1:1 fallback: exactly one mint under policy and one metadata asset → associate
        if (minted.size === 1 && assetEntries.length === 1) {
          nameHex = [...minted][0]
          nameMatch = 'one-to-one'
          matched1to1++
        } else {
          // last resort: take the most-likely candidate even without a mint match
          nameHex = cands[0] ?? null
          nameMatch = 'unverified'
          unmatchedName++
        }
      }
      if (nameHex === null) continue

      const uris = mediaUris(aVal)
      if (uris.length === 0) {
        noMedia++
        continue
      }
      const assetId = `${pol}.${nameHex}`
      const fp = assetFingerprint(assetId)
      if (fp === null) continue
      const declaredMime =
        asText(field(aVal, 'mediaType')) ?? asText(field(aVal, 'mType')) ?? null
      // pick the primary among candidates: first that resolves to a fetchable scheme
      let primary = uris[0]
      let res = resolve(primary)
      if (res.scheme === 'none' || res.scheme === 'other') {
        for (const u of uris.slice(1)) {
          const r = resolve(u)
          if (r.scheme !== 'none' && r.scheme !== 'other') {
            primary = u
            res = r
            break
          }
        }
      }
      batch.push({
        $fp: fp,
        $pol: pol,
        $name: nameHex,
        $kind: 'nft',
        $cip: cip67(nameHex),
        $slot: rec.slot,
        $tx: rec.tx,
        $img: primary,
        $canon: res.canonical,
        $uris: JSON.stringify(uris),
        $scheme: res.scheme,
        $mime: declaredMime,
        $nm: nameMatch,
      })
      emitted++
      if (batch.length >= 5000) flush()
    }
  }
  if (lines % 500000 === 0) {
    flush()
    const n = (db.query('SELECT COUNT(*) c FROM asset').get() as any).c
    process.stderr.write(`  ${lines} lines, ${emitted} entries, ${n} distinct assets\n`)
  }
}
flush()

const total = (db.query('SELECT COUNT(*) c FROM asset').get() as any).c
console.log(JSON.stringify({
  lines, emitted, distinct_assets: total,
  entries_no_media: noMedia, name_matched_1to1: matched1to1, name_unverified: unmatchedName,
}, null, 2))
db.close()
