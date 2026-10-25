// Push notifications: intent production + device fan-out with a fake sender, and the
// JWT-authed POST /devices endpoint.
import { authChallengeMessage, authKeyPair, deviceBindingMessage, encodePnyxId } from '@pnyx/contract-client/identity';
import { ed25519 } from '@noble/curves/ed25519.js';
import { SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import {
  createNotifier,
  type NotificationIntent,
  type PushSender,
  UnregisteredDeviceError,
} from './notifications.js';
import { createNonceStore } from './nonce.js';
import { createHandler } from './routes.js';
import { type ContentStore, createContentStore } from './store.js';

const fakeSender = (): PushSender & { sent: { fcmToken: string; intent: NotificationIntent }[] } => {
  const sent: { fcmToken: string; intent: NotificationIntent }[] = [];
  return {
    name: 'fake',
    sent,
    send: async (fcmToken, intent) => {
      sent.push({ fcmToken, intent });
    },
  };
};

const seedCircle = async (store: ContentStore) => {
  const circle = await store.createCircle({
    name: 'Push',
    description: '',
    subject: 'dev:owner',
    persona: 'owner',
    disclosed: false,
    isOpen: true,
  });
  await store.join({ circleId: circle.id, subject: 'dev:member', persona: 'member', disclosed: false });
  return circle;
};

describe('notification intents', () => {
  it('a DM notifies the recipient on every device, carrying no conversation and no content', async () => {
    const store = createContentStore();
    const sender = fakeSender();
    const published: { subject: string; event: unknown }[] = [];
    const notify = createNotifier(store, sender, () => {}, {
      publish: async (subject, event) => {
        published.push({ subject, event });
      },
    });
    await store.registerDevice('dev:recipient', { fcmToken: 'tok-phone', platform: 'android' });
    await store.registerDevice('dev:recipient', { fcmToken: 'tok-tablet', platform: 'ios' });

    const intents = await notify.dmArrived('dev:recipient', 'dm-message');

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ subjectAddress: 'dev:recipient', kind: 'dm-message' });
    // The privacy contract: no circle, no conversation id, no message text anywhere in the payload.
    expect(intents[0]).not.toHaveProperty('communityId');
    expect(Object.keys(intents[0]?.payload ?? {}).sort()).toEqual(['body', 'screen', 'title']);
    expect(sender.sent.map((s) => s.fcmToken).sort()).toEqual(['tok-phone', 'tok-tablet']);
    // The socket wake rides on the same recipient resolution as the push.
    expect(published).toEqual([{ subject: 'dev:recipient', event: { kind: 'dm-waiting' } }]);
  });

  it('an invite is its own kind, so the copy can differ from a message', async () => {
    const store = createContentStore();
    const sender = fakeSender();
    const notify = createNotifier(store, sender, () => {});
    await store.registerDevice('dev:recipient', { fcmToken: 'tok-phone', platform: 'android' });

    const [message] = await notify.dmArrived('dev:recipient', 'dm-message');
    const [invite] = await notify.dmArrived('dev:recipient', 'dm-invite');

    expect(invite?.kind).toBe('dm-invite');
    expect(invite?.payload.title).not.toBe(message?.payload.title);
    // Both land on the inbox, which is all a payload with no conversation id can address.
    expect(invite?.payload.screen).toBe('dm');
    expect(message?.payload.screen).toBe('dm');
  });

  it('a DM to someone with no registered device still wakes an open app', async () => {
    const store = createContentStore();
    const sender = fakeSender();
    const published: unknown[] = [];
    const logs: string[] = [];
    const notify = createNotifier(store, sender, (m) => logs.push(m), {
      publish: async (_subject, event) => {
        published.push(event);
      },
    });

    await notify.dmArrived('dev:deviceless', 'dm-message');

    expect(sender.sent).toEqual([]);
    expect(published).toEqual([{ kind: 'dm-waiting' }]);
    expect(logs.join(' ')).toContain('no registered devices');
  });

  it('a reply notifies the parent author on every registered device; roots and self-replies do not', async () => {
    const store = createContentStore();
    const sender = fakeSender();
    const notify = createNotifier(store, sender, () => {});
    const circle = await seedCircle(store);
    await store.registerDevice('dev:owner', { fcmToken: 'tok-owner-phone', platform: 'android' });
    await store.registerDevice('dev:owner', { fcmToken: 'tok-owner-tablet', platform: 'ios' });

    const root = await store.createPost({ circleId: circle.id, body: 'root', author: 'owner' });
    expect(await notify.postCreated(circle.id, root, 'dev:owner')).toEqual([]); // no parent → no intent

    const reply = await store.createPost({ circleId: circle.id, parentId: root.id, body: 'hi!', author: 'member' });
    const intents = await notify.postCreated(circle.id, reply, 'dev:member');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      subjectAddress: 'dev:owner',
      communityId: circle.id,
      kind: 'post-reply',
      payload: { author: 'member', parentId: root.id, postId: reply.id },
    });
    // fan-out: one send per device
    expect(sender.sent.map((s) => s.fcmToken).sort()).toEqual(['tok-owner-phone', 'tok-owner-tablet']);

    const selfReply = await store.createPost({ circleId: circle.id, parentId: root.id, body: 'me', author: 'owner' });
    expect(await notify.postCreated(circle.id, selfReply, 'dev:owner')).toEqual([]);
  });

  it('a new proposal notifies every member except the author', async () => {
    const store = createContentStore();
    const sender = fakeSender();
    const notify = createNotifier(store, sender, () => {});
    const circle = await seedCircle(store);
    await store.join({ circleId: circle.id, subject: 'dev:third', persona: 'third', disclosed: false });
    await store.registerDevice('dev:member', { fcmToken: 'tok-member', platform: 'ios' });
    // dev:third has no devices — intent still produced, nothing sent.

    const proposal = await store.createProposal({ circleId: circle.id, title: 'Fund it', body: '', author: 'owner' });
    const intents = await notify.proposalCreated(circle.id, proposal, 'dev:owner');
    expect(intents.map((i) => i.subjectAddress).sort()).toEqual(['dev:member', 'dev:third']);
    expect(intents.every((i) => i.kind === 'new-proposal')).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ fcmToken: 'tok-member' });
    expect(sender.sent[0]?.intent.payload.proposalId).toBe(proposal.id);
  });

  it('a vote notifies the proposal author with the updated tally (poll result)', async () => {
    const store = createContentStore();
    const sender = fakeSender();
    const notify = createNotifier(store, sender, () => {});
    const circle = await seedCircle(store);
    await store.registerDevice('dev:owner', { fcmToken: 'tok-owner', platform: 'android' });

    const proposal = await store.createProposal({ circleId: circle.id, title: 'Poll', body: '', author: 'owner' });
    const updated = await store.castVote({ proposalId: proposal.id, subject: 'dev:member', value: 'yes' });
    if (updated === 'already-voted') {
      throw new Error('unexpected');
    }
    const intents = await notify.voteCast(circle.id, updated, 'dev:member');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      subjectAddress: 'dev:owner',
      kind: 'poll-result',
      payload: { proposalId: proposal.id, yes: '1', no: '0' },
    });

    // the author voting on their own proposal notifies nobody
    const own = await store.castVote({ proposalId: proposal.id, subject: 'dev:owner', value: 'no' });
    if (own === 'already-voted') {
      throw new Error('unexpected');
    }
    expect(await notify.voteCast(circle.id, own, 'dev:owner')).toEqual([]);
  });

  it('keeps delivering to remaining devices when one send fails', async () => {
    const store = createContentStore();
    const sent: string[] = [];
    const flaky: PushSender = {
      name: 'flaky',
      send: async (fcmToken) => {
        if (fcmToken === 'tok-bad') {
          throw new Error('FCM 404: unregistered');
        }
        sent.push(fcmToken);
      },
    };
    const logs: string[] = [];
    const notify = createNotifier(store, flaky, (m) => logs.push(m));
    const circle = await seedCircle(store);
    await store.registerDevice('dev:owner', { fcmToken: 'tok-bad', platform: 'ios' });
    await store.registerDevice('dev:owner', { fcmToken: 'tok-good', platform: 'android' });

    const root = await store.createPost({ circleId: circle.id, body: 'root', author: 'owner' });
    const reply = await store.createPost({ circleId: circle.id, parentId: root.id, body: 'r', author: 'member' });
    const intents = await notify.postCreated(circle.id, reply, 'dev:member');
    expect(intents).toHaveLength(1);
    expect(sent).toEqual(['tok-good']);
    expect(logs.join('\n')).toContain('FCM 404');
  });
});

// A dead install must be forgotten rather than retried on every future notification. The store method
// existing is not the same as the fan-out calling it, which is what this covers.
describe('unregistered device pruning', () => {
  it('drops a token the sender reports unregistered, and keeps sending to the others', async () => {
    const store = createContentStore();
    const circle = await seedCircle(store);
    await store.registerDevice('dev:owner', { fcmToken: 'tok-dead', platform: 'android' });
    await store.registerDevice('dev:owner', { fcmToken: 'tok-live', platform: 'ios' });

    const sent: string[] = [];
    const sender: PushSender = {
      name: 'selective',
      send: async (fcmToken) => {
        if (fcmToken === 'tok-dead') throw new UnregisteredDeviceError(fcmToken);
        sent.push(fcmToken);
      },
    };
    const notify = createNotifier(store, sender, () => {});

    const root = await store.createPost({ circleId: circle.id, body: 'root', author: 'owner' });
    const reply = await store.createPost({
      circleId: circle.id,
      body: 'reply',
      author: 'member',
      parentId: root.id,
    });
    await notify.postCreated(circle.id, reply, 'dev:member');

    expect(await store.listDevices('dev:owner')).toEqual([
      expect.objectContaining({ fcmToken: 'tok-live' }),
    ]);
    expect(sent).toEqual(['tok-live']);
  });

  // Anything else is transient as far as we can tell, so the token stays.
  it('keeps a token when the send fails for any other reason', async () => {
    const store = createContentStore();
    const circle = await seedCircle(store);
    await store.registerDevice('dev:owner', { fcmToken: 'tok-a', platform: 'android' });
    const notify = createNotifier(
      store,
      {
        name: 'always-fails',
        send: async () => {
          throw new Error('FCM send failed (429): quota');
        },
      },
      () => {},
    );
    const root = await store.createPost({ circleId: circle.id, body: 'root', author: 'owner' });
    const reply = await store.createPost({
      circleId: circle.id,
      body: 'reply',
      author: 'member',
      parentId: root.id,
    });
    await notify.postCreated(circle.id, reply, 'dev:member');
    expect(await store.listDevices('dev:owner')).toHaveLength(1);
  });
});

describe('POST /devices', () => {
  let handler: (request: Request) => Promise<Response>;
  let store: ContentStore;

  beforeAll(async () => {
    const keys = await createJwtKeys();
    store = createContentStore();
    handler = createHandler({
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
      chain: disabledChainMirror,
      notify: createNotifier(store, fakeSender(), () => {}),
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

  it('requires auth, validates the body, and upserts by token', async () => {
    expect((await req('/devices', { method: 'POST', body: JSON.stringify({ fcmToken: 't', platform: 'ios' }) })).status).toBe(401);

    const login = await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name: 'push-user' }) });
    const { token } = (await login.json()) as { token: string };

    expect((await req('/devices', { method: 'POST', token, body: JSON.stringify({ fcmToken: 'fcm-1' }) })).status).toBe(400);

    const created = await req('/devices', {
      method: 'POST',
      token,
      body: JSON.stringify({ fcmToken: 'fcm-1', platform: 'android' }),
    });
    expect(created.status).toBe(201);
    expect(await store.listDevices('dev:push-user')).toMatchObject([{ fcmToken: 'fcm-1', platform: 'android' }]);

    // same token re-registered (e.g. token rotation to a new account) stays single
    const again = await req('/devices', {
      method: 'POST',
      token,
      body: JSON.stringify({ fcmToken: 'fcm-1', platform: 'ios' }),
    });
    expect(again.status).toBe(201);
    const devices = await store.listDevices('dev:push-user');
    expect(devices).toHaveLength(1);
    expect(devices[0]?.platform).toBe('ios');
  });
});

// A real identity must prove it owns the token it claims. The JWT establishes that *someone*
// authenticated as this identity, but it is a bearer credential: without the signature, anyone
// holding one could point the identity's notifications at their own device and learn who messages
// it and which circles are busy.
describe('POST /devices — identity binding', () => {
  const bytes32 = (b: number) => new Uint8Array(32).fill(b);
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

  const pair = authKeyPair(bytes32(0x5a));
  const identity = encodePnyxId(bytes32(0x2a));

  let store: ContentStore;
  let handler: (request: Request) => Response | Promise<Response>;
  let jwt: Awaited<ReturnType<typeof createJwtKeys>>;
  let rows: Map<string, { anchor: Uint8Array; authPub: Uint8Array; name: Uint8Array }>;

  const auth = () => ({
    domain: 'pnyx.test',
    network: 'undeployed',
    nonces: nonces,
    jwt: {
      privateKey: jwt.privateKey,
      kid: jwt.kid,
      issuer: 'https://pnyx-content-service',
      audience: 'pnyx',
      ttlSeconds: 3600,
    },
  });

  let nonces: ReturnType<typeof createNonceStore>;

  beforeEach(async () => {
    jwt = await createJwtKeys();
    store = createContentStore();
    nonces = createNonceStore();
    rows = new Map([[hex(bytes32(0x2a)), { anchor: bytes32(1), authPub: pair.publicKey, name: new Uint8Array(32) }]]);
    handler = createHandler({
      auth: auth(),
      publicJwk: jwt.publicJwk,
      store,
      // Off, so nothing here can fall through the `dev:` exemption.
      devAuth: false,
      chain: { ...disabledChainMirror, rowReads: true, identityRow: async (id) => rows.get(hex(id)) },
      notify: createNotifier(store, fakeSender(), () => {}),
    });
  });

  /** A session JWT for `identity`, minted the way `identityLogin` would. */
  const sessionToken = async () =>
    await new SignJWT({ network: 'undeployed' })
      .setProtectedHeader({ alg: 'ES256', kid: jwt.kid })
      .setSubject(identity)
      .setIssuer('https://pnyx-content-service')
      .setAudience('pnyx')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(jwt.privateKey);

  const register = async (body: Record<string, unknown>, token: string) =>
    handler(
      new Request('http://svc/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );

  const signedBody = async (fcmToken: string, platform: string) => {
    const nonce = await nonces.issue();
    const message = deviceBindingMessage('pnyx.test', 'undeployed', identity, nonce, fcmToken, platform);
    return { fcmToken, platform, nonce, signature: hex(ed25519.sign(message, pair.secretKey)) };
  };

  it('accepts a binding signed by the identity that owns the row', async () => {
    const res = await register(await signedBody('fcm-real', 'android'), await sessionToken());
    expect(res.status).toBe(201);
    expect(await store.listDevices(identity)).toMatchObject([{ fcmToken: 'fcm-real', platform: 'android' }]);
  });

  // The whole point: a stolen bearer token is not enough.
  it('rejects a valid JWT with no signature', async () => {
    const res = await register({ fcmToken: 'fcm-real', platform: 'android' }, await sessionToken());
    expect(res.status).toBe(400);
    expect(await store.listDevices(identity)).toEqual([]);
  });

  it('rejects a signature from a different key', async () => {
    const nonce = await nonces.issue();
    const message = deviceBindingMessage('pnyx.test', 'undeployed', identity, nonce, 'fcm-real', 'android');
    const res = await register(
      {
        fcmToken: 'fcm-real',
        platform: 'android',
        nonce,
        signature: hex(ed25519.sign(message, authKeyPair(bytes32(0x99)).secretKey)),
      },
      await sessionToken(),
    );
    expect(res.status).toBe(401);
    expect(await store.listDevices(identity)).toEqual([]);
  });

  // The token is inside the signed bytes, so a captured signature cannot be paired with a token of
  // the attacker's choosing — which is exactly the device swap this endpoint has to prevent.
  it('rejects a signature bound to a different token', async () => {
    const body = await signedBody('fcm-victim', 'android');
    const res = await register({ ...body, fcmToken: 'fcm-attacker' }, await sessionToken());
    expect(res.status).toBe(401);
    expect(await store.listDevices(identity)).toEqual([]);
  });

  it('rejects a replayed nonce', async () => {
    const body = await signedBody('fcm-real', 'android');
    expect((await register(body, await sessionToken())).status).toBe(201);
    expect((await register(body, await sessionToken())).status).toBe(401);
  });

  // A login signature and a binding signature come from the same key; only the domain tag separates
  // them. If one could stand in for the other, logging in would authorise a device swap.
  it('rejects a login challenge signature presented as a binding', async () => {
    const nonce = await nonces.issue();
    const login = authChallengeMessage('pnyx.test', 'undeployed', identity, nonce);
    const res = await register(
      { fcmToken: 'fcm-real', platform: 'android', nonce, signature: hex(ed25519.sign(login, pair.secretKey)) },
      await sessionToken(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a binding for an identity with no published row', async () => {
    rows.clear();
    const res = await register(await signedBody('fcm-real', 'android'), await sessionToken());
    expect(res.status).toBe(401);
  });
});
