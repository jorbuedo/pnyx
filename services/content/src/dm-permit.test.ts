import { describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { issuePermit, PERMIT_MAX_TTL_SECONDS, PERMIT_TTL_SECONDS, verifyPermit } from './dm-permit.js';

const ISSUER = 'https://pnyx-content-service';
const ALICE = 'mn_addr1alice';
const BOB = 'mn_addr1bob';
const MALLORY = 'mn_addr1mallory';

const keys = await createJwtKeys();
const signing = { privateKey: keys.privateKey, issuer: ISSUER };
const mint = (over: Partial<Parameters<typeof issuePermit>[1]> = {}) =>
  issuePermit(signing, { issuer: ALICE, bearer: BOB, ...over });
const check = (token: string, over: { issuer?: string; presentedBy?: string } = {}) =>
  verifyPermit(keys.publicJwk, token, {
    issuer: over.issuer ?? ALICE,
    presentedBy: over.presentedBy ?? BOB,
    signedBy: ISSUER,
  });

describe('issuePermit', () => {
  it('mints a permit the bearer can present to its issuer', async () => {
    const { token, permit } = await mint();
    expect(permit.issuer).toBe(ALICE);
    expect(permit.bearer).toBe(BOB);
    expect(await check(token)).toMatchObject({ issuer: ALICE, bearer: BOB, notify: true });
  });

  it('gives every permit a distinct id, since the id is what a revocation names', async () => {
    const [a, b] = [await mint(), await mint()];
    expect(a.permit.jti).not.toBe(b.permit.jti);
  });

  it('defaults to notifying, and carries an explicit refusal to notify', async () => {
    expect((await mint()).permit.notify).toBe(true);
    const quiet = await mint({ notify: false });
    expect(quiet.permit.notify).toBe(false);
    expect(await check(quiet.token)).toMatchObject({ notify: false });
  });

  // Clamped rather than refused: the caller did not type this by hand.
  it('clamps a ttl that is too long, and one that is nonsense', async () => {
    const long = await mint({ ttlSeconds: PERMIT_MAX_TTL_SECONDS * 10 });
    expect(long.permit.expiresAt - long.permit.issuedAt).toBe(PERMIT_MAX_TTL_SECONDS);
    const zero = await mint({ ttlSeconds: 0 });
    expect(zero.permit.expiresAt - zero.permit.issuedAt).toBe(1);
  });

  it('defaults to a lifetime measured in months, because a friendship is not a session', async () => {
    const { permit } = await mint();
    expect(permit.expiresAt - permit.issuedAt).toBe(PERMIT_TTL_SECONDS);
  });
});

describe('verifyPermit', () => {
  // ⚠️ The binding that makes a permit targeted rather than bearer.
  it('refuses a permit presented by somebody it does not name', async () => {
    const { token } = await mint();
    expect(await check(token, { presentedBy: MALLORY })).toBeUndefined();
  });

  it('refuses a permit granted by a different identity than the one being addressed', async () => {
    const { token } = await mint();
    expect(await check(token, { issuer: MALLORY })).toBeUndefined();
  });

  it('refuses an expired permit', async () => {
    const { token } = await issuePermit(signing, {
      issuer: ALICE,
      bearer: BOB,
      ttlSeconds: 1,
      now: () => Date.now() - 10_000,
    });
    expect(await check(token)).toBeUndefined();
  });

  it('refuses a token that is not a permit at all', async () => {
    for (const junk of ['', 'not.a.jwt', 'a.b.c']) expect(await check(junk)).toBeUndefined();
  });

  // A session token and a permit are signed by the same key; only the audience separates them.
  it('refuses a session token presented as a permit', async () => {
    const session = await issuePermit({ ...signing }, { issuer: ALICE, bearer: BOB });
    const swapped = await verifyPermit(keys.publicJwk, session.token, {
      issuer: ALICE,
      presentedBy: BOB,
      signedBy: 'https://somewhere-else',
    });
    expect(swapped).toBeUndefined();
  });

  it('refuses a permit signed by a different key', async () => {
    const other = await createJwtKeys();
    const { token } = await issuePermit({ privateKey: other.privateKey, issuer: ISSUER }, { issuer: ALICE, bearer: BOB });
    expect(await check(token)).toBeUndefined();
  });
});
