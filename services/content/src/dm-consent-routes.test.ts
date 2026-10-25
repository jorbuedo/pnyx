// The consent layer end to end: policy, permits, mute and block over the real routes.
//
// Design and the defects behind it: `docs/ABUSE_MITIGATION.md` §5. The rule itself is unit-tested in
// `dm-consent.test.ts` and the token in `dm-permit.test.ts`; what is asserted here is the wiring —
// that the gate sits on every way into an inbox, that a refusal does not leak *why*, and that a mute
// silences the push without losing the message.
import { conversationId } from '@pnyx/contract-client/dm-conversation';
import { describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import type { RealtimeEvent, RealtimePublisher } from './realtime.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

const recorder = (): { seen: { subject: string; event: RealtimeEvent }[]; publisher: RealtimePublisher } => {
  const seen: { subject: string; event: RealtimeEvent }[] = [];
  return { seen, publisher: { publish: async (subject, event) => void seen.push({ subject, event }) } };
};

const build = async () => {
  const keys = await createJwtKeys();
  const { seen, publisher } = recorder();
  const handler = createHandler({
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
    store: createContentStore(),
    devAuth: true,
    chain: disabledChainMirror,
    notify: createNotifier(createContentStore(), loggingPushSender(() => {}), () => {}, publisher),
    realtime: publisher,
  });

  const req = (path: string, init?: RequestInit & { token?: string; permit?: string }) =>
    handler(
      new Request(`http://svc${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init?.permit ? { 'x-pnyx-dm-permit': init.permit } : {}),
        },
      }),
    );
  const body = async <T>(r: Response): Promise<T> => (await r.json()) as T;
  const login = async (name: string) =>
    body<{ token: string; address: string }>(await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) }));
  const send = (from: { token: string }, to: { address: string }, conv: string, id: string, permit?: string) =>
    req(`/dm/${conv}/messages`, {
      method: 'POST',
      token: from.token,
      ...(permit ? { permit } : {}),
      body: JSON.stringify({ id, recipient: to.address, ciphertext: btoa('hello!!') }),
    });
  return { req, body, login, send, seen };
};

const pushesTo = (seen: { subject: string }[], who: string) => seen.filter((s) => s.subject === who).length;

describe('policy', () => {
  it('defaults to open, so an identity that never chose is reachable as before', async () => {
    const { req, body, login } = await build();
    const alice = await login('p1-alice');
    expect(await body<{ policy: string }>(await req('/dm/policy', { method: 'GET', token: alice.token }))).toEqual({
      policy: 'open',
    });
  });

  it('round-trips a policy the owner sets, and refuses one it does not understand', async () => {
    const { req, body, login } = await build();
    const alice = await login('p2-alice');
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'permit' }) });
    expect(await body<{ policy: string }>(await req('/dm/policy', { method: 'GET', token: alice.token }))).toEqual({
      policy: 'permit',
    });
    const bad = await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'OPEN' }) });
    expect(bad.status).toBe(400);
  });
});

describe('reaching someone', () => {
  // The permissive default plus auto-issue: a stranger gets through *and* the conversation gains an
  // id, which is what mute will later name.
  it('lets a stranger through under an open policy and hands back a permit', async () => {
    const { body, login, send } = await build();
    const alice = await login('o1-alice');
    const bob = await login('o1-bob');
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'o1-m1');
    expect(res.status).toBe(201);
    expect(await body<{ permit?: string }>(res)).toHaveProperty('permit');
  });

  it('refuses a stranger under a permit policy', async () => {
    const { req, login, send } = await build();
    const alice = await login('o2-alice');
    const bob = await login('o2-bob');
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'permit' }) });
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'o2-m1');
    expect(res.status).toBe(403);
  });

  it('lets a permitted sender through under a permit policy', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('o3-alice');
    const bob = await login('o3-bob');
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'permit' }) });
    const granted = await body<{ permit: string }>(
      await req('/dm/permits', { method: 'POST', token: alice.token, body: JSON.stringify({ bearer: bob.address }) }),
    );
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'o3-m1', granted.permit);
    expect(res.status).toBe(201);
  });

  // Targeted, not bearer: the permit names Bob, so finding it does Mallory no good.
  it('refuses a permit presented by someone it does not name', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('o4-alice');
    const bob = await login('o4-bob');
    const mallory = await login('o4-mallory');
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'permit' }) });
    const granted = await body<{ permit: string }>(
      await req('/dm/permits', { method: 'POST', token: alice.token, body: JSON.stringify({ bearer: bob.address }) }),
    );
    const res = await send(mallory, alice, conversationId(alice.address, mallory.address), 'o4-m1', granted.permit);
    expect(res.status).toBe(403);
  });

  it('refuses a stranger when closed', async () => {
    const { req, login, send } = await build();
    const alice = await login('o5-alice');
    const bob = await login('o5-bob');
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'closed' }) });
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'o5-m1');
    expect(res.status).toBe(403);
  });

  // ⚠️ "Nobody **new**" — the copy on the setting, and now the behaviour. Alice granted Bob a permit
  // and then closed her inbox; Bob is somebody she already decided about, so he still gets through.
  // Block is how she takes that decision back. Until 2026-09-02 this returned 403.
  it('still lets an already-permitted sender through when closed', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('o5b-alice');
    const bob = await login('o5b-bob');
    const granted = await body<{ permit: string }>(
      await req('/dm/permits', { method: 'POST', token: alice.token, body: JSON.stringify({ bearer: bob.address }) }),
    );
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'closed' }) });
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'o5b-m1', granted.permit);
    expect(res.status).toBe(201);
  });

  // The other half: an invite names nobody, so converting one admits a stranger — which is the one
  // thing `closed` refuses. A link handed out before closing the inbox stops working.
  it('refuses to convert an invite when closed', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('o5c-alice');
    const bob = await login('o5c-bob');
    const invite = await body<{ permit: string }>(
      await req('/dm/permits', { method: 'POST', token: alice.token, body: JSON.stringify({}) }),
    );
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'closed' }) });
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'o5c-m1', invite.permit);
    expect(res.status).toBe(403);
  });

  // Refusing at the claim matters: a key package is single-use, so a conversation that cannot happen
  // must not cost one.
  it('refuses the key-package claim too, before a package is burned', async () => {
    const { req, body, login } = await build();
    const alice = await login('o6-alice');
    const bob = await login('o6-bob');
    await req('/dm/key-packages', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ packages: [btoa('kp-one!!')] }),
    });
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'permit' }) });
    const claim = await req(`/dm/key-packages/${encodeURIComponent(alice.address)}/claim`, {
      method: 'POST',
      token: bob.token,
    });
    expect(claim.status).toBe(403);
    const left = await body<{ available: number }>(await req('/dm/key-packages', { method: 'GET', token: alice.token }));
    expect(left.available).toBe(1);
  });

  it('gates the Welcome route as well, since it reaches an inbox on its own', async () => {
    const { req, login } = await build();
    const alice = await login('o7-alice');
    const bob = await login('o7-bob');
    await req('/dm/policy', { method: 'PUT', token: alice.token, body: JSON.stringify({ policy: 'closed' }) });
    const res = await req(`/dm/${conversationId(alice.address, bob.address)}/welcome`, {
      method: 'POST',
      token: bob.token,
      body: JSON.stringify({ id: 'o7-w1', recipient: alice.address, welcome: btoa('welcome!'), ratchetTree: btoa('tree!!!!') }),
    });
    expect(res.status).toBe(403);
  });
});

describe('block', () => {
  it('refuses a blocked peer even holding a valid permit', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('b1-alice');
    const bob = await login('b1-bob');
    const granted = await body<{ permit: string }>(
      await req('/dm/permits', { method: 'POST', token: alice.token, body: JSON.stringify({ bearer: bob.address }) }),
    );
    await req('/dm/blocks', { method: 'POST', token: alice.token, body: JSON.stringify({ peer: bob.address }) });
    const res = await send(bob, alice, conversationId(alice.address, bob.address), 'b1-m1', granted.permit);
    expect(res.status).toBe(403);
  });

  // ⚠️ A sender must not be able to tell a block from a closed inbox: "you specifically are blocked"
  // is information the blocker did not agree to disclose.
  it('does not tell a sender whether they were blocked or the inbox is closed', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('b2-alice');
    const carol = await login('b2-carol');
    const bob = await login('b2-bob');
    await req('/dm/blocks', { method: 'POST', token: alice.token, body: JSON.stringify({ peer: bob.address }) });
    await req('/dm/policy', { method: 'PUT', token: carol.token, body: JSON.stringify({ policy: 'closed' }) });
    const blocked = await send(bob, alice, conversationId(alice.address, bob.address), 'b2-m1');
    const closed = await send(bob, carol, conversationId(carol.address, bob.address), 'b2-m2');
    expect(blocked.status).toBe(closed.status);
    expect(await body(blocked)).toEqual(await body(closed));
  });

  it('lists and lifts a block', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('b3-alice');
    const bob = await login('b3-bob');
    await req('/dm/blocks', { method: 'POST', token: alice.token, body: JSON.stringify({ peer: bob.address }) });
    expect((await body<{ blocks: { peer: string }[] }>(await req('/dm/blocks', { method: 'GET', token: alice.token }))).blocks).toEqual([
      { peer: bob.address, createdAt: expect.any(String) },
    ]);
    await req(`/dm/blocks/${encodeURIComponent(bob.address)}`, { method: 'DELETE', token: alice.token });
    expect((await send(bob, alice, conversationId(alice.address, bob.address), 'b3-m1')).status).toBe(201);
  });

  it('refuses to block yourself, which would break the notes-to-self path', async () => {
    const { req, login } = await build();
    const alice = await login('b4-alice');
    const res = await req('/dm/blocks', { method: 'POST', token: alice.token, body: JSON.stringify({ peer: alice.address }) });
    expect(res.status).toBe(400);
  });
});

describe('mute', () => {
  // The property the whole design turns on: muting is not un-accepting.
  it('still delivers a muted sender, but stops the wake', async () => {
    const { req, body, login, send, seen } = await build();
    const alice = await login('m1-alice');
    const bob = await login('m1-bob');
    const conv = conversationId(alice.address, bob.address);
    const first = await body<{ permit: string }>(await send(bob, alice, conv, 'm1-1'));

    // Alice learns the id from the row she reads — no pair is stored to find it.
    const inbox = await body<{ messages: { permitJti?: string }[] }>(
      await req(`/dm/${conv}/messages`, { method: 'GET', token: alice.token }),
    );
    const jti = inbox.messages[0]?.permitJti;
    expect(jti).toBeTruthy();

    await req('/dm/permits/revoke', { method: 'POST', token: alice.token, body: JSON.stringify({ jti }) });
    const before = pushesTo(seen, alice.address);
    const muted = await send(bob, alice, conv, 'm1-2', first.permit);
    expect(muted.status).toBe(201);
    expect(pushesTo(seen, alice.address)).toBe(before);

    const read = await body<{ messages: unknown[] }>(await req(`/dm/${conv}/messages`, { method: 'GET', token: alice.token }));
    expect(read.messages).toHaveLength(2);
  });

  it('wakes the recipient when not muted, so the test above is measuring something', async () => {
    const { login, send, seen } = await build();
    const alice = await login('m2-alice');
    const bob = await login('m2-bob');
    await send(bob, alice, conversationId(alice.address, bob.address), 'm2-1');
    expect(pushesTo(seen, alice.address)).toBe(1);
  });

  // ⚠️ Never auto-issue over a revocation: a fresh id would un-mute on the very next message.
  it('does not hand a muted sender a replacement permit', async () => {
    const { req, body, login, send } = await build();
    const alice = await login('m3-alice');
    const bob = await login('m3-bob');
    const conv = conversationId(alice.address, bob.address);
    const first = await body<{ permit: string }>(await send(bob, alice, conv, 'm3-1'));
    const inbox = await body<{ messages: { permitJti?: string }[] }>(
      await req(`/dm/${conv}/messages`, { method: 'GET', token: alice.token }),
    );
    await req('/dm/permits/revoke', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ jti: inbox.messages[0]?.permitJti }),
    });
    const next = await body<{ permit?: string }>(await send(bob, alice, conv, 'm3-2', first.permit));
    expect(next).not.toHaveProperty('permit');
  });

  it('unmutes outright', async () => {
    const { req, body, login, send, seen } = await build();
    const alice = await login('m4-alice');
    const bob = await login('m4-bob');
    const conv = conversationId(alice.address, bob.address);
    const first = await body<{ permit: string }>(await send(bob, alice, conv, 'm4-1'));
    const inbox = await body<{ messages: { permitJti?: string }[] }>(
      await req(`/dm/${conv}/messages`, { method: 'GET', token: alice.token }),
    );
    const jti = inbox.messages[0]?.permitJti;
    await req('/dm/permits/revoke', { method: 'POST', token: alice.token, body: JSON.stringify({ jti }) });
    await req('/dm/permits/unrevoke', { method: 'POST', token: alice.token, body: JSON.stringify({ jti }) });
    const before = pushesTo(seen, alice.address);
    await send(bob, alice, conv, 'm4-2', first.permit);
    expect(pushesTo(seen, alice.address)).toBe(before + 1);
  });

  // The cutoff, not a flag: a permit minted after the revocation is a deliberate re-grant.
  it('lets a permit issued after the revocation through', async () => {
    const { req, body, login, send, seen } = await build();
    const alice = await login('m5-alice');
    const bob = await login('m5-bob');
    const conv = conversationId(alice.address, bob.address);
    const first = await body<{ permit: string }>(await send(bob, alice, conv, 'm5-1'));
    const inbox = await body<{ messages: { permitJti?: string }[] }>(
      await req(`/dm/${conv}/messages`, { method: 'GET', token: alice.token }),
    );
    await req('/dm/permits/revoke', {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ jti: inbox.messages[0]?.permitJti }),
    });
    expect(first.permit).toBeTruthy();
    const regranted = await body<{ permit: string }>(
      await req('/dm/permits', { method: 'POST', token: alice.token, body: JSON.stringify({ bearer: bob.address }) }),
    );
    const before = pushesTo(seen, alice.address);
    await send(bob, alice, conv, 'm5-2', regranted.permit);
    expect(pushesTo(seen, alice.address)).toBe(before + 1);
  });
});

describe('invites', () => {
  // The shape a QR or a link posted in a circle needs: the issuer cannot know who will take it up.
  it('lets anyone convert an invite, under a permit policy', async () => {
    const {req, body, login, send} = await build();
    const alice = await login('i1-alice');
    const bob = await login('i1-bob');
    await req('/dm/policy', {method: 'PUT', token: alice.token, body: JSON.stringify({policy: 'permit'})});
    const invite = await body<{permit: string; invite: boolean}>(
      await req('/dm/permits', {method: 'POST', token: alice.token, body: JSON.stringify({})}),
    );
    expect(invite.invite).toBe(true);
    const sent = await send(bob, alice, conversationId(alice.address, bob.address), 'i1-m1', invite.permit);
    expect(sent.status).toBe(201);
    // ⚠️ Converted, not kept: the sender is handed a permit of their own so they are individually
    // muteable from here on.
    expect(await body<{permit?: string}>(sent)).toHaveProperty('permit');
  });

  it('serves the same invite to two different people', async () => {
    const {req, body, login, send} = await build();
    const alice = await login('i2-alice');
    const bob = await login('i2-bob');
    const carol = await login('i2-carol');
    await req('/dm/policy', {method: 'PUT', token: alice.token, body: JSON.stringify({policy: 'permit'})});
    const invite = await body<{permit: string}>(
      await req('/dm/permits', {method: 'POST', token: alice.token, body: JSON.stringify({})}),
    );
    for (const [i, who] of [bob, carol].entries()) {
      const sent = await send(who, alice, conversationId(alice.address, who.address), `i2-m${i}`, invite.permit);
      expect(sent.status).toBe(201);
    }
  });

  // Revoking the link closes the door to new people. It deliberately does not un-admit whoever
  // already walked through it — their permits carry their own ids, so they are muted or blocked
  // individually.
  it('stops new conversions once revoked, without un-admitting who already converted', async () => {
    const {req, body, login, send} = await build();
    const alice = await login('i3-alice');
    const bob = await login('i3-bob');
    const carol = await login('i3-carol');
    await req('/dm/policy', {method: 'PUT', token: alice.token, body: JSON.stringify({policy: 'permit'})});
    const invite = await body<{permit: string; jti: string}>(
      await req('/dm/permits', {method: 'POST', token: alice.token, body: JSON.stringify({})}),
    );
    const bobConv = conversationId(alice.address, bob.address);
    const bobsOwn = await body<{permit: string}>(await send(bob, alice, bobConv, 'i3-m1', invite.permit));

    await req('/dm/permits/revoke', {method: 'POST', token: alice.token, body: JSON.stringify({jti: invite.jti})});

    const carolTries = await send(carol, alice, conversationId(alice.address, carol.address), 'i3-m2', invite.permit);
    expect(carolTries.status).toBe(403);
    const bobContinues = await send(bob, alice, bobConv, 'i3-m3', bobsOwn.permit);
    expect(bobContinues.status).toBe(201);
  });

  it('is still refused by a block, like any other permit', async () => {
    const {req, body, login, send} = await build();
    const alice = await login('i4-alice');
    const bob = await login('i4-bob');
    const invite = await body<{permit: string}>(
      await req('/dm/permits', {method: 'POST', token: alice.token, body: JSON.stringify({})}),
    );
    await req('/dm/blocks', {method: 'POST', token: alice.token, body: JSON.stringify({peer: bob.address})});
    const sent = await send(bob, alice, conversationId(alice.address, bob.address), 'i4-m1', invite.permit);
    expect(sent.status).toBe(403);
  });
});
