// Single-use login nonces with TTL. The interface is async so a Worker (multi-isolate)
// can back it with shared storage (D1, see nonce-d1.ts) — the /auth/nonce and /auth/identity
// requests can land on different isolates, so an in-memory Map is only correct for the
// single-process Node server. Both backends satisfy this contract.

export type NonceStore = {
  issue(): Promise<string>;
  /** Consumes the nonce — a second call with the same value resolves false (replay). */
  consume(nonce: string): Promise<boolean>;
};

export const createNonceStore = (options?: { ttlMs?: number; now?: () => number; random?: () => string }): NonceStore => {
  const ttlMs = options?.ttlMs ?? 5 * 60_000;
  const now = options?.now ?? Date.now;
  const random = options?.random ?? (() => crypto.randomUUID().replaceAll('-', ''));
  const issued = new Map<string, number>();

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [nonce, at] of issued) {
      if (at < cutoff) {
        issued.delete(nonce);
      }
    }
  };

  return {
    issue: async () => {
      prune();
      const nonce = random();
      issued.set(nonce, now());
      return nonce;
    },
    consume: async (nonce) => {
      prune();
      if (!issued.has(nonce)) {
        return false;
      }
      issued.delete(nonce);
      return true;
    },
  };
};
