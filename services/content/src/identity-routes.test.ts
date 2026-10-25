// Identity registration and resolution (docs/PNYX_IDENTITY_PLAN.md).
//
// What is worth asserting is the *authorisation posture*, since it inverts the old keybook's:
// `/register` is deliberately unauthenticated, and that is safe only because the service cannot
// author what it relays — the transaction's circuit binds it to a secret the service does not have.
//
// `GET /identities/:C` was deleted once the app began reading rows from an indexer directly; the
// row read that remains is the server-side one inside `POST /auth/identity`, covered below.
import { pnyxIdEquals, authChallengeMessage, authKeyPair, encodePnyxId } from '@pnyx/contract-client/identity';
import { ed25519 } from '@noble/curves/ed25519.js';
import { importJWK, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import type { ChainMirror } from './chain.js';
import { disabledChainMirror } from './chain.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { createMemoryRateLimiter } from './rate-limit.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

const C = 'a'.repeat(64);
const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);

let handler: (request: Request) => Promise<Response>;
let publicJwk: Record<string, unknown>;
let submitted: Uint8Array[] = [];
let rows: Map<string, { anchor: Uint8Array; authPub: Uint8Array; name: Uint8Array }>;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

beforeAll(async () => {
  const keys = await createJwtKeys();
  publicJwk = keys.publicJwk;
  const store = createContentStore();
  rows = new Map([[C, { anchor: bytes32(0x70), authPub: bytes32(0x71), name: new Uint8Array(32) }]]);
  const chain: ChainMirror = {
    ...disabledChainMirror,
    enabled: true,
    // `rowReads` is separate from `enabled` on purpose (a Worker can read rows without a write
    // mirror), so a mirror that serves logins has to say so explicitly.
    rowReads: true,
    identityRow: async (identity) => rows.get(hex(identity)),
    submitIdentityRow: async (tx) => {
      submitted.push(tx);
    },
  };
  handler = createHandler({
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
  });
});

const req = (path: string, init?: RequestInit) =>
  handler(new Request(`http://svc${path}`, { ...init, headers: { 'content-type': 'application/json' } }));

describe('POST /register', () => {
  it('relays a proven transaction without requiring a session', async () => {
    submitted = [];
    const tx = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64');
    const res = await req('/register', { method: 'POST', body: JSON.stringify({ tx }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ registered: true });
    expect(submitted).toHaveLength(1);
  });

  // Unauthenticated by necessity, so the limit is what stops the sponsor's DUST from being an open
  // tap. Built with its own handler so the shared one's budget is not spent here.
  it('refuses past the rate limit, and does so before parsing the body', async () => {
    let bodyReads = 0;
    const limited = createHandler({
      auth: {
        domain: 'pnyx.test',
        network: 'undeployed',
        nonces: createNonceStore(),
        jwt: {
          privateKey: (await createJwtKeys()).privateKey,
          issuer: 'https://pnyx-content-service',
          audience: 'pnyx',
          ttlSeconds: 3600,
        },
      },
      publicJwk,
      store: createContentStore(),
      devAuth: false,
      chain: { ...disabledChainMirror, enabled: true, submitIdentityRow: async () => {} },
      notify: createNotifier(createContentStore(), loggingPushSender(() => {}), () => {}),
      registerLimit: createMemoryRateLimiter({ limit: 2, windowMs: 60_000, now: () => 1_000 }),
    });
    const send = () => {
      const body = JSON.stringify({ tx: Buffer.from(new Uint8Array([9])).toString('base64') });
      // A body that counts its own reads: an over-limit caller must not cost us a 4 MB parse.
      const request = new Request('http://svc/register', { method: 'POST', body });
      const original = request.json.bind(request);
      Object.defineProperty(request, 'json', {
        value: () => {
          bodyReads += 1;
          return original();
        },
      });
      return limited(request);
    };
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(bodyReads).toBe(2);
  });

  // The endpoint must never invent bytes: an empty or missing tx is the caller's error, not
  // something to forward and let the chain reject later.
  it('rejects a missing or empty transaction', async () => {
    expect((await req('/register', { method: 'POST', body: '{}' })).status).toBe(400);
    const empty = await req('/register', { method: 'POST', body: JSON.stringify({ tx: '' }) });
    expect(empty.status).toBe(400);
  });
});

describe('without a chain', () => {
  it('reports registration as unavailable rather than accepted', async () => {
    const keys = await createJwtKeys();
    const store = createContentStore();
    const offline = createHandler({
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
    const reg = await offline(new Request('http://svc/register', { method: 'POST', body: JSON.stringify({ tx: 'AQ==' }) }));
    expect(reg.status).toBe(503);
  });
});

describe('POST /auth/identity', () => {
  const sk = new Uint8Array(32).fill(0x2a)
  const pair = authKeyPair(sk)
  const id = encodePnyxId(bytes32(0x2a))

  const login = async (over: Partial<{ identity: string; nonce: string; signature: string }> = {}) => {
    const nonceRes = await req('/auth/nonce')
    const { nonce } = (await nonceRes.json()) as { nonce: string }
    const identity = over.identity ?? id
    const used = over.nonce ?? nonce
    const msg = authChallengeMessage('pnyx.test', 'undeployed', identity, used)
    const signature = over.signature ?? Buffer.from(ed25519.sign(msg, pair.secretKey)).toString('hex')
    return req('/auth/identity', { method: 'POST', body: JSON.stringify({ identity, nonce: used, signature }) })
  }

  it('issues a session whose subject is the identity', async () => {
    rows.set(hex(bytes32(0x2a)), { anchor: bytes32(1), authPub: pair.publicKey, name: new Uint8Array(32) })
    const res = await login()
    expect(res.status).toBe(200)
    const { token, identity } = (await res.json()) as { token: string; identity: string }
    expect(identity).toBe(id)
    // Verified against the JWKS this service publishes, not merely decoded: the subject only means
    // something if the token's signature holds under the advertised key, issuer and audience.
    const key = await importJWK(publicJwk as never, 'ES256')
    const { payload } = await jwtVerify(token, key, {
      issuer: 'https://pnyx-content-service',
      audience: 'pnyx',
    })
    expect(payload.sub).toBe(id)
    expect(payload.network).toBe('undeployed')
  })

  // The signature is only as good as where authPub lives — a row nobody published proves nothing,
  // and must not be treated as an outage either.
  it('refuses an identity with no published row', async () => {
    rows.delete(hex(bytes32(0x2a)))
    const res = await login()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/not been registered/)
  })

  it('refuses a signature made by the wrong key', async () => {
    rows.set(hex(bytes32(0x2a)), { anchor: bytes32(1), authPub: authKeyPair(bytes32(9)).publicKey, name: new Uint8Array(32) })
    expect((await login()).status).toBe(401)
  })

  it('refuses a reused nonce', async () => {
    rows.set(hex(bytes32(0x2a)), { anchor: bytes32(1), authPub: pair.publicKey, name: new Uint8Array(32) })
    const nonceRes = await req('/auth/nonce')
    const { nonce } = (await nonceRes.json()) as { nonce: string }
    const msg = authChallengeMessage('pnyx.test', 'undeployed', id, nonce)
    const signature = Buffer.from(ed25519.sign(msg, pair.secretKey)).toString('hex')
    const body = JSON.stringify({ identity: id, nonce, signature })
    expect((await req('/auth/identity', { method: 'POST', body })).status).toBe(200)
    expect((await req('/auth/identity', { method: 'POST', body })).status).toBe(401)
  })

  // An id names a person, not a chain, so one this deployment has never seen is not "from another
  // network" — it is simply unregistered here, and saying so is the truth rather than a guess made
  // from the spelling. Replay across deployments is stopped by the signed challenge, which commits
  // to the network.
  it('refuses an identity this deployment has no row for', async () => {
    const res = await login({ identity: encodePnyxId(bytes32(0x5c)) })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/not been registered/)
  })

  // bech32m is case-insensitive: the uppercase form decodes to the *same* `C` and verifies against
  // the same `authPub` (the challenge signs whatever spelling the client
  // chose). Accepted, it would mint a second subject for one keypair — and the subject is what
  // vote-once and one-membership-per-circle are keyed on, with BINARY collation. One spelling only.
  it('refuses a non-canonical spelling of a valid identity', async () => {
    rows.set(hex(bytes32(0x2a)), { anchor: bytes32(1), authPub: pair.publicKey, name: new Uint8Array(32) })
    // Guard the premise: this really is the same identity, signed correctly, and would otherwise
    // authenticate — so the rejection is about canonicality and nothing else.
    expect(pnyxIdEquals(id.toUpperCase(), id)).toBe(true)
    expect((await login()).status).toBe(200)

    const res = await login({ identity: id.toUpperCase() })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/canonical/)
  })

  it('never mints a subject that differs from the canonical id', async () => {
    rows.set(hex(bytes32(0x2a)), { anchor: bytes32(1), authPub: pair.publicKey, name: new Uint8Array(32) })
    const { token } = (await (await login()).json()) as { token: string }
    const key = await importJWK(publicJwk as never, 'ES256')
    const { payload } = await jwtVerify(token, key, {
      issuer: 'https://pnyx-content-service',
      audience: 'pnyx',
    })
    // The exact string every uniqueness rule downstream is keyed on.
    expect(payload.sub).toBe(encodePnyxId(bytes32(0x2a)))
  })
})
