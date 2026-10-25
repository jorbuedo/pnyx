import { describe, expect, it } from 'vitest';
import { chainProbe, sponsorProbe, storeProbe } from './status-probes.js';

const link = (fetchImpl: typeof fetch) => ({ url: 'https://sponsor.example/', token: 'secret', fetchImpl });
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sponsorProbe', () => {
  it('passes the sponsor\'s own verdict and reasons through', async () => {
    const probe = sponsorProbe(
      link((async () => respond({ status: 'degraded', reasons: ['dust section behind by 12'] })) as typeof fetch),
    );
    const result = await probe();
    expect(result.state).toBe('degraded');
    expect(result.detail).toBe('dust section behind by 12');
  });

  // The sponsor answers 503 while its wallet syncs, with a perfectly good body. Reading the HTTP status
  // instead of the body would report a normal 34-minute cold sync as an outage.
  it('reads the body, not the HTTP status, so a syncing wallet is not an outage', async () => {
    const probe = sponsorProbe(
      link((async () => respond({ status: 'starting', reasons: ['wallet is syncing'] }, 503)) as typeof fetch),
    );
    expect((await probe()).state).toBe('starting');
  });

  it('reports a network error as failing, distinctly from starting', async () => {
    const probe = sponsorProbe(
      link((async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch),
    );
    const result = await probe();
    expect(result.state).toBe('failing');
    expect(result.detail).toContain('unreachable');
  });

  // Observed 2026-08-25: a cold DUST rebuild pins the sponsor's single thread and its HTTP port
  // starves, so this subrequest never settled and the whole public /status returned nothing for
  // minutes. A health page must not go quiet exactly when its subject is in trouble.
  it('reports a timeout distinctly, rather than hanging with the sponsor', async () => {
    const probe = sponsorProbe(
      link((async () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }) as typeof fetch),
    );
    const result = await probe();
    expect(result.state).toBe('failing');
    // Not "unreachable": the box is up and busy, which is what a long rebuild looks like from here.
    expect(result.detail).toContain('did not answer within');
  });

  it('calls out a rejected token, which looks like an outage but is a deploy mistake', async () => {
    const probe = sponsorProbe(link((async () => respond({ error: 'unauthorized' }, 401)) as typeof fetch));
    expect(await probe()).toMatchObject({ state: 'failing', detail: 'sponsor rejected our token' });
  });

  it('refuses to trust an unrecognisable status rather than passing it through', async () => {
    const probe = sponsorProbe(link((async () => respond({ status: 'fine' })) as typeof fetch));
    expect((await probe()).state).toBe('failing');
  });

  // A deployment with no sponsor is a real composition, not a broken one.
  it('is unknown — not failing — when no sponsor is configured', async () => {
    expect((await sponsorProbe(undefined)()).state).toBe('unknown');
  });

  // Caught on the first deploy, not by these tests: the probe passed the sponsor's whole body through
  // and the origin serves it unauthenticated, so the DUST and NIGHT balances were public for ~3 minutes.
  it('never carries the sponsor body onward — the origin endpoint has no authentication', async () => {
    const probe = sponsorProbe(
      link((async () =>
        respond({
          status: 'ok',
          reasons: [],
          wallet: { balances: { dust: '21808505735000000000', night: '6000000000' } },
        })) as typeof fetch),
    );
    const serialised = JSON.stringify(await probe());
    expect(serialised).not.toContain('21808505735000000000');
    expect(serialised).not.toContain('balances');
  });
});

describe('storeProbe', () => {
  it('is ok when the binding answers', async () => {
    const result = await storeProbe({ listCircles: async () => [{}, {}] as never })();
    expect(result).toMatchObject({ state: 'ok', detail: 'binding answers' });
  });

  // Circles can be private and this page is public, so the count must not appear in the detail.
  it('does not publish how many circles exist', async () => {
    const result = await storeProbe({ listCircles: async () => Array.from({ length: 7 }) as never })();
    expect(result.detail).not.toContain('7');
  });

  it('is failing when the read throws', async () => {
    const result = await storeProbe({
      listCircles: async () => {
        throw new Error('D1_ERROR');
      },
    })();
    expect(result.state).toBe('failing');
    expect(result.detail).toContain('D1_ERROR');
  });
});

describe('chainProbe', () => {
  it('is degraded, not failing, when the chain plane is off', async () => {
    expect((await chainProbe({ enabled: false })()).state).toBe('degraded');
  });

  it('is degraded when enabled without an identity template', async () => {
    expect((await chainProbe({ enabled: true })()).state).toBe('degraded');
  });

  it('is ok when enabled and configured', async () => {
    const result = await chainProbe({ enabled: true, identityCodeDigest: '3353f472500686e5' })();
    expect(result.state).toBe('ok');
    // The template, not a deployment: there is no single identity address to report any more.
    expect(result.detail).toContain('identity template');
  });
});

// Three networks behind one host. What matters is that the networks which are *fine* appear too: a
// report listing only problems reads the same as a host that has quietly stopped serving a network,
// which is how "the sponsor is ok" hid a preview outage on 2026-08-28.
describe('sponsorProbe with a multi-network host', () => {
  const link = (body: unknown, status = 200) => ({
    url: 'https://sponsor.internal',
    token: 't',
    fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
  });

  it('names every network and its own word', async () => {
    const component = await sponsorProbe(
      link({
        status: 'ok',
        reasons: [],
        networks: { preview: { status: 'ok' }, preprod: { status: 'ok' }, mainnet: { status: 'starting' } },
      }),
    )();
    expect(component.state).toBe('ok');
    expect(component.detail).toBe('preview ok, preprod ok, mainnet starting');
  });

  it('keeps the per-network reasons beside the summary', async () => {
    const component = await sponsorProbe(
      link({
        status: 'degraded',
        reasons: ['mainnet: DUST is exhausted; every sponsorship will fail'],
        networks: { preprod: { status: 'ok' }, mainnet: { status: 'failing' } },
      }),
    )();
    expect(component.state).toBe('degraded');
    expect(component.detail).toBe('preprod ok, mainnet failing; mainnet: DUST is exhausted; every sponsorship will fail');
  });

  // A single-network host has no `networks` field, and must keep reporting exactly as it did.
  it('summarises nothing for a host that serves one network', async () => {
    const component = await sponsorProbe(link({ status: 'ok', reasons: [] }))();
    expect(component.detail).toBeNull();
  });

  it('says `unknown` for a network whose report it cannot read, rather than dropping it', async () => {
    const component = await sponsorProbe(
      link({ status: 'degraded', reasons: [], networks: { preview: null, mainnet: { status: 5 } } }),
    )();
    expect(component.detail).toBe('preview unknown, mainnet unknown');
  });
});
