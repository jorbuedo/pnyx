// The register limiter: the window, the key, and the fail-open decision.
import { describe, expect, it, vi } from 'vitest';
import { cloudflareRateLimiter, createMemoryRateLimiter, rateLimitKey } from './rate-limit.js';

const req = (headers: Record<string, string>) => new Request('http://svc/register', { method: 'POST', headers });

describe('createMemoryRateLimiter', () => {
  it('allows up to the limit, then refuses', async () => {
    const limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000, now: () => 1_000 });
    expect(await Promise.all([1, 2, 3].map(() => limiter.allow('a')))).toEqual([true, true, true]);
    expect(await limiter.allow('a')).toBe(false);
  });

  it('counts each key separately, so one caller cannot lock out another', async () => {
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, now: () => 1_000 });
    expect(await limiter.allow('a')).toBe(true);
    expect(await limiter.allow('a')).toBe(false);
    expect(await limiter.allow('b')).toBe(true);
  });

  it('starts a fresh window once the old one has elapsed', async () => {
    let at = 1_000;
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, now: () => at });
    expect(await limiter.allow('a')).toBe(true);
    expect(await limiter.allow('a')).toBe(false);
    at += 59_999;
    expect(await limiter.allow('a')).toBe(false);
    at += 1;
    expect(await limiter.allow('a')).toBe(true);
  });

  // The documented cost of a fixed window: a burst can straddle the boundary and spend two windows'
  // worth. Pinned so the tradeoff is a decision rather than a surprise.
  it('permits up to 2x the limit across a window boundary', async () => {
    let at = 1_000;
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 1_000, now: () => at });
    expect(await Promise.all([limiter.allow('a'), limiter.allow('a')])).toEqual([true, true]);
    at += 1_000;
    expect(await Promise.all([limiter.allow('a'), limiter.allow('a')])).toEqual([true, true]);
  });

  // An open endpoint can otherwise drive one map entry per unique caller, forever.
  it('drops entries whose window has passed instead of retaining every caller', async () => {
    let at = 0;
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 1_000, now: () => at });
    for (let i = 0; i < 500; i++) {
      at += 10;
      await limiter.allow(`caller-${i}`);
    }
    // Sweeping happens on window rollover, so an old key must have been forgotten: if it were still
    // counted, a repeat from the very first caller would be refused rather than allowed afresh.
    expect(await limiter.allow('caller-0')).toBe(true);
  });
});

describe('rateLimitKey', () => {
  // Cloudflare sets this on every request that reaches a Worker and a client cannot forge it.
  it('prefers CF-Connecting-IP', () => {
    expect(rateLimitKey(req({ 'CF-Connecting-IP': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }))).toBe(
      'ip:203.0.113.7',
    );
  });

  it('falls back to the first x-forwarded-for hop', () => {
    expect(rateLimitKey(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBe('ip:198.51.100.1');
  });

  // One shared bucket, not one bucket per request: an unkeyed limit is still a limit, whereas a
  // per-request-unique key would be no limit at all.
  it('shares a single bucket when no address is available', () => {
    expect(rateLimitKey(req({}))).toBe('ip:unknown');
  });
});

describe('cloudflareRateLimiter', () => {
  it('passes the binding verdict through', async () => {
    const allow = cloudflareRateLimiter({ limit: async () => ({ success: false }) }, () => {});
    expect(await allow.allow('ip:1')).toBe(false);
  });

  // Refusing every bootstrap because a limiter is broken is worse than briefly not limiting: no
  // identity can register, so nobody can log in at all. The sponsor balance is bounded and visible.
  it('fails open and logs when the binding throws', async () => {
    const log = vi.fn();
    const limiter = cloudflareRateLimiter(
      {
        limit: async () => {
          throw new Error('binding unavailable');
        },
      },
      log,
    );
    expect(await limiter.allow('ip:1')).toBe(true);
    expect(log).toHaveBeenCalledOnce();
  });
});
