// Auth rail: verify that a caller controls an identity row, and issue an ES256 session JWT whose
// subject is that identity (`docs/PNYX_IDENTITY_PLAN.md`). ES256 is inherited from a retired
// external verifier that required it; this service is now the sole issuer *and* verifier
// (routes.ts jwtVerify), so the algorithm is a free choice — kept because rotating keys
// buys nothing. It is not a requirement, and nothing downstream depends on it.
//
// SIWM (a connector-signed CAIP-122 message bound to an `mn_addr`) used to be the login rail. It is
// gone: `mn_addr` is an identity the contract cannot check, which is the whole reason the identity
// row exists. The `mn_addr` codec survives in `@pnyx/wallet`, for wallet surfaces.
import { authChallengeMessage, decodePnyxId, deviceBindingMessage, encodePnyxId } from '@pnyx/contract-client/identity';
import { ed25519 } from '@noble/curves/ed25519.js';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8 } from 'jose';
import type { NonceStore } from './nonce.js';

export type AuthConfig = {
  readonly domain: string;
  readonly network: string;
  readonly nonces: NonceStore;
  readonly jwt: {
    readonly privateKey: CryptoKey;
    /** JWKS key id, stamped into every token's header (see createJwtKeys). */
    readonly kid?: string;
    readonly issuer: string;
    readonly audience: string;
    readonly ttlSeconds: number;
  };
  readonly now?: () => number;
  /** Max clock skew allowed on the message's Issued At, in ms. */
  readonly issuedAtToleranceMs?: number;
};

const hexToBytes = (hex: string): Uint8Array | undefined => {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const createJwtKeys = async (): Promise<{
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
}> => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const publicJwk = { ...jwk, alg: 'ES256', use: 'sig', kid };
  return { privateKey: privateKey as CryptoKey, publicJwk, kid };
};

/**
 * Load a FIXED ES256 signing key from a PKCS#8 PEM (a Worker secret). Unlike
 * {@link createJwtKeys}, the key is stable across isolates/restarts — required
 * on a Worker, where an ephemeral per-isolate key would rotate the JWKS and
 * break token verification. The public JWK (for /.well-known/jwks.json) and the
 * `kid` are derived from the same key, so they always match issued tokens.
 */
export const loadJwtKeys = async (
  pkcs8Pem: string,
): Promise<{ privateKey: CryptoKey; publicJwk: Record<string, unknown>; kid: string }> => {
  const privateKey = (await importPKCS8(pkcs8Pem, 'ES256', { extractable: true })) as CryptoKey;
  const { d: _d, ...pub } = await exportJWK(privateKey); // strip the private scalar → public JWK
  const kid = await calculateJwkThumbprint(pub);
  const publicJwk = { ...pub, alg: 'ES256', use: 'sig', kid };
  return { privateKey, publicJwk, kid };
};

/**
 * Login by proving control of an identity row (docs/PNYX_IDENTITY_PLAN.md).
 *
 * The trust does not come from the signature scheme — Ed25519 here, verified only
 * by us — but from *where the public half lives*: `authPub` sits in a row only `identitySk`'s
 * holder can write, because writing it required a proof of knowledge in-circuit. So a signature
 * that checks out against the row establishes the same thing SIWM's BIP-340 did, without any of
 * the machinery.
 */
export type IdentityLoginRequest = {
  /** bech32m `pnyx_id`. */
  readonly identity: string;
  readonly nonce: string;
  /** Ed25519 over {@link authChallengeMessage}, hex. */
  readonly signature: string;
  /**
   * Where this identity's contract lives, hex — one contract per identity, so there is no single
   * address to configure.
   *
   * ⚠️ **Supplied, and therefore not trusted.** The reader checks two things about whatever is found
   * there: that it is built from our identity template (its code digest), and that it is sealed to this
   * `C` (the decoder refuses anything else). Those two together are sufficient, because `publishRow`
   * proves knowledge of `identitySk` — so a template-conforming contract sealed to somebody else's `C`
   * can only be empty, and an attacker's own template holds no row this login would accept.
   *
   * Optional so a deployment that still configures one address keeps working; the reader decides.
   */
  readonly contract?: string;
};

export type IdentityLoginResult = { ok: true; token: string; identity: string } | { ok: false; reason: string };

export const identityLogin = async (
  config: AuthConfig,
  request: IdentityLoginRequest,
  readRow: (identity: Uint8Array, contract?: string) => Promise<{ authPub: Uint8Array } | undefined>,
): Promise<IdentityLoginResult> => {
  const now = config.now ?? Date.now;

  let decoded: { identity: Uint8Array };
  try {
    decoded = decodePnyxId(request.identity);
  } catch {
    return { ok: false, reason: 'malformed identity' };
  }
  // No network gate: an id names a person, not a chain. Presenting one this deployment has never
  // seen is answered by the row lookup below — "has not been registered" — which is the truth,
  // where "wrong network" would have been a guess made from the spelling. Cross-deployment replay
  // is stopped in the signed challenge, which commits to `config.network`.

  // **One identity, one spelling.** bech32m is case-insensitive, so `decodePnyxId` accepts the
  // uppercase form of a valid id and yields the same `C` — and the subject minted below is the key
  // that `PRIMARY KEY (proposal_id, subject)` and `PRIMARY KEY (circle_id, subject)` enforce
  // vote-once and one-membership-per-circle on, under BINARY collation. Two accepted spellings
  // would therefore be two subjects for one keypair: two memberships in a circle, two votes on a
  // proposal. Rejected rather than silently normalised so the string that is stored is provably the
  // string that was signed. A client derives its own id and never parses one, so canonical is the
  // only form an honest caller can produce.
  if (request.identity !== encodePnyxId(decoded.identity)) {
    return { ok: false, reason: 'identity is not in canonical form' };
  }

  const signature = hexToBytes(request.signature);
  if (!signature || signature.length !== 64) {
    return { ok: false, reason: 'malformed signature' };
  }

  // Nonce consumed before the chain read, so a replayed challenge cannot be used to probe which
  // identities exist.
  if (!(await config.nonces.consume(request.nonce))) {
    return { ok: false, reason: 'unknown or reused nonce' };
  }

  let row: { authPub: Uint8Array } | undefined;
  try {
    row = await readRow(decoded.identity, request.contract);
  } catch (error) {
    console.warn(`[auth] identity row read failed: ${String(error)}`);
    return { ok: false, reason: 'identity registry unavailable' };
  }
  if (!row) {
    return { ok: false, reason: 'identity has not been registered' };
  }

  const message = authChallengeMessage(config.domain, config.network, request.identity, request.nonce);
  let valid = false;
  try {
    valid = ed25519.verify(signature, message, row.authPub);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'signature verification failed' };
  }

  const token = await new SignJWT({ network: config.network })
    .setProtectedHeader({ alg: 'ES256', ...(config.jwt.kid ? { kid: config.jwt.kid } : {}) })
    .setSubject(request.identity)
    .setIssuer(config.jwt.issuer)
    .setAudience(config.jwt.audience)
    .setIssuedAt(Math.floor(now() / 1000))
    .setExpirationTime(Math.floor(now() / 1000) + config.jwt.ttlSeconds)
    .sign(config.jwt.privateKey);

  return { ok: true, token, identity: request.identity };
};

export type DeviceBindingRequest = {
  /** bech32m `pnyx_id` — must equal the caller's authenticated JWT subject. */
  readonly identity: string;
  readonly nonce: string;
  readonly fcmToken: string;
  readonly platform: string;
  /** Ed25519 over {@link deviceBindingMessage}, hex. */
  readonly signature: string;
  /** Where the identity's contract lives — see {@link IdentityLoginRequest.contract}. */
  readonly contract?: string;
};

export type DeviceBindingResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify that the identity claiming an FCM token is the one that owns it.
 *
 * The session JWT already establishes that *someone* authenticated as this identity, but it is a
 * bearer credential: for its lifetime, whoever holds it could point the victim's notifications at
 * their own device and learn who messages them and which circles are busy. The identity key never
 * travels, so requiring a signature over the binding closes that gap.
 *
 * Deliberately the same shape as {@link identityLogin} — same key, same curve, same nonce store,
 * `authPub` read from the same on-chain row — differing only in the domain-separated message, so
 * neither signature is usable as the other.
 */
export const verifyDeviceBinding = async (
  config: AuthConfig,
  request: DeviceBindingRequest,
  readRow: (identity: Uint8Array, contract?: string) => Promise<{ authPub: Uint8Array } | undefined>,
): Promise<DeviceBindingResult> => {
  let decoded: { identity: Uint8Array };
  try {
    decoded = decodePnyxId(request.identity);
  } catch {
    return { ok: false, reason: 'malformed identity' };
  }
  // Same one-identity-one-spelling rule as login: the stored subject must provably be the string
  // that was signed.
  if (request.identity !== encodePnyxId(decoded.identity)) {
    return { ok: false, reason: 'identity is not in canonical form' };
  }

  const signature = hexToBytes(request.signature);
  if (!signature || signature.length !== 64) {
    return { ok: false, reason: 'malformed signature' };
  }

  if (!(await config.nonces.consume(request.nonce))) {
    return { ok: false, reason: 'unknown or reused nonce' };
  }

  let row: { authPub: Uint8Array } | undefined;
  try {
    row = await readRow(decoded.identity, request.contract);
  } catch (error) {
    console.warn(`[auth] identity row read failed: ${String(error)}`);
    return { ok: false, reason: 'identity registry unavailable' };
  }
  if (!row) {
    return { ok: false, reason: 'identity has not been registered' };
  }

  const message = deviceBindingMessage(
    config.domain,
    config.network,
    request.identity,
    request.nonce,
    request.fcmToken,
    request.platform,
  );
  let valid = false;
  try {
    valid = ed25519.verify(signature, message, row.authPub);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'signature verification failed' };
};
