/**
 * Emit manifest.jsonl — one row per asset, per the output contract. Generated from
 * assets.db, so it reflects whatever the fetch phase has completed so far.
 *
 * Usage: bun run manifest.ts <assets.db> <manifest.jsonl>
 */
import {Database} from 'bun:sqlite'
import {createWriteStream} from 'node:fs'

const [, , dbPath = '../data/assets.db', outPath = '../manifest.jsonl'] = process.argv
const db = new Database(dbPath)
const out = createWriteStream(outPath)

const stmt = db.query(`SELECT fingerprint, policy_id, asset_name_hex, kind, cip_class, mint_slot,
  source_uris, resolved_via, src_mime, src_bytes, out_bytes, sha256, status, attempts, last_error
  FROM asset`)

let n = 0
for (const r of stmt.iterate() as any) {
  const row = {
    policyId: r.policy_id,
    assetNameHex: r.asset_name_hex,
    fingerprint: r.fingerprint,
    kind: r.kind,
    cipClass: r.cip_class,
    objectKey: r.status === 'ok' ? `media/${r.fingerprint}/720.webp` : null,
    sourceUris: JSON.parse(r.source_uris ?? '[]'),
    resolvedVia: r.resolved_via ?? null,
    srcMime: r.src_mime ?? null,
    srcBytes: r.src_bytes ?? null,
    outBytes: r.out_bytes ?? null,
    sha256: r.sha256 ?? null,
    status: r.status ?? 'pending',
    attempts: r.attempts ?? 0,
    lastError: r.last_error ?? null,
    mintSlot: r.mint_slot,
  }
  out.write(JSON.stringify(row) + '\n')
  n++
}
out.end()
console.log(JSON.stringify({rows: n, manifest: outPath}))
db.close()
