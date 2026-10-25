// DM delivery endpoints (docs/DIRECT_MESSAGES_PLAN.md phase 4). What is worth asserting here is
// the delivery contract, not MLS: every route is authenticated, the sender is bound to the token
// rather than the body, KeyPackages are single-use, Welcomes are single-use, and the poll cursor
// does not re-deliver. Payloads are opaque bytes throughout — the service never reads them.
import { conversationId } from '@pnyx/contract-client/dm-conversation';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const keys = await createJwtKeys();
  const store = createContentStore();
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
    store,
    devAuth: true,
    chain: disabledChainMirror,
    notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
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

const login = async (name: string): Promise<{ token: string; address: string }> => {
  const res = await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status).toBe(200);
  return body<{ token: string; address: string }>(res);
};

const b64 = (fill: number, len = 8): string => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(fill);
  return btoa(s);
};

/** A package's id, computed the way the route does: sha256 hex of the published bytes. */
const idOf = async (base64: string): Promise<string> => {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * The conversation two identities share — the **real** derivation, not a fabricated 64-hex string.
 *
 * ⚠️ It has to be real now: `POST` refuses a conversation that is not between the authenticated
 * sender and the named recipient (`docs/ABUSE_MITIGATION.md` §5, D2), and re-deriving the pair hash
 * is how the service checks that without a membership table. A made-up id is exactly what an
 * attacker posts, so a test using one is testing the hole.
 */
const conv = conversationId;

/** A well-formed id that names no pair — for the routes that refuse before the pair is checked. */
const noPair = (seed: string): string => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0');

describe('DM routes — authentication', () => {
  it('rejects every DM endpoint without a token', async () => {
    const c = noPair('aa');
    const cases: [string, RequestInit][] = [
      ['/dm', { method: 'GET' }],
      ['/dm/welcomes', { method: 'GET' }],
      ['/dm/key-packages', { method: 'GET' }],
      ['/dm/key-packages', { method: 'POST', body: JSON.stringify({ packages: [b64(1)] }) }],
      ['/dm/key-packages/retire', { method: 'POST', body: JSON.stringify({ ids: ['a'] }) }],
      ['/dm/key-packages/dev:bob/claim', { method: 'POST' }],
      [`/dm/${c}/messages`, { method: 'GET' }],
      [`/dm/${c}/messages`, { method: 'POST', body: '{}' }],
      [`/dm/${c}/welcome`, { method: 'POST', body: '{}' }],
    ];
    for (const [path, init] of cases) {
      const res = await req(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(401);
    }
  });
});

describe('DM routes — KeyPackage pool', () => {
  it('publishes, counts, and treats a re-upload as idempotent', async () => {
    const { token } = await login('kp-owner');
    const first = await req('/dm/key-packages', {
      method: 'POST',
      token,
      body: JSON.stringify({ packages: [b64(0x11), b64(0x22)] }),
    });
    expect(first.status).toBe(201);
    expect(await body<{ added: number; available: number }>(first)).toEqual({ added: 2, available: 2 });

    // Same bytes again: the content-hash id makes this a no-op, so a retried request after a
    // dropped response cannot inflate the pool.
    const again = await req('/dm/key-packages', {
      method: 'POST',
      token,
      body: JSON.stringify({ packages: [b64(0x11)] }),
    });
    expect(await body<{ added: number; available: number }>(again)).toEqual({ added: 0, available: 2 });
  });

  it('rejects a malformed or oversized batch', async () => {
    const { token } = await login('kp-bad');
    expect((await req('/dm/key-packages', { method: 'POST', token, body: JSON.stringify({}) })).status).toBe(400);
    expect(
      (await req('/dm/key-packages', { method: 'POST', token, body: JSON.stringify({ packages: [] }) })).status,
    ).toBe(400);
    expect(
      (await req('/dm/key-packages', { method: 'POST', token, body: JSON.stringify({ packages: ['not base64 !!'] }) }))
        .status,
    ).toBe(400);
  });

  it('never hands out the same package twice, then reports the pool empty with 409', async () => {
    const owner = await login('kp-drain');
    const claimer = await login('kp-claimer');
    await req('/dm/key-packages', {
      method: 'POST',
      token: owner.token,
      body: JSON.stringify({ packages: [b64(0xaa), b64(0xbb)] }),
    });
    const path = `/dm/key-packages/${encodeURIComponent(owner.address)}/claim`;
    const one = await body<{ keyPackage: string }>(await req(path, { method: 'POST', token: claimer.token }));
    const two = await body<{ keyPackage: string }>(await req(path, { method: 'POST', token: claimer.token }));
    expect(one.keyPackage).not.toBe(two.keyPackage);
    // 409 not 404: the peer exists, they just cannot be added until they refill.
    expect((await req(path, { method: 'POST', token: claimer.token })).status).toBe(409);
  });
});

// Retiring exists because the public half outliving the private one is not tidiness: a peer claims a
// package the owner can never open, and their invite dies on their side with nothing to retry.
describe('DM routes — retiring a published package', () => {
  it('withdraws the named packages and reports the pool that is left', async () => {
    const { token } = await login('kp-retire');
    await req('/dm/key-packages', {
      method: 'POST',
      token,
      body: JSON.stringify({ packages: [b64(0x31), b64(0x32), b64(0x33)] }),
    });
    const res = await req('/dm/key-packages/retire', {
      method: 'POST',
      token,
      body: JSON.stringify({ ids: [await idOf(b64(0x31)), await idOf(b64(0x32))] }),
    });
    expect(res.status).toBe(200);
    expect(await body<{ retired: number; available: number }>(res)).toEqual({ retired: 2, available: 1 });
  });

  it('retires only the caller\'s own packages, and unknown ids remove nothing', async () => {
    const owner = await login('kp-retire-owner');
    const stranger = await login('kp-retire-stranger');
    await req('/dm/key-packages', { method: 'POST', token: owner.token, body: JSON.stringify({ packages: [b64(0x41)] }) });

    const theirs = await req('/dm/key-packages/retire', {
      method: 'POST',
      token: stranger.token,
      body: JSON.stringify({ ids: [await idOf(b64(0x41)), 'not-an-id'] }),
    });
    expect(await body<{ retired: number }>(theirs)).toEqual({ retired: 0, available: 0 });
    // Still claimable by anyone the owner has not disowned it for.
    const claim = await req(`/dm/key-packages/${encodeURIComponent(owner.address)}/claim`, {
      method: 'POST',
      token: stranger.token,
    });
    expect(claim.status).toBe(200);
  });

  // ⚠️ A claimed row is the tombstone that stops INSERT OR IGNORE resurrecting a spent init key.
  // Deleting it would let the same single-use package be published again and handed out twice.
  it('will not retire a package that has already been claimed', async () => {
    const owner = await login('kp-retire-claimed');
    const claimer = await login('kp-retire-claimer');
    const pkg = b64(0x51);
    await req('/dm/key-packages', { method: 'POST', token: owner.token, body: JSON.stringify({ packages: [pkg] }) });
    await req(`/dm/key-packages/${encodeURIComponent(owner.address)}/claim`, { method: 'POST', token: claimer.token });

    const res = await req('/dm/key-packages/retire', {
      method: 'POST',
      token: owner.token,
      body: JSON.stringify({ ids: [await idOf(pkg)] }),
    });
    expect(await body<{ retired: number }>(res)).toEqual({ retired: 0, available: 0 });

    // Re-publishing it is still refused, which is what the tombstone is for.
    const again = await req('/dm/key-packages', {
      method: 'POST',
      token: owner.token,
      body: JSON.stringify({ packages: [pkg] }),
    });
    expect(await body<{ added: number }>(again)).toEqual({ added: 0, available: 0 });
  });

  it('rejects a malformed id list', async () => {
    const { token } = await login('kp-retire-bad');
    for (const payload of [{}, { ids: [] }, { ids: [''] }, { ids: [42] }, { ids: ['x'.repeat(129)] }]) {
      const res = await req('/dm/key-packages/retire', { method: 'POST', token, body: JSON.stringify(payload) });
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('DM routes — messages', () => {
  it('binds the sender to the token, ignoring any sender in the body', async () => {
    // The impersonation attempt the column has to be immune to. MLS is the real authentication,
    // but the transport must not hand out a free forgery either.
    const alice = await login('msg-alice');
    const bob = await login('msg-bob');
    const c = conv(alice.address, bob.address);
    const posted = await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'm-1', recipient: bob.address, sender: bob.address, ciphertext: b64(0x33) }),
    });
    expect(posted.status).toBe(201);
    const listed = await body<{ messages: { sender: string }[] }>(
      await req(`/dm/${c}/messages`, { method: 'GET', token: bob.token }),
    );
    expect(listed.messages[0]?.sender).toBe(alice.address);
    expect(listed.messages[0]?.sender).not.toBe(bob.address);
  });

  it('round-trips ciphertext unchanged', async () => {
    const alice = await login('rt-alice');
    const bob = await login('rt-bob');
    const c = conv(alice.address, bob.address);
    const ciphertext = b64(0x5a, 64);
    await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'rt-1', recipient: bob.address, ciphertext }),
    });
    const listed = await body<{ messages: { ciphertext: string }[] }>(
      await req(`/dm/${c}/messages`, { method: 'GET', token: bob.token }),
    );
    expect(listed.messages[0]?.ciphertext).toBe(ciphertext);
  });

  it('the since cursor does not re-deliver', async () => {
    const alice = await login('cur-alice');
    const bob = await login('cur-bob');
    const c = conv(alice.address, bob.address);
    for (const id of ['c-1', 'c-2']) {
      await req(`/dm/${c}/messages`, {
        method: 'POST',
        token: alice.token,
        body: JSON.stringify({ id, recipient: bob.address, ciphertext: b64(1) }),
      });
    }
    const all = await body<{ messages: { id: string; createdAt: string }[] }>(
      await req(`/dm/${c}/messages`, { method: 'GET', token: bob.token }),
    );
    const cursor = all.messages[0]?.createdAt as string;
    const after = await body<{ messages: { id: string }[] }>(
      await req(`/dm/${c}/messages?since=${encodeURIComponent(cursor)}`, { method: 'GET', token: bob.token }),
    );
    expect(after.messages.map((m) => m.id)).not.toContain('c-1');
  });

  it('rejects a message missing its required fields', async () => {
    const { token } = await login('bad-msg');
    const c = noPair('ee');
    expect((await req(`/dm/${c}/messages`, { method: 'POST', token, body: JSON.stringify({}) })).status).toBe(400);
  });

  it('lists my conversations with the peer resolved', async () => {
    const alice = await login('inbox-alice');
    const bob = await login('inbox-bob');
    const c = conv(alice.address, bob.address);
    await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'i-1', recipient: bob.address, ciphertext: b64(1) }),
    });
    const inbox = await body<{ conversations: { convId: string; peer: string }[] }>(
      await req('/dm', { method: 'GET', token: bob.token }),
    );
    expect(inbox.conversations.find((x) => x.convId === c)?.peer).toBe(alice.address);
  });
});

describe('DM routes — Welcomes', () => {
  it('redelivers a Welcome until the recipient acks it', async () => {
    const alice = await login('w-alice');
    const bob = await login('w-bob');
    const c = conv(alice.address, bob.address);
    const posted = await req(`/dm/${c}/welcome`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'w-1', recipient: bob.address, welcome: b64(0x77), ratchetTree: b64(0x88) }),
    });
    expect(posted.status).toBe(201);

    const taken = await body<{ welcomes: { welcome: string; ratchetTree: string; sender: string }[] }>(
      await req('/dm/welcomes', { method: 'GET', token: bob.token }),
    );
    expect(taken.welcomes).toHaveLength(1);
    expect(taken.welcomes[0]?.welcome).toBe(b64(0x77));
    expect(taken.welcomes[0]?.ratchetTree).toBe(b64(0x88));
    expect(taken.welcomes[0]?.sender).toBe(alice.address);

    // ⚠️ **Reading must not consume it.** A Welcome cannot be regenerated, so delete-on-read lost the
    // invitation to anything that went wrong afterwards — and the recipient was left with a
    // conversation that could never be opened and nothing to retry.
    const again = await body<{ welcomes: unknown[] }>(await req('/dm/welcomes', { method: 'GET', token: bob.token }));
    expect(again.welcomes).toHaveLength(1);

    // Somebody else's ack does nothing, even naming the right id.
    const theirs = await req('/dm/welcomes/ack', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ ids: ['w-1'] }),
    });
    expect(await body<{ acked: number }>(theirs)).toEqual({ acked: 0 });

    const acked = await req('/dm/welcomes/ack', {
      method: 'POST',
      token: bob.token,
      body: JSON.stringify({ ids: ['w-1'] }),
    });
    expect(await body<{ acked: number }>(acked)).toEqual({ acked: 1 });
    const gone = await body<{ welcomes: unknown[] }>(await req('/dm/welcomes', { method: 'GET', token: bob.token }));
    expect(gone.welcomes).toHaveLength(0);
  });

  it('drops a delivered message only for the party it was addressed to', async () => {
    const alice = await login('ack-alice');
    const bob = await login('ack-bob');
    const c = conv(alice.address, bob.address);
    await req(`/dm/${c}/messages`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'm-1', recipient: bob.address, ciphertext: b64(0x55) }),
    });

    // ⚠️ One row serves both parties: a sender acking its own message would delete it before the
    // other side ever fetched it.
    const bySender = await req('/dm/messages/ack', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ ids: ['m-1'] }),
    });
    expect(await body<{ acked: number }>(bySender)).toEqual({ acked: 0 });

    const byRecipient = await req('/dm/messages/ack', {
      method: 'POST',
      token: bob.token,
      body: JSON.stringify({ ids: ['m-1'] }),
    });
    expect(await body<{ acked: number }>(byRecipient)).toEqual({ acked: 1 });

    const left = await body<{ messages: unknown[] }>(
      await req(`/dm/${c}/messages`, { method: 'GET', token: bob.token }),
    );
    expect(left.messages).toHaveLength(0);
  });

  it('rejects an unauthenticated or malformed ack', async () => {
    expect((await req('/dm/welcomes/ack', { method: 'POST', body: JSON.stringify({ ids: ['x'] }) })).status).toBe(401);
    expect((await req('/dm/messages/ack', { method: 'POST', body: JSON.stringify({ ids: ['x'] }) })).status).toBe(401);
    const { token } = await login('ack-bad');
    for (const payload of [{}, { ids: [] }, { ids: [''] }, { ids: [7] }]) {
      const res = await req('/dm/welcomes/ack', { method: 'POST', token, body: JSON.stringify(payload) });
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  it('does not deliver a Welcome addressed to somebody else', async () => {
    const alice = await login('w2-alice');
    const bob = await login('w2-bob');
    const carol = await login('w2-carol');
    const c = conv(alice.address, bob.address);
    await req(`/dm/${c}/welcome`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ id: 'w-2', recipient: bob.address, welcome: b64(1), ratchetTree: b64(2) }),
    });
    const forCarol = await body<{ welcomes: unknown[] }>(
      await req('/dm/welcomes', { method: 'GET', token: carol.token }),
    );
    expect(forCarol.welcomes).toHaveLength(0);
  });
});
