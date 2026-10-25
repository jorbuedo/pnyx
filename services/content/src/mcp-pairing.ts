// Issuing, listing, revoking and verifying an agent's credential.
//
// **The token is a JWT, and the row is what makes it revocable.** A signed token carries its own
// authority, so there is nothing to take away — hence one row per pairing, and verification is
// signature + row present + not revoked. That is also why the token is never stored: storing it would
// add a secret at rest for no gain, since the signature already proves it.
//
// ⚠️ **The token authenticates an agent. It authorises nothing.** Every state-changing call still goes
// through the connector's approval path on the phone. This module deliberately has no notion of scope
// or permission — putting one here would create a second, weaker copy of a decision the wallet already
// makes.
import { SignJWT, importJWK, jwtVerify } from 'jose';

/** Audience for an agent credential. Distinct from the session and realtime audiences, so a session
 *  JWT cannot be replayed as an agent token or the other way round. */
export const MCP_AUDIENCE = 'pnyx-mcp-agent';

export type McpPairing = {
  readonly pairingId: string;
  readonly subject: string;
  readonly label: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
};

/** The minimum D1 surface this module needs, typed locally so callers need no Workers types. */
export type PairingDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
};

/** Matches `AuthConfig.jwt`: a `CryptoKey` to sign with, the public JWK to verify against. */
export type PairingJwt = {
  readonly privateKey: CryptoKey;
  readonly kid?: string;
  readonly publicJwk: unknown;
  readonly issuer: string;
};

/**
 * A pairing id, from the platform CSPRNG.
 *
 * ⚠️ 16 bytes of `crypto.getRandomValues`, never a counter or a timestamp: the id names a routing
 * target, and a guessable one would let an agent aim at another identity's relay object before the
 * signature check has a chance to refuse it. The failure mode is always the entropy source, never the
 * length.
 */
export const newPairingId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Issue a credential for one agent, and record it so it can be listed and revoked. */
export const createPairing = async (
  db: PairingDb,
  jwt: PairingJwt,
  input: { subject: string; label: string; now?: number },
): Promise<{ pairing: McpPairing; token: string }> => {
  const pairingId = newPairingId();
  const createdAt = input.now ?? Date.now();
  // No expiry claim: an agent credential is revoked by the user, not by the clock. A short-lived token
  // would mean re-pasting a config every hour, which is the kind of friction that gets worked around by
  // scripting the secret into a file.
  const token = await new SignJWT({ pid: pairingId, label: input.label })
    .setProtectedHeader({ alg: 'ES256', ...(jwt.kid ? { kid: jwt.kid } : {}) })
    .setIssuedAt(Math.floor(createdAt / 1000))
    .setIssuer(jwt.issuer)
    .setAudience(MCP_AUDIENCE)
    .setSubject(input.subject)
    .sign(jwt.privateKey);
  await db
    .prepare('INSERT INTO mcp_pairings (pairing_id, subject, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(pairingId, input.subject, input.label, createdAt)
    .run();
  return { pairing: { pairingId, subject: input.subject, label: input.label, createdAt, revokedAt: null }, token };
};

export const listPairings = async (db: PairingDb, subject: string): Promise<readonly McpPairing[]> => {
  const rows = await db
    .prepare(
      'SELECT pairing_id, subject, label, created_at, revoked_at FROM mcp_pairings WHERE subject = ? ORDER BY created_at DESC',
    )
    .bind(subject)
    .all<{ pairing_id: string; subject: string; label: string; created_at: number; revoked_at: number | null }>();
  return (rows.results ?? []).map((r) => ({
    pairingId: r.pairing_id,
    subject: r.subject,
    label: r.label,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }));
};

/**
 * Revoke one pairing.
 *
 * Scoped by subject in the WHERE clause rather than checked afterwards, so one identity can never
 * revoke another's pairing even if it learns the id. Returns whether a live row was actually changed —
 * a caller that reports success for a pairing it did not own would be lying.
 */
export const revokePairing = async (
  db: PairingDb,
  input: { subject: string; pairingId: string; now?: number },
): Promise<boolean> => {
  const row = await db
    .prepare('SELECT pairing_id FROM mcp_pairings WHERE pairing_id = ? AND subject = ? AND revoked_at IS NULL')
    .bind(input.pairingId, input.subject)
    .first<{ pairing_id: string }>();
  if (row === null) return false;
  await db
    .prepare('UPDATE mcp_pairings SET revoked_at = ? WHERE pairing_id = ? AND subject = ?')
    .bind(input.now ?? Date.now(), input.pairingId, input.subject)
    .run();
  return true;
};

/**
 * Forget a **revoked** pairing, so a list of dead rows can be cleared.
 *
 * ⚠️ **Revoked only, and the SQL says so rather than a check above it.** Deleting a *live* row would
 * stop that agent working — `verifyAgentToken` rejects a token with no row — which is a revoke wearing
 * a different word. Somebody clearing history must not silently cut off a working agent, so a live
 * pairing has to be revoked first, deliberately, and only then forgotten.
 *
 * Safe precisely because a missing row rejects: forgetting one cannot resurrect its token.
 *
 * Scoped by subject in the WHERE clause, like revoke, so one identity can never delete another's row
 * even knowing the id — and the same "nothing to delete" answers for a row that is live, another
 * subject's, or never existed.
 */
export const forgetPairing = async (
  db: PairingDb,
  input: { subject: string; pairingId: string },
): Promise<boolean> => {
  const row = await db
    .prepare('SELECT pairing_id FROM mcp_pairings WHERE pairing_id = ? AND subject = ? AND revoked_at IS NOT NULL')
    .bind(input.pairingId, input.subject)
    .first<{ pairing_id: string }>();
  if (row === null) return false;
  await db
    .prepare('DELETE FROM mcp_pairings WHERE pairing_id = ? AND subject = ? AND revoked_at IS NOT NULL')
    .bind(input.pairingId, input.subject)
    .run();
  return true;
};

export type VerifiedAgent = {
  readonly subject: string;
  readonly pairingId: string;
  readonly label: string;
};

/**
 * Verify an agent's bearer token: signature, audience, and a live row.
 *
 * ⚠️ **The row check is not optional.** Without it a revoked token keeps working for ever, because its
 * signature stays valid — which is the whole reason the table exists.
 */
export const verifyAgentToken = async (
  db: PairingDb,
  jwt: Pick<PairingJwt, 'publicJwk' | 'issuer'>,
  token: string,
): Promise<VerifiedAgent | undefined> => {
  let subject: string;
  let pairingId: string;
  let label: string;
  try {
    const key = await importJWK(jwt.publicJwk as never, 'ES256');
    const { payload } = await jwtVerify(token, key, {
      issuer: jwt.issuer,
      audience: MCP_AUDIENCE,
      // ⚠️ **Belt and braces, and measured as such.** `jose` already refuses a symmetric alg against an
      // asymmetric CryptoKey, so `alg: HS256` signed with the public JWK as a shared secret never
      // reaches here with or without this line — mutating it away fails no test. It stays because the
      // check that stands between a forged token and a wallet should say what it accepts rather than
      // inherit it from a library's key-type inference.
      algorithms: ['ES256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.pid !== 'string') return undefined;
    subject = payload.sub;
    pairingId = payload.pid;
    label = typeof payload.label === 'string' ? payload.label : '';
  } catch {
    return undefined;
  }
  // Both columns matter: the id must be live *and* still belong to the subject the token claims.
  const row = await db
    .prepare('SELECT label FROM mcp_pairings WHERE pairing_id = ? AND subject = ? AND revoked_at IS NULL')
    .bind(pairingId, subject)
    .first<{ label: string }>();
  if (row === null) return undefined;
  return { subject, pairingId, label: row.label === '' ? label : row.label };
};

/** What the route layer consumes, so `ServiceContext` carries a service rather than a database. */
export type McpPairingService = {
  readonly create: (input: { subject: string; label: string }) => Promise<{ pairing: McpPairing; token: string }>;
  readonly list: (subject: string) => Promise<readonly McpPairing[]>;
  readonly revoke: (input: { subject: string; pairingId: string }) => Promise<boolean>;
  /** Delete a revoked row. Refuses a live one — see {@link forgetPairing}. */
  readonly forget: (input: { subject: string; pairingId: string }) => Promise<boolean>;
  readonly verify: (token: string) => Promise<VerifiedAgent | undefined>;
};

export const createMcpPairingService = (db: PairingDb, jwt: PairingJwt): McpPairingService => ({
  create: (input) => createPairing(db, jwt, input),
  list: (subject) => listPairings(db, subject),
  revoke: (input) => revokePairing(db, input),
  forget: (input) => forgetPairing(db, input),
  verify: (token) => verifyAgentToken(db, jwt, token),
});
