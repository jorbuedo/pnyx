/**
 * A permit: the token that says one identity may reach another.
 *
 * **Server-issued and stateless.** Issuing writes nothing — the token *is* the record, signed with
 * the same ES256 key as a session and verified the same way. That is what keeps the consent layer
 * from becoming a table of who-may-talk-to-whom, which is the graph this service is not supposed to
 * accumulate (`docs/ABUSE_MITIGATION.md` §5).
 *
 * ⚠️ **Its own audience**, exactly as realtime tickets have theirs: the key is shared, so without an
 * audience split a permit could be presented as a session, or a session as a permit.
 *
 * Two shapes, and the difference is one claim:
 *
 * - **targeted** — `bearer` names the one identity that may use it, and delivery checks that name
 *   against the authenticated sender, so a leaked permit is worthless to whoever finds it.
 * - **an invite** — no `bearer` at all. Anyone holding it may **convert** it into a targeted permit
 *   for themselves, which is what makes a QR code or a link posted in a circle work: the issuer
 *   cannot know in advance who will take it up.
 *
 * ⚠️ **An invite is exactly as shareable as it looks.** Anyone who sees it can use it until it
 * expires or is revoked — that is what "share this link" means, and the revocation is one tap. What
 * revoking does *not* do is un-admit the people who already converted: their permits have their own
 * ids, so they are muted or blocked individually.
 *
 * ⚠️ **`jti` is random, and the recipient learns it from the sender.** The sender presents the
 * permit on every delivery, so the service can surface the id on the row the recipient reads, and
 * the recipient's device keeps it with the conversation. That is what lets mute name a permit
 * without this service storing any mapping from a pair to an id — the alternative, deriving the id
 * from the pair, would have needed a long-lived secret whose rotation silently un-mutes everyone.
 *
 * @module
 */

import { type JWTPayload, SignJWT, importJWK, jwtVerify } from 'jose';

/** Audience for permits, distinct from the session and realtime audiences. */
export const PERMIT_AUDIENCE = 'pnyx-dm-permit';

/** How long a permit lasts unless the issuer says otherwise. 180 days: a friendship is not a session. */
export const PERMIT_TTL_SECONDS = 180 * 24 * 60 * 60;

/** The longest a permit may be minted for, so a caller cannot ask for a century. */
export const PERMIT_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

export type Permit = {
  /** Opaque id. What a revocation names, and the only thing the revocation list stores. */
  readonly jti: string;
  /** The identity that granted it — the recipient of anything sent under it. */
  readonly issuer: string;
  /** The one identity that may use it, or `undefined` for an invite anyone may convert. */
  readonly bearer: string | undefined;
  /** Whether messages sent under it may raise a push. */
  readonly notify: boolean;
  /** Seconds since the epoch. */
  readonly issuedAt: number;
  readonly expiresAt: number;
};

export type PermitSigning = {
  readonly privateKey: CryptoKey;
  readonly issuer: string;
  readonly kid?: string;
};

const randomId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

/**
 * Mint a permit. `ttlSeconds` is clamped rather than refused: an issuer asking for too long gets the
 * longest we allow, which is a better answer than an error for a value they did not choose by hand.
 */
export const issuePermit = async (
  signing: PermitSigning,
  input: {
    readonly issuer: string;
    /** Omit for an **invite**: a permit naming nobody, which the first holder converts. */
    readonly bearer?: string;
    readonly notify?: boolean;
    readonly ttlSeconds?: number;
    readonly now?: () => number;
  },
): Promise<{ readonly token: string; readonly permit: Permit }> => {
  const nowMs = (input.now ?? Date.now)();
  const issuedAt = Math.floor(nowMs / 1000);
  const ttl = Math.min(Math.max(1, input.ttlSeconds ?? PERMIT_TTL_SECONDS), PERMIT_MAX_TTL_SECONDS);
  const permit: Permit = {
    jti: randomId(),
    issuer: input.issuer,
    bearer: input.bearer,
    notify: input.notify ?? true,
    issuedAt,
    expiresAt: issuedAt + ttl,
  };
  const token = await new SignJWT({
    ...(permit.bearer === undefined ? {} : { bearer: permit.bearer }),
    notify: permit.notify,
  })
    .setProtectedHeader({ alg: 'ES256', ...(signing.kid ? { kid: signing.kid } : {}) })
    .setSubject(permit.issuer)
    .setIssuer(signing.issuer)
    .setAudience(PERMIT_AUDIENCE)
    .setJti(permit.jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(permit.expiresAt)
    .sign(signing.privateKey);
  return { token, permit };
};

/**
 * Verify a presented permit, and check it is the *presenter's*.
 *
 * ⚠️ **`presentedBy` is not optional.** A targeted permit that verifies but names someone else is a
 * permit somebody found, and accepting it would turn a targeted grant into a bearer one. An
 * *invite* names nobody and so passes that check by construction — which is the whole point of it,
 * and why the caller must convert one rather than keep presenting it. Returns `undefined` for every
 * failure: a caller that cannot tell "expired" from "not yours" cannot leak the difference either.
 */
export const verifyPermit = async (
  publicJwk: unknown,
  token: string,
  expect: { readonly issuer: string; readonly presentedBy: string; readonly signedBy: string },
): Promise<Permit | undefined> => {
  let payload: JWTPayload;
  try {
    const key = await importJWK(publicJwk as never, 'ES256');
    ({ payload } = await jwtVerify(token, key, {
      issuer: expect.signedBy,
      audience: PERMIT_AUDIENCE,
      algorithms: ['ES256'],
    }));
  } catch {
    return undefined;
  }
  const { sub, jti, iat, exp, bearer, notify } = payload;
  if (typeof sub !== 'string' || typeof jti !== 'string') return undefined;
  if (typeof iat !== 'number' || typeof exp !== 'number') return undefined;
  // Granted by the recipient being addressed — true of both shapes.
  if (sub !== expect.issuer) return undefined;
  // ⚠️ An absent `bearer` is an invite, not a permit that forgot to name one: a token carrying a
  // `bearer` of the wrong *type* is malformed and refused rather than read as open to everyone.
  if (bearer !== undefined && typeof bearer !== 'string') return undefined;
  if (bearer !== undefined && bearer !== expect.presentedBy) return undefined;
  return { jti, issuer: sub, bearer, notify: notify !== false, issuedAt: iat, expiresAt: exp };
};
