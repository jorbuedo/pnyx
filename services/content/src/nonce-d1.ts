// D1-backed single-use nonce store for the Worker (migration 0002_nonces.sql).
// Strong consistency across isolates; single-use via delete-on-consume; TTL via
// issued_at + opportunistic prune. Satisfies the async NonceStore contract.
import type { D1Database } from '@cloudflare/workers-types';
import type { NonceStore } from './nonce.js';

export const createD1NonceStore = (db: D1Database, options?: { ttlMs?: number }): NonceStore => {
  const ttlMs = options?.ttlMs ?? 5 * 60_000;
  const random = () => crypto.randomUUID().replaceAll('-', '');
  return {
    issue: async () => {
      const now = Date.now();
      await db.prepare('DELETE FROM nonces WHERE issued_at < ?').bind(now - ttlMs).run();
      const nonce = random();
      await db.prepare('INSERT INTO nonces (nonce, issued_at) VALUES (?, ?)').bind(nonce, now).run();
      return nonce;
    },
    consume: async (nonce) => {
      // Atomic single-use: the DELETE both checks existence and removes it.
      const row = await db
        .prepare('DELETE FROM nonces WHERE nonce = ? RETURNING issued_at')
        .bind(nonce)
        .first<{ issued_at: number }>();
      if (!row) return false;
      return Date.now() - row.issued_at < ttlMs;
    },
  };
};
