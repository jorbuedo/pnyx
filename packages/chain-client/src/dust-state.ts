// Dust-section sync snapshots. The dust wallet is the only expensive cold sync (Preprod
// carries >1.2M dust ledger events — ~15 min even with large update batches), and
// wallet-sdk exposes serializeState()/restore() per wallet section. Persisting the
// serialized dust state lets the next boot resume from the snapshot's watermark instead
// of replaying the full event history.
import fs from 'node:fs'
import path from 'node:path'
import {gunzipSync, gzipSync} from 'node:zlib'

/**
 * Read a dust-state snapshot. Returns `null` when no snapshot exists (first boot).
 * Throws when the file exists but cannot be read or decompressed — the caller decides
 * whether a corrupt snapshot is fatal or a cold-sync fallback.
 */
export const loadDustState = (filePath: string): string | null => {
  if (!fs.existsSync(filePath)) {
    return null
  }
  return gunzipSync(fs.readFileSync(filePath)).toString('utf8')
}

/**
 * Write a dust-state snapshot: gzipped, owner-only, atomic (temp file + rename) so a
 * crash mid-write never leaves a truncated snapshot behind.
 */
export const storeDustState = (filePath: string, serialized: string): void => {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, {recursive: true})
  const tempFile = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`)
  fs.writeFileSync(tempFile, gzipSync(Buffer.from(serialized, 'utf8')), {mode: 0o600})
  fs.renameSync(tempFile, filePath)
}
