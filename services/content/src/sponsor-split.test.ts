// The split, wired end to end without a chain: origin → sponsor → report → origin's store.
//
// Each half has unit tests; what this covers is the seam between them, which is where a split
// deployment actually goes wrong — a ref that nobody settles, or a report the origin refuses. The two
// are connected by fetch stubs pointed at each other's handlers, so the request/response shapes are
// exercised rather than assumed to match.
import { describe, expect, it, vi } from 'vitest';
import { createJwtKeys } from './auth.js';
import type { ProvenSettlement } from './chain.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { callbackSettlementSink } from './sponsor-callback.js';
import { forwardingChainMirror } from './sponsor-client.js';
import { createSponsorQueue } from './sponsor.js';
import { type ContentStore, createContentStore } from './store.js';

const TOKEN = 'shared-secret';

/**
 * A circle's **contract address** — 32 bytes, 64 hex characters.
 *
 * ⚠️ This was `'4'` until 2026-09-08, left from when `chainId` was a sequential counter (which is
 * still why the column is `chain_seq_id`). Circles became one contract each, `chainId` became an
 * address, and the placeholder never moved — so this test kept passing against a route that capped
 * the field at 40 characters and silently dropped every real one.
 */
const CIRCLE_ADDRESS = 'ab'.repeat(32);

/** The origin: a real handler over a real store, with the forwarding mirror in place of a wallet. */
const buildOrigin = async (store: ContentStore, sponsorFetch: typeof fetch) => {
  const keys = await createJwtKeys();
  const chain = forwardingChainMirror({
    link: { url: 'https://sponsor.internal', token: TOKEN, fetchImpl: sponsorFetch },
    rowReads: true,
    identityRow: async () => undefined,
    store,
    log: () => {},
  });
  return createHandler({
    auth: {
      domain: 'pnyx.test',
      network: 'undeployed',
      nonces: createNonceStore(),
      jwt: {
        privateKey: keys.privateKey,
        kid: keys.kid,
        issuer: 'https://pnyx-content-service',
        audience: 'pnyx',
        ttlSeconds: 3600,
      },
    },
    publicJwk: keys.publicJwk,
    store,
    devAuth: true,
    chain,
    notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
    sponsorToken: TOKEN,
  });
};

describe('origin ↔ sponsor', () => {
  it('carries a device-proven settlement from the origin to the chain and back into the row', async () => {
    const store = createContentStore();
    const circle = await store.createCircle({
      name: 'C',
      description: '',
      subject: 'dev:owner',
      persona: 'owner',
      disclosed: true,
      isOpen: true,
    });

    // Deferred so the sponsor can call back into an origin that does not exist yet.
    let origin: (request: Request) => Promise<Response>;
    const sink = callbackSettlementSink({
      originUrl: 'https://origin.test',
      token: TOKEN,
      log: () => {},
      sleep: async () => {},
      fetchImpl: (async (url: string, init?: RequestInit) =>
        origin(new Request(url, init as RequestInit))) as unknown as typeof fetch,
    });
    const queue = createSponsorQueue({ submitProven: async () => ({ txId: 'tx-live', blockHeight: '1' }) }, sink, () => {});

    // The sponsor host's HTTP surface, reduced to what /internal/submit does.
    const sponsorFetch = (async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(String(init?.body)) as { settlement: ProvenSettlement; tx: string };
      expect(String(url)).toBe('https://sponsor.internal/internal/submit');
      expect(body.tx).toBe('AQI=');
      queue.submitProven(body.settlement, new Uint8Array([1, 2]));
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;

    origin = await buildOrigin(store, sponsorFetch);

    const login = await origin(
      new Request('http://svc/auth/dev', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'owner' }),
      }),
    );
    const { token } = (await login.json()) as { token: string };

    const submitted = await origin(
      new Request('http://svc/chain/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ tx: 'AQI=', ref: { kind: 'circle', circleId: circle.id, chainId: CIRCLE_ADDRESS } }),
      }),
    );
    expect(submitted.status).toBe(202);

    await queue.whenIdle();
    // The row the app reads was written by the origin, from the sponsor's report — not by the sponsor.
    await vi.waitFor(async () => {
      expect((await store.getCircle(circle.id))?.chain).toMatchObject({
        status: 'confirmed',
        txId: 'tx-live',
        chainId: CIRCLE_ADDRESS,
      });
    });
  });

  it('refuses a settlement report without the shared secret', async () => {
    const store = createContentStore();
    const origin = await buildOrigin(store, vi.fn() as unknown as typeof fetch);
    const res = await origin(
      new Request('http://svc/internal/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settlement: { kind: 'circle', circleId: 'c1' }, chain: { status: 'confirmed' } }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // A deployment with no sponsor must not accept ChainRef writes from anywhere at all.
  it('has no settle route when no sponsor is configured', async () => {
    const store = createContentStore();
    const keys = await createJwtKeys();
    const handler = createHandler({
      auth: {
        domain: 'pnyx.test',
        network: 'undeployed',
        nonces: createNonceStore(),
        jwt: {
          privateKey: keys.privateKey,
          issuer: 'https://pnyx-content-service',
          audience: 'pnyx',
          ttlSeconds: 3600,
        },
      },
      publicJwk: keys.publicJwk,
      store,
      devAuth: false,
      chain: disabledChainMirror,
      notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
    });
    const res = await handler(
      new Request('http://svc/internal/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
        body: JSON.stringify({ settlement: { kind: 'circle', circleId: 'c1' }, chain: { status: 'confirmed' } }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
