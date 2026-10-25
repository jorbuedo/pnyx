// Pairing credentials: issue, list, revoke, verify.
//
// The load-bearing case is `a revoked token stops working` — a JWT signature stays valid for ever, so
// the row check is the only thing that makes revocation real. Everything else here guards the scoping:
// one identity must never be able to reach or revoke another's pairing.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPairing,
  listPairings,
  MCP_AUDIENCE,
  newPairingId,
  type PairingDb,
  createMcpPairingService,
  revokePairing,
  verifyAgentToken,
} from './mcp-pairing.js';

/** A D1 stand-in over an array, matching only the queries this module issues. */
const fakeDb = (): PairingDb & { rows: Record<string, unknown>[] } => {
  const rows: Record<string, unknown>[] = [];
  const db = {
    rows,
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (sql.startsWith('INSERT')) {
            rows.push({ pairing_id: values[0], subject: values[1], label: values[2], created_at: values[3], revoked_at: null });
          } else if (sql.startsWith('UPDATE')) {
            const row = rows.find((r) => r.pairing_id === values[1] && r.subject === values[2]);
            if (row !== undefined) row.revoked_at = values[0];
          } else if (sql.startsWith('DELETE')) {
            // Honours the WHERE the same way `first` does, including the revoked-only clause — a fake
            // that deleted on id alone would pass while the real statement could take a live row.
            const deadOnly = /revoked_at IS NOT NULL/.test(sql);
            const at = rows.findIndex(
              (r) => r.pairing_id === values[0] && r.subject === values[1] && (!deadOnly || r.revoked_at !== null),
            );
            if (at >= 0) rows.splice(at, 1);
          }
          return undefined;
        },
        first: async () => {
          // ⚠️ **Honours the SQL rather than assuming it.** This used to filter on
          // `(pairing_id, subject, revoked_at)` whatever the query said — so the *fake* enforced the
          // scoping the production query is supposed to, and dropping `subject = ?` from the real
          // statement still passed every scoping test here. Found by mutating it.
          const wanted = [...sql.matchAll(/(\w+) = \?/g)].map((m, i) => [m[1] ?? '', values[i]] as const);
          const liveOnly = /revoked_at IS NULL/.test(sql);
          const deadOnly = /revoked_at IS NOT NULL/.test(sql);
          return (
            rows.find(
              (r) =>
                wanted.every(([column, value]) => r[column] === value) &&
                (!liveOnly || r.revoked_at === null) &&
                (!deadOnly || r.revoked_at !== null),
            ) ?? null
          );
        },
        all: async () => ({
          results: rows.filter((r) => r.subject === values[0]).sort((a, b) => Number(b.created_at) - Number(a.created_at)),
        }),
      }),
    }),
  };
  return db as PairingDb & { rows: Record<string, unknown>[] };
};

let jwt: { privateKey: CryptoKey; publicJwk: unknown; issuer: string };

beforeAll(async () => {
  // `extractable` only for the *public* export; the private key stays a `CryptoKey`, matching
  // `AuthConfig.jwt.privateKey`. jose generates non-extractable keys by default, and `exportJWK` on one
  // throws inside `beforeAll` — which silently skips every test in the file rather than failing loudly.
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  jwt = { privateKey, publicJwk: await exportJWK(publicKey), issuer: 'https://pnyx-test' };
});

describe('pairing ids', () => {
  it('are 16 random bytes, not a counter — a guessable id names another identity’s relay object', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPairingId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('issuing and verifying', () => {
  it('issues a token that verifies back to its subject and pairing', async () => {
    const db = fakeDb();
    const { pairing, token } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'Claude Code' });
    await expect(verifyAgentToken(db, jwt, token)).resolves.toEqual({
      subject: 'pnyx_id_alice',
      pairingId: pairing.pairingId,
      label: 'Claude Code',
    });
  });

  it('refuses a token signed by another key', async () => {
    const db = fakeDb();
    const { token } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'a' });
    const { publicKey } = await generateKeyPair('ES256', { extractable: true });
    const other = { publicJwk: await exportJWK(publicKey), issuer: jwt.issuer };
    await expect(verifyAgentToken(db, other, token)).resolves.toBeUndefined();
  });

  it('refuses garbage and an empty token without throwing', async () => {
    const db = fakeDb();
    await expect(verifyAgentToken(db, jwt, 'not.a.jwt')).resolves.toBeUndefined();
    await expect(verifyAgentToken(db, jwt, '')).resolves.toBeUndefined();
  });

  it('uses its own audience, so a session JWT cannot be replayed as an agent token', () => {
    expect(MCP_AUDIENCE).toBe('pnyx-mcp-agent');
  });

  // The constant above says what the audience *is*; this says what happens to a token carrying another
  // one. A session JWT is signed by the same key, so the signature check cannot be what stops it.
  it('refuses a token signed by the right key for the wrong audience', async () => {
    const db = fakeDb();
    const { pairing } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'a' });
    const sessionShaped = await new SignJWT({ pid: pairing.pairingId })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('pnyx_id_alice')
      .setIssuer(jwt.issuer)
      .setAudience('pnyx')
      .setIssuedAt()
      .sign(jwt.privateKey);
    await expect(verifyAgentToken(db, jwt, sessionShaped)).resolves.toBeUndefined();
  });

  // The alg-confusion attack: present the *public* key's own material as an HMAC secret and claim
  // `alg: HS256`.
  //
  // ⚠️ This asserts a **library** guarantee, not ours: `jose` refuses a symmetric alg against an
  // asymmetric CryptoKey, and removing our own `algorithms: ['ES256']` does not fail this test
  // (verified by mutation). Kept because the behaviour is worth pinning against a `jose` upgrade —
  // but it is not evidence that our pin does anything.
  it('refuses an HS256 token, however it was signed', async () => {
    const db = fakeDb();
    await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'a' });
    const secret = new TextEncoder().encode(JSON.stringify(jwt.publicJwk));
    const forged = await new SignJWT({ pid: 'ab'.repeat(16) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('pnyx_id_alice')
      .setIssuer(jwt.issuer)
      .setAudience(MCP_AUDIENCE)
      .setIssuedAt()
      .sign(secret);
    await expect(verifyAgentToken(db, jwt, forged)).resolves.toBeUndefined();
  });

  // Both columns of the row check matter: a live pairing id from *another* identity must not verify
  // under a subject that does not own it. Otherwise anyone who learned an id could name it in a token
  // of their own — and the id is what the relay object is addressed by.
  it('refuses a live pairing id claimed under a different subject', async () => {
    const db = fakeDb();
    const { pairing } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'alice' });
    const stolen = await new SignJWT({ pid: pairing.pairingId })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('pnyx_id_mallory')
      .setIssuer(jwt.issuer)
      .setAudience(MCP_AUDIENCE)
      .setIssuedAt()
      .sign(jwt.privateKey);
    await expect(verifyAgentToken(db, jwt, stolen)).resolves.toBeUndefined();
  });

  // And the converse, which is the routing property the relay depends on: a *valid* token names its own
  // subject, so it can only ever address that identity's object. Nothing else needs to check it.
  it('verifies back to the subject in the token, never to the caller’s claim', async () => {
    const db = fakeDb();
    const { token } = await createPairing(db, jwt, { subject: 'pnyx_id_bob', label: 'b' });
    await expect(verifyAgentToken(db, jwt, token)).resolves.toMatchObject({ subject: 'pnyx_id_bob' });
  });
});

describe('revocation is what the row is for', () => {
  it('stops a revoked token working, even though its signature is still valid', async () => {
    const db = fakeDb();
    const { pairing, token } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'laptop' });
    await expect(verifyAgentToken(db, jwt, token)).resolves.toBeTruthy();

    expect(await revokePairing(db, { subject: 'pnyx_id_alice', pairingId: pairing.pairingId })).toBe(true);
    // The signature has not changed — only the row has.
    await expect(verifyAgentToken(db, jwt, token)).resolves.toBeUndefined();
  });

  it('reports false rather than success when there is nothing live to revoke', async () => {
    const db = fakeDb();
    const { pairing } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'laptop' });
    expect(await revokePairing(db, { subject: 'pnyx_id_alice', pairingId: 'nope' })).toBe(false);
    expect(await revokePairing(db, { subject: 'pnyx_id_alice', pairingId: pairing.pairingId })).toBe(true);
    // Revoking twice is not a second success — a caller reporting one would be lying to the user.
    expect(await revokePairing(db, { subject: 'pnyx_id_alice', pairingId: pairing.pairingId })).toBe(false);
  });

  it('keeps a revoked pairing visible, so a user can see it was revoked', async () => {
    const db = fakeDb();
    const { pairing } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'laptop' });
    await revokePairing(db, { subject: 'pnyx_id_alice', pairingId: pairing.pairingId, now: 1234 });
    const listed = await listPairings(db, 'pnyx_id_alice');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokedAt).toBe(1234);
  });
});

describe('one identity cannot reach another’s pairing', () => {
  it('refuses to revoke a pairing it does not own', async () => {
    const db = fakeDb();
    const { pairing } = await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'laptop' });
    expect(await revokePairing(db, { subject: 'pnyx_id_mallory', pairingId: pairing.pairingId })).toBe(false);
    // Alice's pairing is untouched.
    await expect(listPairings(db, 'pnyx_id_alice')).resolves.toMatchObject([{ revokedAt: null }]);
  });

  it('lists only its own pairings', async () => {
    const db = fakeDb();
    await createPairing(db, jwt, { subject: 'pnyx_id_alice', label: 'a', now: 1 });
    await createPairing(db, jwt, { subject: 'pnyx_id_bob', label: 'b', now: 2 });
    await expect(listPairings(db, 'pnyx_id_alice')).resolves.toHaveLength(1);
    await expect(listPairings(db, 'pnyx_id_bob')).resolves.toHaveLength(1);
  });
});

// Clearing dead rows. The load-bearing case is the one that must NOT work: forgetting a live pairing
// would cut off a working agent under the word "clear".
describe('forgetting a revoked pairing', () => {
  const service = async () => {
    const db = fakeDb();
    const svc = createMcpPairingService(db, jwt);
    return { db, svc };
  };

  it('removes a revoked row so the list can be cleared', async () => {
    const { db, svc } = await service();
    const { pairing } = await svc.create({ subject: 'alice', label: 'old agent' });
    await svc.revoke({ subject: 'alice', pairingId: pairing.pairingId });
    expect(await svc.forget({ subject: 'alice', pairingId: pairing.pairingId })).toBe(true);
    expect(db.rows).toHaveLength(0);
    expect(await svc.list('alice')).toEqual([]);
  });

  // ⚠️ A live pairing is a working agent. `verifyAgentToken` rejects a token with no row, so deleting
  // one would be a revoke wearing a different word — and nobody clearing history is asking for that.
  it('refuses a live pairing, leaving the agent working', async () => {
    const { db, svc } = await service();
    const { pairing, token } = await svc.create({ subject: 'alice', label: 'live agent' });
    expect(await svc.forget({ subject: 'alice', pairingId: pairing.pairingId })).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(await svc.verify(token)).toMatchObject({ subject: 'alice' });
  });

  // The safety property that makes deletion sound at all: no row means rejected, so forgetting a
  // pairing can never resurrect its token.
  it('leaves a forgotten pairing’s token as dead as a revoked one', async () => {
    const { svc } = await service();
    const { pairing, token } = await svc.create({ subject: 'alice', label: 'old agent' });
    await svc.revoke({ subject: 'alice', pairingId: pairing.pairingId });
    await svc.forget({ subject: 'alice', pairingId: pairing.pairingId });
    expect(await svc.verify(token)).toBeUndefined();
  });

  it('cannot forget another identity’s row, even knowing the id', async () => {
    const { db, svc } = await service();
    const { pairing } = await svc.create({ subject: 'alice', label: 'alice’s agent' });
    await svc.revoke({ subject: 'alice', pairingId: pairing.pairingId });
    expect(await svc.forget({ subject: 'mallory', pairingId: pairing.pairingId })).toBe(false);
    expect(db.rows).toHaveLength(1);
  });

  it('answers the same for an id that never existed', async () => {
    const { svc } = await service();
    expect(await svc.forget({ subject: 'alice', pairingId: 'ff'.repeat(16) })).toBe(false);
  });
});
