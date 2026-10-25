// Rate limiting for the one route that costs money.
//
// `POST /register` is deliberately unauthenticated — it is what bootstraps authentication, so there
// is no session to require yet (routes.ts). The body is a *proven* transaction the service cannot
// author, so nobody can forge a row this way; what they can do is make the sponsor wallet pay DUST to
// submit transactions, which the route's own comment calls "ordinary rate-limiting territory". That
// holds right up until the endpoint is on a public origin with a funded wallet behind it.
//
// Two implementations behind one port, because the handler runs in both runtimes: Cloudflare's rate
// limiting binding on the Worker, and an in-process window for the Node server. The Node one is not a
// placeholder — a self-hosted instance must not be open merely because it is not on Cloudflare.

export type RateLimiter = {
  /** `true` when the caller may proceed. Never throws: a limiter outage must not deny a bootstrap. */
  allow(key: string): Promise<boolean>;
};

/** No limiting. For tests that are asserting something else. */
export const noRateLimit: RateLimiter = { allow: async () => true };

/**
 * A fixed-window counter held in memory.
 *
 * Fixed rather than sliding on purpose: a sliding window needs per-request timestamps, and this
 * guards a route that legitimately fires once or twice per identity ever. The cost of the cruder
 * shape is that a caller can spend two windows' worth across a boundary, which for "5 per minute"
 * means at most 10 in a burst — irrelevant against a DUST drain, and it keeps the memory O(keys)
 * rather than O(requests).
 *
 * Keys expire lazily: a swept entry is one that has not been seen for a full window, so an idle
 * process does not retain the last hour of IPs.
 */
export const createMemoryRateLimiter = (options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): RateLimiter => {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; startedAt: number }>();
  return {
    allow: async (key: string) => {
      const at = now();
      const current = windows.get(key);
      if (current === undefined || at - current.startedAt >= options.windowMs) {
        // Sweep while we are here: without it a long-lived process accumulates one entry per unique
        // caller forever, which is a slow memory leak an open endpoint can drive.
        for (const [k, w] of windows) {
          if (at - w.startedAt >= options.windowMs) windows.delete(k);
        }
        windows.set(key, { count: 1, startedAt: at });
        return true;
      }
      if (current.count >= options.limit) return false;
      current.count += 1;
      return true;
    },
  };
};

/** Cloudflare's rate limiting binding (`ratelimits` in wrangler config). */
export type CloudflareRateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/**
 * Wrap the Worker binding.
 *
 * **Fails open.** If the binding errors, a new user cannot register and therefore cannot log in at
 * all — refusing the bootstrap of every identity is a worse outcome than briefly not limiting one
 * route, and the sponsor's balance is a visible, bounded quantity while a broken sign-up is not.
 */
export const cloudflareRateLimiter = (
  binding: CloudflareRateLimiter,
  log: (message: string) => void,
): RateLimiter => ({
  allow: async (key: string) => {
    try {
      const { success } = await binding.limit({ key });
      return success;
    } catch (error) {
      log(`rate limiter unavailable, allowing: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
  },
});

/**
 * The bucket a request counts against.
 *
 * `CF-Connecting-IP` is set by Cloudflare on every request that reaches a Worker and cannot be
 * spoofed by the client; `x-forwarded-for` can be, so it is only consulted for the self-hosted shape
 * where something in front of the Node server sets it. When neither is present every caller shares
 * one bucket — deliberately the conservative direction: an unkeyed limit is still a limit, whereas
 * per-request-unique keys would be none at all.
 */
export const rateLimitKey = (request: Request): string => {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf !== null && cf !== '') return `ip:${cf}`;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded !== '') return `ip:${forwarded}`;
  return 'ip:unknown';
};
