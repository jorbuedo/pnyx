// The origin side of the split: forwarding to the sponsor, and validating what comes back.
import { describe, expect, it, vi } from 'vitest';
import type { ProvenSettlement } from './chain.js';
import { applySettlement, forwardingChainMirror, parseSettlementReport } from './sponsor-client.js';
import { createContentStore } from './store.js';

const circle: ProvenSettlement = { kind: 'circle', circleId: 'c1', chainId: '7' };

const mirror = (fetchImpl: typeof fetch, log = () => {}) =>
  forwardingChainMirror({
    link: { url: 'https://sponsor.internal/', token: 'secret', fetchImpl },
    rowReads: true,
    identityRow: async () => undefined,
    store: createContentStore(),
    log,
  });

describe('forwardingChainMirror', () => {
  it('reports the chain plane as available for writes', () => {
    const m = mirror(vi.fn() as unknown as typeof fetch);
    // Unlike the read-only mirror it replaces: from the app's side registration and submit work.
    expect(m.enabled).toBe(true);
    expect(m.rowReads).toBe(true);
  });

  it('forwards a registration and accepts only 202', async () => {
    const ok = vi.fn(async (_url: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 202 }));
    await mirror(ok as unknown as typeof fetch).submitIdentityRow(new Uint8Array([1, 2, 3]));
    expect(ok.mock.calls[0]?.[0]).toBe('https://sponsor.internal/internal/register');
    const init = ok.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toEqual({ tx: 'AQID' });

    // ⚠️ A genuine sponsor failure answers `200 {ok:false}` on purpose — a 5xx from behind the tunnel
    // arrives with its body replaced (`sponsor-failure.ts`). Accepting must stay keyed on 202 alone,
    // or that shape turns a reported failure into a silent success.
    const failed = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: 'register failed: no DUST' }), { status: 200 }),
    );
    await expect(mirror(failed as unknown as typeof fetch).submitIdentityRow(new Uint8Array([1]))).rejects.toThrow(
      'sponsor rejected the registration: register failed: no DUST',
    );

    // And a body a tunnel rewrote still says more than its status.
    const rewritten = vi.fn(async () => new Response('<html>error code: 502</html>', { status: 502 }));
    await expect(mirror(rewritten as unknown as typeof fetch).submitIdentityRow(new Uint8Array([1]))).rejects.toThrow(
      'sponsor rejected the registration: <html>error code: 502</html>',
    );

    // The one case where the status really is all there is.
    const silent = vi.fn(async () => new Response('', { status: 502 }));
    await expect(mirror(silent as unknown as typeof fetch).submitIdentityRow(new Uint8Array([1]))).rejects.toThrow(
      'sponsor rejected the registration (502, no body)',
    );
  });

  // Correlation, not identity: it lets the Worker's log line and the sponsor's be joined without
  // matching wall-clock times, which is how a bare 502 was diagnosed by hand once already.
  it('carries the request id inward so both halves log the same value', async () => {
    const ok = vi.fn(async (_url: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 202 }));
    await mirror(ok as unknown as typeof fetch).submitIdentityRow(new Uint8Array([1]), {requestId: 'ray-123'});
    const headers = (ok.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-request-id']).toBe('ray-123');
  });

  it('sends no request-id header when there is none, rather than inventing one', async () => {
    const ok = vi.fn(async (_url: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 202 }));
    await mirror(ok as unknown as typeof fetch).submitIdentityRow(new Uint8Array([1]));
    const headers = (ok.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect('x-request-id' in headers).toBe(false);
  });

  it('carries it on the submit path too, where the failure is only ever visible in a log', async () => {
    const store = createContentStore();
    const created = await store.createCircle({ name: 'C', description: '', subject: 's1', persona: 'a', disclosed: false, isOpen: true });
    const ok = vi.fn(async (_url: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 202 }));
    const m = forwardingChainMirror({
      link: { url: 'https://sponsor.internal/', token: 'secret', fetchImpl: ok as unknown as typeof fetch },
      rowReads: true,
      identityRow: async () => undefined,
      store,
      log: () => {},
    });
    m.submitProven({ kind: 'circle', circleId: created.id, chainId: '7' }, new Uint8Array([1]), {requestId: 'ray-456'});
    await vi.waitFor(() => expect(ok).toHaveBeenCalled());
    const headers = (ok.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-request-id']).toBe('ray-456');
  });

  it('marks the ref pending, then forwards the proven bytes', async () => {
    const store = createContentStore();
    const created = await store.createCircle({
      name: 'C',
      description: '',
      subject: 's1',
      persona: 's1',
      disclosed: true,
      isOpen: true,
    });
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(String((JSON.parse(String(init?.body)) as {settlement: {kind: string}}).settlement.kind));
      return new Response('{}', { status: 202 });
    });
    const m = forwardingChainMirror({
      link: { url: 'https://sponsor.internal', token: 't', fetchImpl: fetchImpl as unknown as typeof fetch },
      rowReads: true,
      identityRow: async () => undefined,
      store,
      log: () => {},
    });
    m.submitProven({ kind: 'circle', circleId: created.id, chainId: '3' }, new Uint8Array([7]));
    await vi.waitFor(async () => expect((await store.getCircle(created.id))?.chain?.status).toBe('pending'));
    await vi.waitFor(() => expect(seen).toEqual(['circle']));
  });

  // A tunnel that is down must not leave a badge waiting on a settlement that can never arrive: the
  // sponsor never accepted the transaction, so nothing downstream will ever report on it.
  it('marks the ref failed when the sponsor cannot be reached', async () => {
    const store = createContentStore();
    const created = await store.createCircle({
      name: 'C',
      description: '',
      subject: 's1',
      persona: 's1',
      disclosed: true,
      isOpen: true,
    });
    const log = vi.fn();
    const m = forwardingChainMirror({
      link: {
        url: 'https://sponsor.internal',
        token: 't',
        fetchImpl: (async () => {
          throw new Error('tunnel down');
        }) as unknown as typeof fetch,
      },
      rowReads: true,
      identityRow: async () => undefined,
      store,
      log,
    });
    m.submitProven({ kind: 'circle', circleId: created.id }, new Uint8Array([7]));
    await vi.waitFor(async () => {
      const chain = (await store.getCircle(created.id))?.chain;
      expect(chain?.status).toBe('failed');
      expect(chain?.error).toContain('tunnel down');
    });
    expect(log).toHaveBeenCalled();
  });

  // Forwarding these would mean proving on the sponsor host, which is the thing that would put a proof
  // server back on the box.
  // State comes from an indexer now; a deployment with no wallet should say so rather than pretend.
  it('refuses to serve contract state', async () => {
    await expect(mirror(vi.fn() as unknown as typeof fetch).contractState()).rejects.toThrow(/from an indexer/);
  });
});

describe('parseSettlementReport', () => {
  /**
   * One example per `ProvenSettlement` kind, and the count is asserted below.
   *
   * ⚠️ **This validator is a second switch over the same union**, guarding the report coming *inward*
   * from the sponsor host. A kind the outward path knows and this one does not is accepted, submitted
   * and landed on chain — and then the host's report is refused with `unknown settlement kind`,
   * leaving the row `pending` for ever with the transaction perfectly fine. `invite-authority` did
   * exactly that on its first device run, which is why the count is pinned rather than the list
   * quietly growing on one side.
   */
  const everyKind = [
    circle,
    { kind: 'membership', circleId: 'c1', subject: 's1' },
    { kind: 'proposal', proposalId: 'p1' },
    { kind: 'vote', proposalId: 'p1', subject: 's1' },
    { kind: 'invite', circleId: 'c1', commitment: 'ab'.repeat(32) },
    { kind: 'invite-authority', circleId: 'c1' },
    { kind: 'transfer', subject: 's1' },
  ];

  it('accepts a well-formed report of each kind', () => {
    const chain = { status: 'confirmed', txId: 'tx' };
    for (const settlement of everyKind) {
      expect(parseSettlementReport({ settlement, chain })).toEqual({ settlement, chain });
    }
  });

  // The guard that makes the list above load-bearing: a kind added to `ProvenSettlement` and not to
  // this file leaves the count wrong, and a failing count is what sends the next reader here.
  it('covers every settlement kind ProvenSettlement declares', () => {
    expect(everyKind).toHaveLength(7);
    expect(new Set(everyKind.map((s) => s.kind)).size).toBe(everyKind.length);
  });

  it.each([
    [{}, /settlement is required/],
    [{ settlement: circle }, /chain is required/],
    [{ settlement: circle, chain: { status: 'weird' } }, /chain.status must be/],
    [{ settlement: { kind: 'circle' }, chain: { status: 'confirmed' } }, /requires circleId/],
    [{ settlement: { kind: 'membership', circleId: 'c1' }, chain: { status: 'confirmed' } }, /requires circleId and subject/],
    [{ settlement: { kind: 'invite-authority' }, chain: { status: 'confirmed' } }, /requires circleId/],
    [{ settlement: { kind: 'nope' }, chain: { status: 'confirmed' } }, /unknown settlement kind/],
  ])('rejects %j', (body, expected) => {
    const result = parseSettlementReport(body);
    expect('error' in result && result.error).toMatch(expected);
  });
});

describe('applySettlement', () => {
  it('writes the row the settlement names', async () => {
    const store = createContentStore();
    const created = await store.createCircle({
      name: 'C',
      description: '',
      subject: 's1',
      persona: 's1',
      disclosed: true,
      isOpen: true,
    });
    await applySettlement(store, { kind: 'circle', circleId: created.id, chainId: '9' }, {
      status: 'confirmed',
      txId: 'tx-1',
      chainId: '9',
    });
    expect((await store.getCircle(created.id))?.chain).toMatchObject({ status: 'confirmed', txId: 'tx-1', chainId: '9' });
  });

  // ⚠️ This is the path the hosted deployment runs — the sponsor host reports back through
  // `POST /internal/settle`, which calls this. The rule was first written into `storeSettlementSink`
  // alone, which only the monolith composition uses, so production settled the circle and left the
  // founder's membership reading as never-on-chain. Test the path that runs, not the one that reads
  // most naturally.
  it("settles the founder's membership from the circle's own deploy", async () => {
    const store = createContentStore();
    const created = await store.createCircle({
      name: 'C',
      description: '',
      subject: 's1',
      persona: 's1',
      disclosed: true,
      isOpen: true,
    });
    await store.setCircleFounder(created.id, 'aa'.repeat(32), 's1');

    await applySettlement(store, { kind: 'circle', circleId: created.id, chainId: '9' }, {
      status: 'confirmed',
      txId: 'tx-1',
      chainId: '9',
    });

    // The constructor seats the founder's member leaf, so the deploy *is* their join — there is no
    // second transaction whose settlement would otherwise mark it.
    expect((await store.getMembership(created.id, 's1'))?.chain).toMatchObject({ status: 'confirmed', txId: 'tx-1' });
  });

  // Before the founder settles their deploy no subject is recorded, and inventing one would write a
  // membership row against a subject nobody owns.
  it('settles only the circle when no founder subject is recorded yet', async () => {
    const store = createContentStore();
    const created = await store.createCircle({
      name: 'C',
      description: '',
      subject: 's1',
      persona: 's1',
      disclosed: true,
      isOpen: true,
    });

    await applySettlement(store, { kind: 'circle', circleId: created.id, chainId: '9' }, {
      status: 'confirmed',
      txId: 'tx-1',
      chainId: '9',
    });

    expect((await store.getMembership(created.id, 's1'))?.chain).toBeUndefined();
  });
});
