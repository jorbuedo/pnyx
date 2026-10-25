// Worker-native backends for the bug-report ports: R2 for the blob, D1 for the index, the
// pure-ts COSE core for the signature, and `DecompressionStream` for reading the manifest.
//
// Split from `bug-report.ts` so the decision path stays testable without a Worker runtime —
// the same reason `nonce-d1.ts` sits beside `nonce.ts`.

import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import {AddressHex} from '@evolution-sdk/review/Brands'
import * as Cose from '@evolution-sdk/review/Cose';
import { Effect } from 'effect';
import { type BugReportPorts, NONCE_RETENTION_MS } from './bug-report.js';
import { coseSign1PayloadIs } from './cose-payload.js';

const fromHex = (hex: string): Uint8Array => {
  // An odd-length or non-hex string is a malformed request, not a crash: return empty and let
  // the verifier refuse it. Throwing here would turn a bad header into a 500 we get paged for.
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Gunzip and parse the manifest.
 *
 * Returns `null` for anything unreadable — not gzip, not JSON, not an object. The caller keeps
 * the blob regardless; this only decides whether the index gets populated.
 */
const readManifest = async (body: Uint8Array): Promise<Record<string, unknown> | null> => {
  try {
    const stream = new Response(body.slice()).body?.pipeThrough(new DecompressionStream('gzip'));
    if (stream === undefined) return null;
    const text = await new Response(stream).text();
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    // Never silent: "the report was unreadable" and "we forgot to read it" produce the same
    // empty row, and only one of them is a bug in this file.
    console.log(`[bug-report] manifest unreadable, keeping the blob: ${String(error)}`);
    return null;
  }
};

/**
 * Claim a client-minted nonce.
 *
 * `INSERT` + primary-key conflict is the check: one statement that both tests for a repeat and
 * records the new one, so two isolates racing the same nonce cannot both win. A read-then-write
 * would have exactly that hole.
 */
const claimNonce = (db: D1Database) => async (nonce: string, nowMs: number): Promise<boolean> => {
  // Opportunistic prune, before the insert, so the table is bounded by the retention window
  // rather than by how often anyone remembers to sweep it.
  await db
    .prepare('DELETE FROM bug_report_nonces WHERE seen_at_ms < ?')
    .bind(nowMs - NONCE_RETENTION_MS)
    .run();
  const row = await db
    .prepare('INSERT OR IGNORE INTO bug_report_nonces (nonce, seen_at_ms) VALUES (?, ?) RETURNING nonce')
    .bind(nonce, nowMs)
    .first<{ nonce: string }>();
  // `INSERT OR IGNORE` returns no row when the nonce was already present, which is the replay.
  return row !== null && row !== undefined;
};

export const createBugReportPorts = (deps: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
}): BugReportPorts => ({
  verify: async ({ signatureHex, keyHex, addressHex, expectedPayload }) => {
    // ⚠️ **Content first, and both checks or neither.** The cheap comparison rejects a
    // cross-protocol replay — a Koios or SteelSwap signature from the same identity key —
    // before any ed25519 maths runs, and it is the half `Cose.verifyDataForAddress` does not
    // do. Passing only the second check would accept any signature that address ever made.
    if (!coseSign1PayloadIs(fromHex(signatureHex), expectedPayload)) return false;
    // `verifyDataForAddress`, never `verifyData`: this is an authentication decision, so the
    // key→address binding is mandatory rather than skipped when the header omits a claim.
    return Effect.runPromise(
      // The address the CLIENT claims to control; P1 inside `verifyDataForAddress` is what
      // tests that claim against the key, so the brand asserts only its form here.
      Cose.verifyDataForAddress({ signature: signatureHex, key: keyHex }, AddressHex(addressHex)).pipe(
        Effect.catchAll((error) => {
          // A malformed signature is an ordinary bad request; log it and refuse, never throw
          // into the route.
          console.log(`[bug-report] signature could not be parsed: ${String(error)}`);
          return Effect.succeed(false);
        }),
      ),
    );
  },
  claimNonce: claimNonce(deps.db),
  putBlob: async (key, body) => {
    await deps.bucket.put(key, body.slice() as unknown as ArrayBuffer, {
      httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    });
  },
  insertRow: async (row) => {
    await deps.db
      .prepare(
        `INSERT INTO bug_reports
           (id, r2_key, address, identity, description, app_version, platform, size_bytes, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.r2Key,
        row.address,
        row.identity,
        row.description,
        row.appVersion,
        row.platform,
        row.sizeBytes,
        row.createdAtMs,
      )
      .run();
  },
  readManifest,
  now: () => Date.now(),
  reportId: () => crypto.randomUUID(),
});
