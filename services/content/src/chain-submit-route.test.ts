// POST /chain/submit — the phase-B device-proving endpoint: auth + ref resolution + base64
// decode, then hand-off to ChainMirror.submitProven. The balance+submit itself is the chain
// client's job (exercised elsewhere); here we assert the routing/authorization contract.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { type ChainMirror, disabledChainMirror, type ProvenSettlement } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { type ContentStore, createContentStore } from './store.js';

type Handler = (
  request: Request,
  hooks?: { readonly keepAlive?: (promise: Promise<unknown>) => void },
) => Promise<Response>;

let submitted: {
  settlement: ProvenSettlement;
  bytes: Uint8Array;
  keepAlive?: ((promise: Promise<unknown>) => void) | undefined;
  network?: string | undefined;
}[] = [];

/** What the mirror answers. A transfer waits for it, so a test can drive the refusal path. */
let acceptance: { accepted: true; txId?: string } | { accepted: false; error: string } = { accepted: true };

const recordingMirror = (): ChainMirror => ({
  enabled: true,
  rowReads: true,
  contractCodeDigestAt: () => Promise.reject(new Error('not configured')),
  submitProven: (settlement, bytes, context) => {
    submitted.push({ settlement, bytes, keepAlive: context?.keepAlive, network: context?.network });
    return Promise.resolve(acceptance);
  },
  contractState: () => Promise.resolve(new Uint8Array()),
  identityRow: () => Promise.resolve(undefined),
  submitIdentityRow: () => Promise.resolve(),
  whenIdle: () => Promise.resolve(),
});

const makeHandler = async (
  chain: ChainMirror,
  store: ContentStore,
  transferLimit?: { allow(key: string): Promise<boolean> },
): Promise<Handler> => {
  const keys = await createJwtKeys();
  return createHandler({
    auth: {
      domain: 'pnyx.test',
      network: 'undeployed',
      nonces: createNonceStore(),
      jwt: { privateKey: keys.privateKey, issuer: 'https://pnyx-content-service', audience: 'pnyx', ttlSeconds: 3600 },
    },
    publicJwk: keys.publicJwk,
    store,
    devAuth: true,
    chain,
    notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
    ...(transferLimit === undefined ? {} : { transferLimit }),
  });
};

const req = (
  handler: Handler,
  path: string,
  init?: RequestInit & { token?: string },
  hooks?: { readonly keepAlive?: (promise: Promise<unknown>) => void },
) =>
  handler(
    new Request(`http://svc${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}) },
    }),
    hooks,
  );

const login = async (handler: Handler, name: string): Promise<string> => {
  const res = await req(handler, '/auth/dev', { method: 'POST', body: JSON.stringify({ name }) });
  return ((await res.json()) as { token: string }).token;
};

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

const submitTransfer = (handler: Handler, token: string) =>
  req(handler, '/chain/submit', {
    method: 'POST',
    token,
    body: JSON.stringify({ tx: b64([7]), ref: { kind: 'transfer' } }),
  });

describe('POST /chain/submit', () => {
  let handler: Handler;
  let store: ContentStore;
  let token: string;
  let circleId: string;

  beforeAll(async () => {
    submitted = [];
    store = createContentStore();
    handler = await makeHandler(recordingMirror(), store);
    token = await login(handler, 'alice');
    const created = await req(handler, '/circles', { method: 'POST', token, body: JSON.stringify({ name: 'C' }) });
    circleId = ((await created.json()) as { circle: { id: string } }).circle.id;
  });

  it('requires authentication', async () => {
    const res = await req(handler, '/chain/submit', { method: 'POST', body: JSON.stringify({ tx: b64([1]), ref: {} }) });
    expect(res.status).toBe(401);
  });

  it('accepts a valid membership settlement and forwards the decoded bytes', async () => {
    const before = submitted.length;
    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([4, 5, 6]), ref: { kind: 'membership', circleId } }),
    });
    expect(res.status).toBe(202);
    expect(submitted.length).toBe(before + 1);
    const last = submitted[submitted.length - 1];
    // The creator auto-joined, so alice has a membership to settle; subject comes from the token.
    expect(last?.settlement).toEqual({ kind: 'membership', circleId, subject: 'dev:alice' });
    expect(last?.bytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('rejects a missing tx or one that decodes to empty bytes', async () => {
    // Buffer base64 decoding never throws, so the guards are "present + non-empty"; a malformed
    // but non-empty payload is caught later at deserialize, not here.
    for (const tx of [undefined, '', '===']) {
      const res = await req(handler, '/chain/submit', {
        method: 'POST',
        token,
        body: JSON.stringify({ tx, ref: { kind: 'membership', circleId } }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects an unknown ref kind and a missing circle', async () => {
    const badKind = await req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'nonsense' } }),
    });
    expect(badKind.status).toBe(400);

    const noCircle = await req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'membership', circleId: 'does-not-exist' } }),
    });
    expect(noCircle.status).toBe(404);
  });

  it('forbids settling a membership the caller does not hold', async () => {
    const bob = await login(handler, 'bob'); // never joined the circle
    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token: bob,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'membership', circleId } }),
    });
    expect(res.status).toBe(403);
  });

  /**
   * A transfer is the one settlement with nothing in the content plane behind it: no circle to
   * belong to, no membership to check. These pin what stands in for that — the session, and the
   * rate limit.
   */
  describe("ref.kind 'transfer'", () => {
    it('accepts one from any authenticated caller and takes the subject from the token', async () => {
      const before = submitted.length;
      const res = await req(handler, '/chain/submit', {
        method: 'POST',
        token,
        // A body subject must not be honoured — the caller does not get to spend as someone else.
        body: JSON.stringify({ tx: b64([9, 9]), ref: { kind: 'transfer', subject: 'dev:mallory' } }),
      });
      expect(res.status).toBe(202);
      expect(submitted.length).toBe(before + 1);
      expect(submitted[submitted.length - 1]?.settlement).toEqual({ kind: 'transfer', subject: 'dev:alice' });
    });

    /**
     * The bug this pins cost a whole send rail: the route answered 202 and the forward to the sponsor
     * was never made, with no log on either side because nothing failed. A Worker cancels a promise
     * still pending when the response is returned, and a transfer has no content-plane row to write
     * first — so there was nothing to keep the isolate alive by accident. The route must hand the
     * request's own lifetime hook down to the mirror.
     */
    it("passes the request's keep-alive hook down, so the forward is not cancelled", async () => {
      const kept: Promise<unknown>[] = [];
      const res = await req(
        handler,
        '/chain/submit',
        {
          method: 'POST',
          token,
          body: JSON.stringify({ tx: b64([7]), ref: { kind: 'transfer' } }),
        },
        { keepAlive: (promise) => kept.push(promise) },
      );
      expect(res.status).toBe(202);
      expect(submitted[submitted.length - 1]?.keepAlive).toBeTypeOf('function');
      // The mirror decides what to hand over; the route's contract is that the hook arrives at all.
      submitted[submitted.length - 1]?.keepAlive?.(Promise.resolve());
      expect(kept).toHaveLength(1);
    });

    it('needs no circle membership, unlike every other kind', async () => {
      const outsider = await login(handler, 'nomad');
      const res = await req(handler, '/chain/submit', {
        method: 'POST',
        token: outsider,
        body: JSON.stringify({ tx: b64([1]), ref: { kind: 'transfer' } }),
      });
      expect(res.status).toBe(202);
    });

    it('still requires authentication', async () => {
      const res = await req(handler, '/chain/submit', {
        method: 'POST',
        body: JSON.stringify({ tx: b64([1]), ref: { kind: 'transfer' } }),
      });
      expect(res.status).toBe(401);
    });

    it('is refused with 429 once the caller exceeds the limit, and the tx is not forwarded', async () => {
      const seen: string[] = [];
      let allowed = true;
      const limited = await makeHandler(recordingMirror(), createContentStore(), {
        allow: async (key: string) => {
          seen.push(key);
          return allowed;
        },
      });
      const t = await login(limited, 'spender');
      expect((await submitTransfer(limited, t)).status).toBe(202);
      // Keyed on the subject, not the request: the subject is what the guard is about.
      expect(seen).toEqual(['transfer:dev:spender']);

      allowed = false;
      const before = submitted.length;
      const refused = await submitTransfer(limited, t);
      expect(refused.status).toBe(429);
      expect(submitted.length).toBe(before);
    });

    it('does not consume the transfer budget for a content-plane settlement', async () => {
      const seen: string[] = [];
      const limited = await makeHandler(recordingMirror(), store, {
        allow: async (key: string) => {
          seen.push(key);
          return true;
        },
      });
      const t = await login(limited, 'alice');
      const res = await req(limited, '/chain/submit', {
        method: 'POST',
        token: t,
        body: JSON.stringify({ tx: b64([1]), ref: { kind: 'membership', circleId } }),
      });
      expect(res.status).toBe(202);
      expect(seen).toEqual([]);
    });
  });

  it('refuses a circle settlement from anyone but the circle’s creator', async () => {
    // ⚠️ The regression: this case checked only that the circle *existed*, while `chainId` is a value
    // the client asserts and `setCircleChain` writes through. Since a circle's address derives from
    // public inputs plus a founder of the caller's choosing, anyone could point someone else's circle
    // at a contract they moderate.
    const store = createContentStore();
    const handler = await makeHandler(recordingMirror(), store);
    const owner = await login(handler, 'owner');
    const created = await req(handler, '/circles', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'Owned', persona: 'Founder' }),
    });
    const { circle } = (await created.json()) as { circle: { id: string } };

    const intruder = await login(handler, 'intruder');
    await req(handler, `/circles/${circle.id}/join`, {
      method: 'POST',
      token: intruder,
      body: JSON.stringify({ persona: 'intruder' }),
    });
    const stolen = await req(handler, '/chain/submit', {
      method: 'POST',
      token: intruder,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'circle', circleId: circle.id, chainId: 'ab'.repeat(32) } }),
    });
    expect(stolen.status).toBe(403);

    // The creator is still allowed, so the guard is authorisation and not a blanket refusal.
    const mine = await req(handler, '/chain/submit', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'circle', circleId: circle.id, chainId: 'cd'.repeat(32) } }),
    });
    expect(mine.status).toBe(202);
  });

  it('records the founder leaf from the creator, and rejects a malformed one', async () => {
    const store = createContentStore();
    const handler = await makeHandler(recordingMirror(), store);
    const owner = await login(handler, 'leafowner');
    const created = await req(handler, '/circles', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'Anchored', persona: 'Founder' }),
    });
    const { circle } = (await created.json()) as { circle: { id: string } };

    const bad = await req(handler, '/chain/submit', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({
        tx: b64([1]),
        ref: { kind: 'circle', circleId: circle.id, chainId: 'ab'.repeat(32), founderLeaf: 'NOT-HEX' },
      }),
    });
    expect(bad.status).toBe(400);
    expect((await store.getCircle(circle.id))?.founderLeaf).toBeUndefined();

    const ok = await req(handler, '/chain/submit', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({
        tx: b64([1]),
        ref: { kind: 'circle', circleId: circle.id, chainId: 'ab'.repeat(32), founderLeaf: 'cd'.repeat(32) },
      }),
    });
    expect(ok.status).toBe(202);
    expect((await store.getCircle(circle.id))?.founderLeaf).toBe('cd'.repeat(32));
    // The settling subject is recorded with it — that pair is what channel authority reads.
    expect((await store.getCircle(circle.id))?.founderSubject).toBeDefined();
  });

  it('does not let a non-creator record a founder leaf', async () => {
    // The guard is the same one that protects `chainId`: naming another circle's moderator would be
    // worse than naming its address, since the leaf is what any later authority check reads.
    const store = createContentStore();
    const handler = await makeHandler(recordingMirror(), store);
    const owner = await login(handler, 'leafowner2');
    const created = await req(handler, '/circles', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'Anchored two', persona: 'Founder' }),
    });
    const { circle } = (await created.json()) as { circle: { id: string } };
    const intruder = await login(handler, 'leafintruder');
    await req(handler, `/circles/${circle.id}/join`, {
      method: 'POST',
      token: intruder,
      body: JSON.stringify({ persona: 'intruder' }),
    });

    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token: intruder,
      body: JSON.stringify({
        tx: b64([1]),
        ref: { kind: 'circle', circleId: circle.id, chainId: 'ab'.repeat(32), founderLeaf: 'ee'.repeat(32) },
      }),
    });
    expect(res.status).toBe(403);
    expect((await store.getCircle(circle.id))?.founderLeaf).toBeUndefined();
  });

  it('returns 503 when chain mirroring is disabled', async () => {
    const disabledStore = createContentStore();
    const disabledHandler = await makeHandler(disabledChainMirror, disabledStore);
    const t = await login(disabledHandler, 'carol');
    const res = await req(disabledHandler, '/chain/submit', {
      method: 'POST',
      token: t,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'circle', circleId: 'x' } }),
    });
    expect(res.status).toBe(503);
  });
});

// Which Midnight network the bytes are for. The sponsor host holds one wallet per network, so getting
// this wrong is a 202 followed by a refusal deep inside `balanceTx` that no caller ever sees.
describe('POST /chain/submit network selection', () => {
  let handler: Handler;
  let token: string;

  beforeAll(async () => {
    handler = await makeHandler(recordingMirror(), createContentStore());
    token = await login(handler, 'nets');
  });

  const submit = (network?: unknown) =>
    req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([7]), ref: { kind: 'transfer' }, ...(network === undefined ? {} : { network }) }),
    });

  it('passes the named network down to the mirror', async () => {
    const before = submitted.length;
    expect((await submit('preview')).status).toBe(202);
    expect(submitted[before]?.network).toBe('preview');
  });

  // Every caller written before this change sends no network, and must keep working: absent means "the
  // sponsor host's default", which is what a single-network deployment meant all along.
  it('leaves it absent when the caller names none', async () => {
    const before = submitted.length;
    expect((await submit()).status).toBe(202);
    expect(submitted[before]?.network).toBeUndefined();
    expect((await submit('')).status).toBe(202);
  });

  // Refused by the service that read it rather than two hops away, and *before* anything is accepted.
  it('refuses a value that could not be a network id', async () => {
    for (const bad of [42, { name: 'preview' }, 'Preview', 'preview!', 'x'.repeat(40)]) {
      const res = await submit(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('network');
    }
  });

  // ⚠️ Deliberately NOT a list of known networks: which ones a host sponsors is the host's own fact and
  // it answers by name. A second list here would be a copy to drift.
  it('accepts a well-formed network this service has never heard of', async () => {
    const before = submitted.length;
    expect((await submit('devnet-7')).status).toBe(202);
    expect(submitted[before]?.network).toBe('devnet-7');
  });
});

// ⚠️ **A transfer waits for the sponsor to accept it, and every other kind does not.** A transfer has no
// ChainRef to carry a failure, so a refusal after the 202 becomes a "Pending" row on the device that
// nothing settles for two hours. Seen twice on a device, 2026-08-28.
describe('POST /chain/submit and the sponsor’s refusal', () => {
  let handler: Handler;
  let token: string;
  let circleId: string;

  beforeAll(async () => {
    const store = createContentStore();
    handler = await makeHandler(recordingMirror(), store);
    token = await login(handler, 'refusals');
    const created = await req(handler, '/circles', { method: 'POST', token, body: JSON.stringify({ name: 'R' }) });
    circleId = ((await created.json()) as { circle: { id: string } }).circle.id;
  });

  afterEach(() => {
    acceptance = { accepted: true };
  });

  it('answers 502 with the sponsor’s own reason when a transfer is refused', async () => {
    acceptance = { accepted: false, error: "this sponsor holds preprod and these bytes are not a preprod transaction" };
    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([7]), ref: { kind: 'transfer' }, network: 'preview' }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('holds preprod');
  });

  it('still answers 202 for a transfer the sponsor accepted', async () => {
    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([7]), ref: { kind: 'transfer' } }),
    });
    expect(res.status).toBe(202);
  });

  /**
   * ⚠️ Every other kind stays fire-and-forget, and that is not laziness: it writes a ChainRef, so a
   * refusal is already visible as `failed` on a row the app reads. Waiting would only make the route
   * slower for no new information.
   */
  it('does not wait for a settlement that has a ChainRef to carry the failure', async () => {
    acceptance = { accepted: false, error: 'refused' };
    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token,
      body: JSON.stringify({ tx: b64([7]), ref: { kind: 'membership', circleId } }),
    });
    expect(res.status).toBe(202);
  });
});

describe('the contract address a circle settles', () => {
  // ⚠️ The regression this exists for: `text(ref.chainId, 40)` capped a **64**-character address at
  // 40, so `text` returned undefined and the address was dropped from every settlement — silently.
  // The route still answered 202 and the badge still read "On-chain", so every test here passed while
  // no circle in production had ever recorded the contract it deployed. Asserting the *stored value*
  // is what closes it; asserting the status code is what let it run for a month.
  it('records the 64-character address the creator reports', async () => {
    const store = createContentStore();
    const handler = await makeHandler(recordingMirror(), store);
    const owner = await login(handler, 'addr-owner');
    const created = await req(handler, '/circles', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'Addressed', persona: 'Founder' }),
    });
    const { circle } = (await created.json()) as { circle: { id: string } };
    const address = 'ab'.repeat(32);

    const res = await req(handler, '/chain/submit', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ tx: b64([1]), ref: { kind: 'circle', circleId: circle.id, chainId: address } }),
    });

    expect(res.status).toBe(202);
    expect(submitted.at(-1)?.settlement).toMatchObject({ kind: 'circle', chainId: address });
  });

  // Dropping a malformed value is the failure mode above; refusing it is the fix.
  it('refuses an address that is not 64 hex characters rather than dropping it', async () => {
    const store = createContentStore();
    const handler = await makeHandler(recordingMirror(), store);
    const owner = await login(handler, 'addr-bad');
    const created = await req(handler, '/circles', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'Malformed', persona: 'Founder' }),
    });
    const { circle } = (await created.json()) as { circle: { id: string } };

    for (const bad of ['ab'.repeat(20), `${'ab'.repeat(32)}cd`, 'NOT-HEX', 'AB'.repeat(32)]) {
      const res = await req(handler, '/chain/submit', {
        method: 'POST',
        token: owner,
        body: JSON.stringify({ tx: b64([1]), ref: { kind: 'circle', circleId: circle.id, chainId: bad } }),
      });
      expect(res.status, `chainId ${bad.slice(0, 12)}… must be refused`).toBe(400);
    }
  });
});

/*
 * A transfer has no ChainRef row, so this response is the only thing that can tell the device its
 * transfer did not make it. Acking on enqueue is what let one die at the sponsor on preprod
 * (2026-09-30) while the device showed "Pending" for an hour.
 */
describe('POST /chain/submit reports a transfer outcome', () => {
  let handler: Handler;
  let token: string;

  beforeAll(async () => {
    submitted = [];
    handler = await makeHandler(recordingMirror(), createContentStore());
    token = await login(handler, 'carol');
  });

  afterEach(() => {
    acceptance = { accepted: true };
  });

  it('passes the tx id through when the sponsor submitted it', async () => {
    acceptance = { accepted: true, txId: 'tx-from-node' };
    const res = await submitTransfer(handler, token);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, txId: 'tx-from-node' });
  });

  it('answers 502 with the sponsor’s own reason when it refused', async () => {
    acceptance = { accepted: false, error: 'Custom error: 104 — InvalidError::Transcript' };
    const res = await submitTransfer(handler, token);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Custom error: 104') });
  });

  // Absent is legal — an older sponsor host answers a bare 202 — and must not read as a refusal.
  it('still accepts when the sponsor reports no tx id', async () => {
    acceptance = { accepted: true };
    const res = await submitTransfer(handler, token);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
  });
});
