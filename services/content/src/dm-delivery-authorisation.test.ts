// Who may read from, and write into, a conversation.
//
// ⚠️ **A conversation id is a hash of two public `pnyx_id`s** (`@pnyx/contract-client/dm-conversation`),
// so anyone who can name two identities can compute it. Authentication alone was therefore not a
// gate on anything: the id in the path was a claim, and the service believed it. The three holes
// closed here were verified by probe on 2026-09-01 and are written up in `docs/ABUSE_MITIGATION.md`
// §5 as D1, D2 and D3.
//
// The gate is a re-derivation, not a membership table: a caller may only address the conversation it
// shares with the recipient it names, which makes every stored row attributable to that pair.
import { conversationId } from '@pnyx/contract-client/dm-conversation';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { DM_CLAIMS } from './dm-claim-limit.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const keys = await createJwtKeys();
  handler = createHandler({
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
    store: createContentStore(),
    devAuth: true,
    chain: disabledChainMirror,
    notify: createNotifier(createContentStore(), loggingPushSender(() => {}), () => {}),
  });
});

const req = (path: string, init?: RequestInit & { token?: string }) =>
  handler(
    new Request(`http://svc${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    }),
  );

const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const login = async (name: string): Promise<{ token: string; address: string }> =>
  body<{ token: string; address: string }>(await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) }));

const b64 = (fill: number, len = 8): string => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(fill);
  return btoa(s);
};

describe('reading a conversation (D1)', () => {
  it('serves a conversation to both of its parties', async () => {
    const alice = await login('r1-alice');
    const bob = await login('r1-bob');
    const c = conversationId(alice.address, bob.address);
    await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'r1-m1', recipient: bob.address, ciphertext: b64(0x11) }),
    });
    for (const party of [alice, bob]) {
      const seen = await body<{ messages: unknown[] }>(await req(`/dm/${c}/messages`, { method: 'GET', token: party.token }));
      expect(seen.messages).toHaveLength(1);
    }
  });

  // The defect: a stranger computed the pair hash and read the traffic. Content is MLS ciphertext,
  // but senders, timing, count and size are not — that is the social graph we do not publish.
  it('serves nothing to a stranger who computed the pair hash', async () => {
    const alice = await login('r2-alice');
    const bob = await login('r2-bob');
    const mallory = await login('r2-mallory');
    const c = conversationId(alice.address, bob.address);
    await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'r2-m1', recipient: bob.address, ciphertext: b64(0x22) }),
    });
    const seen = await body<{ messages: unknown[] }>(await req(`/dm/${c}/messages`, { method: 'GET', token: mallory.token }));
    expect(seen.messages).toEqual([]);
  });

  // Empty rather than 403 on purpose: a refusal that depended on the conversation existing would be
  // an oracle for whether two named identities have ever spoken.
  it('answers the same for a conversation that never existed, so it is not an existence oracle', async () => {
    const mallory = await login('r3-mallory');
    const real = conversationId((await login('r3-alice')).address, (await login('r3-bob')).address);
    const invented = conversationId('mn_addr1nobody', 'mn_addr1nobodyelse');
    const a = await req(`/dm/${real}/messages`, { method: 'GET', token: mallory.token });
    const b = await req(`/dm/${invented}/messages`, { method: 'GET', token: mallory.token });
    expect(a.status).toBe(b.status);
    expect(await body(a)).toEqual(await body(b));
  });
});

describe('writing into a conversation (D2)', () => {
  it('accepts a message into the conversation the sender shares with the recipient', async () => {
    const alice = await login('w1-alice');
    const bob = await login('w1-bob');
    const c = conversationId(alice.address, bob.address);
    const posted = await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'w1-m1', recipient: bob.address, ciphertext: b64(1) }),
    });
    expect(posted.status).toBe(201);
  });

  // ⚠️ The cheapest spam path there was: no key package, no Welcome, no MLS group — just a POST that
  // put a row in someone's inbox and rang their phone. It is also why gating key-package claims
  // alone would have moved no attacker: this route never touched one.
  it('refuses a message whose conversation is not between the sender and the recipient', async () => {
    const bob = await login('w2-bob');
    const mallory = await login('w2-mallory');
    const notTheirs = conversationId('mn_addr1someone', 'mn_addr1someoneelse');
    const posted = await req(`/dm/${notTheirs}/messages`, {
      method: 'POST',
      token: mallory.token,
      body: JSON.stringify({ id: 'w2-m1', recipient: bob.address, ciphertext: b64(2) }),
    });
    expect(posted.status).toBe(403);
    const inbox = await body<{ conversations: unknown[] }>(await req('/dm', { method: 'GET', token: bob.token }));
    expect(inbox.conversations).toEqual([]);
  });

  // A third party's thread stays a third party's thread, even for a real conversation id.
  it('refuses a message injected into two other people’s conversation', async () => {
    const alice = await login('w3-alice');
    const bob = await login('w3-bob');
    const mallory = await login('w3-mallory');
    const theirs = conversationId(alice.address, bob.address);
    const posted = await req(`/dm/${theirs}/messages`, {
      method: 'POST',
      token: mallory.token,
      body: JSON.stringify({ id: 'w3-m1', recipient: bob.address, ciphertext: b64(3) }),
    });
    expect(posted.status).toBe(403);
  });

  it('refuses a Welcome the same way', async () => {
    const bob = await login('w4-bob');
    const mallory = await login('w4-mallory');
    const notTheirs = conversationId('mn_addr1someone', 'mn_addr1someoneelse');
    const posted = await req(`/dm/${notTheirs}/welcome`, {
      method: 'POST',
      token: mallory.token,
      body: JSON.stringify({ id: 'w4-w1', recipient: bob.address, welcome: b64(4), ratchetTree: b64(5) }),
    });
    expect(posted.status).toBe(403);
    const waiting = await body<{ welcomes: unknown[] }>(await req('/dm/welcomes', { method: 'GET', token: bob.token }));
    expect(waiting.welcomes).toEqual([]);
  });
});

describe('claiming key packages (D3)', () => {
  // The defect: claims were unlimited and anonymous, so one stranger emptied a pool and every
  // legitimate peer got 409 until that device refilled — a denial of service on being reachable.
  it('stops one identity draining a pool, and leaves the rest claimable by others', async () => {
    const bob = await login('c1-bob');
    const mallory = await login('c1-mallory');
    const carol = await login('c1-carol');
    const packages = Array.from({ length: DM_CLAIMS.perPeer + 3 }, (_, i) => b64(0x40 + i));
    await req('/dm/key-packages', { method: 'POST', token: bob.token, body: JSON.stringify({ packages }) });

    let won = 0;
    let refused = 0;
    for (let i = 0; i < DM_CLAIMS.perPeer + 3; i++) {
      const res = await req(`/dm/key-packages/${encodeURIComponent(bob.address)}/claim`, {
        method: 'POST',
        token: mallory.token,
      });
      if (res.status === 200) won++;
      if (res.status === 429) refused++;
    }
    expect(won).toBe(DM_CLAIMS.perPeer);
    expect(refused).toBeGreaterThan(0);

    // ⚠️ The property that matters is not "the attacker was stopped" but "the victim is still
    // reachable": a cap that emptied the pool anyway would have changed nothing.
    const left = await body<{ available: number }>(await req('/dm/key-packages', { method: 'GET', token: bob.token }));
    expect(left.available).toBeGreaterThan(0);
    const honest = await req(`/dm/key-packages/${encodeURIComponent(bob.address)}/claim`, {
      method: 'POST',
      token: carol.token,
    });
    expect(honest.status).toBe(200);
  });

  it('counts per pool, so claiming from one identity does not spend the budget for another', async () => {
    const bob = await login('c2-bob');
    const dave = await login('c2-dave');
    const mallory = await login('c2-mallory');
    // ⚠️ Distinct bytes per owner: a package's id is the sha256 of its bytes and the table is keyed
    // by that id alone, so two subjects publishing identical bytes would dedupe into one row. Real
    // key packages carry a unique init key, so this is a fixture concern rather than a live one.
    for (const [i, owner] of [bob, dave].entries()) {
      await req('/dm/key-packages', {
        method: 'POST',
        token: owner.token,
        body: JSON.stringify({ packages: [b64(0x60 + i * 2), b64(0x61 + i * 2)] }),
      });
    }
    for (let i = 0; i < DM_CLAIMS.perPeer; i++) {
      await req(`/dm/key-packages/${encodeURIComponent(bob.address)}/claim`, { method: 'POST', token: mallory.token });
    }
    const fromDave = await req(`/dm/key-packages/${encodeURIComponent(dave.address)}/claim`, {
      method: 'POST',
      token: mallory.token,
    });
    expect(fromDave.status).toBe(200);
  });
});
