// The realtime signalling plane: the frame protocol, and who gets woken by what.
import { conversationId } from '@pnyx/contract-client/dm-conversation';
import { describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { decodeFrame, encodeFrame, type RealtimeEvent, type RealtimePublisher } from './realtime.js';
import { createHandler, REALTIME_AUDIENCE } from './routes.js';
import { type ContentStore, createContentStore } from './store.js';

const recorder = () => {
  const seen: { subject: string; event: RealtimeEvent }[] = [];
  const publisher: RealtimePublisher = { publish: async (subject, event) => void seen.push({ subject, event }) };
  return { seen, publisher };
};

describe('frame protocol', () => {
  it('round-trips every event kind', () => {
    const events: RealtimeEvent[] = [
      { kind: 'dm-waiting' },
      { kind: 'community-changed', communityId: 'c1' },
      { kind: 'chain-settled', communityId: 'c1' },
      { kind: 'proposal-changed', communityId: 'c1', proposalId: 'p1' },
    ];
    for (const event of events) {
      expect(decodeFrame(encodeFrame(event))).toEqual(event);
    }
  });

  // An app update lags a Worker deploy by however long a store review takes, so a client must be able
  // to ignore an event kind it has never heard of rather than misread it as one it knows.
  it.each([
    ['not json', 'nope{'],
    ['a future version', JSON.stringify({ v: 2, event: { kind: 'dm-waiting' } })],
    ['an unknown kind', JSON.stringify({ v: 1, event: { kind: 'circle-deleted', communityId: 'c1' } })],
    ['a missing id', JSON.stringify({ v: 1, event: { kind: 'community-changed' } })],
    ['a missing proposal id', JSON.stringify({ v: 1, event: { kind: 'proposal-changed', communityId: 'c1' } })],
  ])('drops %s', (_label, raw) => {
    expect(decodeFrame(raw)).toBeUndefined();
  });
});

const buildHandler = async (store: ContentStore, realtime: RealtimePublisher) => {
  const keys = await createJwtKeys();
  return {
    keys,
    handler: createHandler({
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
      chain: { ...disabledChainMirror, enabled: true, submitIdentityRow: async () => {} },
      notify: createNotifier(store, loggingPushSender(() => {}), () => {}, realtime),
      sponsorToken: 'sponsor-secret',
      realtime,
    }),
  };
};

const login = async (handler: (r: Request) => Promise<Response>, name: string) => {
  const res = await handler(
    new Request('http://svc/auth/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
  return ((await res.json()) as { token: string }).token;
};

describe('POST /realtime/ticket', () => {
  it('issues a short-lived, audience-separated ticket', async () => {
    const { keys, handler } = await buildHandler(createContentStore(), recorder().publisher);
    const token = await login(handler, 'ticketed');
    const res = await handler(
      new Request('http://svc/realtime/ticket', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(200);
    const { ticket, expiresInSeconds } = (await res.json()) as { ticket: string; expiresInSeconds: number };
    expect(expiresInSeconds).toBe(60);

    const { importJWK, jwtVerify } = await import('jose');
    const key = await importJWK(keys.publicJwk as never, 'ES256');
    const { payload } = await jwtVerify(ticket, key, {
      issuer: 'https://pnyx-content-service',
      audience: REALTIME_AUDIENCE,
    });
    expect(payload.sub).toBe('dev:ticketed');
    // ~60s, not an hour: it travels in a URL, where anything in the path may log it.
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(60);

    // The audience split is the point — a ticket must not open the write routes.
    await expect(jwtVerify(ticket, key, { issuer: 'https://pnyx-content-service', audience: 'pnyx' })).rejects.toThrow();
  });

  it('requires a session', async () => {
    const { handler } = await buildHandler(createContentStore(), recorder().publisher);
    expect((await handler(new Request('http://svc/realtime/ticket', { method: 'POST' }))).status).toBe(401);
  });
});

describe('who gets woken', () => {
  it('signals a DM recipient without naming the conversation', async () => {
    const store = createContentStore();
    const { seen, publisher } = recorder();
    const { handler } = await buildHandler(store, publisher);
    const token = await login(handler, 'sender');

    const convId = conversationId('dev:sender', 'dev:recipient');
    await handler(
      new Request(`http://svc/dm/${convId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: 'm1', recipient: 'dev:recipient', ciphertext: 'AQID' }),
      }),
    );

    expect(seen).toEqual([{ subject: 'dev:recipient', event: { kind: 'dm-waiting' } }]);
    // "who is talking to whom" is precisely what the opaque-relay design keeps out of this plane.
    expect(JSON.stringify(seen)).not.toContain(convId);
  });

  // What actually kills useCommunityView's 5s poll: a badge that flips for every member, live.
  it('signals every member when a circle settles on chain', async () => {
    const store = createContentStore();
    const { seen, publisher } = recorder();
    const { handler } = await buildHandler(store, publisher);
    const circle = await store.createCircle({
      name: 'C',
      description: '',
      subject: 'dev:owner',
      persona: 'owner',
      disclosed: true,
      isOpen: true,
    });
    await store.join({ circleId: circle.id, subject: 'dev:member', persona: 'member', disclosed: false });

    const res = await handler(
      new Request('http://svc/internal/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sponsor-secret' },
        body: JSON.stringify({
          settlement: { kind: 'circle', circleId: circle.id },
          chain: { status: 'confirmed', txId: 'tx-1' },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.subject).sort()).toEqual(['dev:member', 'dev:owner']);
    expect(seen.every((s) => s.event.kind === 'chain-settled')).toBe(true);
  });

  // A vote ref is that subject's own. Publishing it circle-wide would tell other members exactly when
  // a specific person voted, which the content plane deliberately does not reveal.
  it('signals only the voter when their own vote settles', async () => {
    const store = createContentStore();
    const { seen, publisher } = recorder();
    const { handler } = await buildHandler(store, publisher);
    const circle = await store.createCircle({
      name: 'C',
      description: '',
      subject: 'dev:owner',
      persona: 'owner',
      disclosed: true,
      isOpen: true,
    });
    await store.join({ circleId: circle.id, subject: 'dev:voter', persona: 'voter', disclosed: false });
    const proposal = await store.createProposal({ circleId: circle.id, title: 'P', body: '', author: 'owner' });

    await handler(
      new Request('http://svc/internal/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sponsor-secret' },
        body: JSON.stringify({
          settlement: { kind: 'vote', proposalId: proposal.id, subject: 'dev:voter' },
          chain: { status: 'confirmed', txId: 'tx-2' },
        }),
      }),
    );
    expect(seen).toEqual([
      {
        subject: 'dev:voter',
        event: { kind: 'proposal-changed', communityId: circle.id, proposalId: proposal.id },
      },
    ]);
  });

  // Push and socket must not disagree about who cares, which is why both derive from the same intents.
  it('signals the same recipient the push fan-out targets', async () => {
    const store = createContentStore();
    const { seen, publisher } = recorder();
    const notify = createNotifier(store, loggingPushSender(() => {}), () => {}, publisher);
    const circle = await store.createCircle({
      name: 'C',
      description: '',
      subject: 'dev:owner',
      persona: 'owner',
      disclosed: true,
      isOpen: true,
    });
    await store.join({ circleId: circle.id, subject: 'dev:member', persona: 'member', disclosed: false });
    const root = await store.createPost({ circleId: circle.id, body: 'root', author: 'owner' });
    const reply = await store.createPost({ circleId: circle.id, parentId: root.id, body: 'r', author: 'member' });

    const intents = await notify.postCreated(circle.id, reply, 'dev:member');
    expect(intents.map((i) => i.subjectAddress)).toEqual(['dev:owner']);
    expect(seen).toEqual([{ subject: 'dev:owner', event: { kind: 'community-changed', communityId: circle.id } }]);
  });

  // A signalling failure must never fail the write that triggered it: the post is the product.
  it('does not fail a write when publishing throws', async () => {
    const store = createContentStore();
    const throwing: RealtimePublisher = {
      publish: async () => {
        throw new Error('hub unreachable');
      },
    };
    const { handler } = await buildHandler(store, throwing);
    const token = await login(handler, 'sender');
    const res = await handler(
      new Request(`http://svc/dm/${conversationId('dev:sender', 'dev:recipient')}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: 'm2', recipient: 'dev:recipient', ciphertext: 'AQID' }),
      }),
    );
    // The message is stored; only the wake was lost, and the recipient refetches on connect.
    expect(res.status).toBe(201);
  });
});
