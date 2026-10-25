// The pairing routes end to end through `createHandler` — the wiring the unit tests cannot reach.
//
// `mcp-pairing.test.ts` covers the credential lifecycle against the module directly; this covers what a
// caller actually hits: paths, methods, status codes, who is refused, and the two shapes that must not
// drift — a deployment with no pairing service must 404 rather than issue a credential, and a token must
// come back exactly once with no route that reads it again.
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createMcpPairingService, type PairingDb } from './mcp-pairing.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

/** A D1 stand-in over an array, matching only the queries `mcp-pairing.ts` issues. */
const fakeDb = (): PairingDb => {
  const rows: Record<string, unknown>[] = [];
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (sql.startsWith('INSERT')) {
            rows.push({
              pairing_id: values[0],
              subject: values[1],
              label: values[2],
              created_at: values[3],
              revoked_at: null,
            });
          } else if (sql.startsWith('UPDATE')) {
            const row = rows.find((r) => r.pairing_id === values[1] && r.subject === values[2]);
            if (row !== undefined) row.revoked_at = values[0];
          }
          return undefined;
        },
        first: async () =>
          rows.find((r) => r.pairing_id === values[0] && r.subject === values[1] && r.revoked_at === null) ?? null,
        all: async () => ({ results: rows.filter((r) => r.subject === values[0]) }),
      }),
    }),
  } as PairingDb;
};

type Handler = (request: Request) => Promise<Response>;

let withPairing: Handler;
let withoutPairing: Handler;

const base = async (mcp: boolean): Promise<Handler> => {
  const keys = await createJwtKeys();
  const store = createContentStore();
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
    chain: disabledChainMirror,
    notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
    ...(mcp
      ? {
          mcpPairings: createMcpPairingService(fakeDb(), {
            privateKey: keys.privateKey,
            publicJwk: keys.publicJwk,
            issuer: 'https://pnyx-content-service',
          }),
        }
      : {}),
  });
};

beforeAll(async () => {
  withPairing = await base(true);
  withoutPairing = await base(false);
});

const call = (handler: Handler, path: string, init?: RequestInit & { token?: string }) =>
  handler(
    new Request(`http://svc${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    }),
  );

const login = async (handler: Handler, name: string): Promise<string> => {
  const res = await call(handler, '/auth/dev', { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
};

describe('a deployment without pairing configured', () => {
  // Absent means absent: issuing a credential nothing can use would be worse than refusing.
  it('404s the list and the create rather than issuing anything', async () => {
    const token = await login(withoutPairing, 'alice');
    expect((await call(withoutPairing, '/mcp/pairings', { token })).status).toBe(404);
    expect(
      (await call(withoutPairing, '/mcp/pairings', { method: 'POST', token, body: JSON.stringify({ label: 'x' }) }))
        .status,
    ).toBe(404);
  });
});

describe('authentication', () => {
  it('refuses an unauthenticated caller on every pairing route', async () => {
    expect((await call(withPairing, '/mcp/pairings')).status).toBe(401);
    expect((await call(withPairing, '/mcp/pairings', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await call(withPairing, '/mcp/pairings/abc/revoke', { method: 'POST' })).status).toBe(401);
  });
});

describe('issuing a credential', () => {
  it('returns the token once, with the pairing', async () => {
    const token = await login(withPairing, 'alice');
    const res = await call(withPairing, '/mcp/pairings', {
      method: 'POST',
      token,
      body: JSON.stringify({ label: 'Claude Code' }),
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { token: string; pairing: { label: string; revokedAt: number | null } };
    expect(payload.token.split('.')).toHaveLength(3);
    expect(payload.pairing.label).toBe('Claude Code');
    expect(payload.pairing.revokedAt).toBeNull();

    // ⚠️ And there is no route that gives it back. A read-back would put a live credential behind a
    // session that may be months old, so losing it means revoking and issuing another.
    const listed = await call(withPairing, '/mcp/pairings', { token });
    const {
      pairings: [first],
    } = (await listed.json()) as { pairings: Record<string, unknown>[] };
    expect(first).not.toHaveProperty('token');
  });

  it('requires a label, because it is how a user tells two agents apart', async () => {
    const token = await login(withPairing, 'alice');
    for (const bad of [{}, { label: '' }, { label: '   ' }]) {
      const res = await call(withPairing, '/mcp/pairings', { method: 'POST', token, body: JSON.stringify(bad) });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses a method it does not implement', async () => {
    const token = await login(withPairing, 'alice');
    expect((await call(withPairing, '/mcp/pairings', { method: 'DELETE', token })).status).toBe(405);
  });
});

describe('revoking', () => {
  it('revokes once and then reports there is nothing live', async () => {
    const token = await login(withPairing, 'alice');
    const created = await call(withPairing, '/mcp/pairings', {
      method: 'POST',
      token,
      body: JSON.stringify({ label: 'laptop' }),
    });
    const { pairing } = (await created.json()) as { pairing: { pairingId: string } };

    const first = await call(withPairing, `/mcp/pairings/${pairing.pairingId}/revoke`, { method: 'POST', token });
    expect(first.status).toBe(200);
    // Revoking twice is not a second success — reporting one would be lying to the user.
    const second = await call(withPairing, `/mcp/pairings/${pairing.pairingId}/revoke`, { method: 'POST', token });
    expect(second.status).toBe(404);
  });

  it('reports the same nothing-to-revoke for another identity’s pairing as for one that never existed', async () => {
    const alice = await login(withPairing, 'alice');
    const mallory = await login(withPairing, 'mallory');
    const created = await call(withPairing, '/mcp/pairings', {
      method: 'POST',
      token: alice,
      body: JSON.stringify({ label: 'alice laptop' }),
    });
    const { pairing } = (await created.json()) as { pairing: { pairingId: string } };

    // Same status as a made-up id: the route must not confirm that someone else's id is real.
    const stolen = await call(withPairing, `/mcp/pairings/${pairing.pairingId}/revoke`, {
      method: 'POST',
      token: mallory,
    });
    const invented = await call(withPairing, '/mcp/pairings/deadbeef/revoke', { method: 'POST', token: mallory });
    expect(stolen.status).toBe(invented.status);
    expect(stolen.status).toBe(404);
  });
});
