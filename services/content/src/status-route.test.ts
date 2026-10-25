// `GET /status` through the real handler, not just the pieces behind it: the wiring is the part that
// breaks, and a probe that is never reached passes its unit tests forever.
import { describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import type { SponsorLink } from './sponsor-client.js';
import { type ContentStore, createContentStore } from './store.js';

const TOKEN = 'shared-secret';

const buildOrigin = async (options: { store: ContentStore; sponsorLink?: SponsorLink }) => {
  const keys = await createJwtKeys();
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
    store: options.store,
    devAuth: true,
    chain: disabledChainMirror,
    notify: createNotifier(options.store, loggingPushSender(() => {}), () => {}),
    ...(options.sponsorLink === undefined ? {} : { sponsorLink: options.sponsorLink }),
  });
};

const sponsorAnswering = (body: unknown, status = 200): SponsorLink => ({
  url: 'https://sponsor.internal',
  token: TOKEN,
  fetchImpl: (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch,
});

const get = (accept?: string) =>
  new Request('https://origin.test/status', accept === undefined ? undefined : { headers: { accept } });

describe('GET /status', () => {
  it('reaches the sponsor with the bearer token and reports its verdict', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const origin = await buildOrigin({
      store: createContentStore(),
      sponsorLink: {
        url: 'https://sponsor.internal/',
        token: TOKEN,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push({
            url: String(input),
            auth: new Headers(init?.headers).get('authorization'),
          });
          return new Response(JSON.stringify({ status: 'ok', reasons: [] }), {
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
    });

    const res = await origin(get());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; components: Record<string, { state: string }> };
    // The chain plane is off in this composition, so `degraded` is the correct roll-up even though the
    // sponsor is fine — which is the whole point of taking the worst component.
    expect(body.components.sponsor?.state).toBe('ok');
    expect(body.components.store?.state).toBe('ok');
    expect(body.components.chain?.state).toBe('degraded');
    expect(body.status).toBe('degraded');
    // The trailing slash on the configured URL must not produce `//status`.
    expect(seen).toEqual([{ url: 'https://sponsor.internal/status', auth: `Bearer ${TOKEN}` }]);
  });

  it('still answers when the sponsor is unreachable — that is why the aggregate lives on the origin', async () => {
    const origin = await buildOrigin({
      store: createContentStore(),
      sponsorLink: {
        url: 'https://sponsor.internal',
        token: TOKEN,
        fetchImpl: (async () => {
          throw new Error('connect ECONNREFUSED');
        }) as typeof fetch,
      },
    });

    const res = await origin(get());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; components: Record<string, { detail: string }> };
    expect(body.status).toBe('failing');
    expect(body.components.sponsor?.detail).toContain('unreachable');
  });

  it('does not report a syncing sponsor as failing', async () => {
    const origin = await buildOrigin({
      store: createContentStore(),
      sponsorLink: sponsorAnswering({ status: 'starting', reasons: ['wallet is syncing'] }, 503),
    });
    const body = (await (await origin(get())).json()) as { components: Record<string, { state: string }> };
    expect(body.components.sponsor?.state).toBe('starting');
  });

  it('renders HTML for a browser and JSON for a checker', async () => {
    const origin = await buildOrigin({ store: createContentStore() });

    const page = await origin(get('text/html,application/xhtml+xml'));
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Pnyx status');

    const json = await origin(get('application/json'));
    expect(json.headers.get('content-type')).toContain('application/json');
  });

  // A deployment with no sponsor is a real composition, and the page must not cry outage over it.
  it('reports an unconfigured sponsor as unknown, not failing', async () => {
    const origin = await buildOrigin({ store: createContentStore() });
    const body = (await (await origin(get())).json()) as { components: Record<string, { state: string }> };
    expect(body.components.sponsor?.state).toBe('unknown');
  });

  it('needs no authentication — it carries states and reasons, never balances', async () => {
    const origin = await buildOrigin({ store: createContentStore() });
    expect((await origin(get())).status).not.toBe(401);
  });
});
