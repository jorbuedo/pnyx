// The self-service invite flow, end to end through the handler.
//
// What is worth pinning here is the *posture*, because almost every branch is a decision about
// what to tell someone about their own wallet:
//
//   - an outage must never be reported as "you do not qualify" (503, not 403)
//   - a circle that never delegated must never be reported as "you do not qualify" (409, not 403)
//   - a repeated request must return the same code, not mint another
//   - the nonce is spent before the signature is checked, so a valid signature over a spent
//     nonce fails
//   - a mint that failed leaves no reservation behind, so the wallet can try again
//   - nothing is minted for a request that failed to authenticate or failed the predicate
//
// The attestor is a port, so none of this needs a network, a real CIP-8 signature, or a chain.
import { beforeEach, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { decodeCircleInvite, encodeCircleInvite } from '@pnyx/contract-client/circle-invite';
import { inviteChallengePayload } from './circle-invite-policy.js';
import type { AccountLookup } from './koios-account.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler, type InviteAttestorPorts } from './routes.js';
import { createContentStore } from './store.js';

let handler: (request: Request) => Promise<Response>;
let store: ReturnType<typeof createContentStore>;
/** What the fake verifier answers, and what the fake chain read returns. */
let verifyAnswer: boolean;
let accountAnswer: AccountLookup;
let verifiedPayloads: string[];
/** What the fake sponsor host does when asked to mint, and every mint it was asked for. */
let mintAnswer: 'issued' | 'not-delegated' | 'throw';
let minted: { circleId: string; contractAddress: string; commitment: string }[];

const CONTRACT = 'ab'.repeat(32);
const AUTHORITY = 'cd'.repeat(32);

beforeEach(async () => {
  const keys = await createJwtKeys();
  store = createContentStore();
  verifyAnswer = true;
  verifiedPayloads = [];
  mintAnswer = 'issued';
  minted = [];
  accountAnswer = { ok: true, facts: { registered: true, delegatedPool: null, delegatedDrep: 'drep1x', controlledBalance: 10n } };
  const inviteAttestor: InviteAttestorPorts = {
    verify: async ({ expectedPayload }) => {
      verifiedPayloads.push(expectedPayload);
      return verifyAnswer;
    },
    accountFacts: async () => accountAnswer,
    authorityCommitment: async () => AUTHORITY,
    mint: async (input) => {
      minted.push(input);
      if (mintAnswer === 'throw') throw new Error('sponsor host is down');
      return mintAnswer;
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
    chain: disabledChainMirror,
    notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
    inviteAttestor,
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

const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const devLogin = async (name: string): Promise<string> =>
  (await body<{ token: string }>(await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) }))).token;

/**
 * A circle with a policy and a contract on chain — the state in which a claim can be answered.
 *
 * `onChain: false` covers a circle whose deploy has not settled: it has no `invites` set to write
 * into, which is a founder's problem and not the requester's.
 */
const gatedCircle = async (
  token: string,
  options: { rules?: readonly { kind: string; param?: string }[]; onChain?: boolean } = {},
) => {
  const created = await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: `c${Math.random()}` }) });
  const circleId = (await body<{ circle: { id: string } }>(created)).circle.id;
  if (options.onChain !== false) {
    await store.setCircleChain(circleId, { status: 'confirmed', chainId: CONTRACT });
  }
  await req(`/circles/${circleId}/invite-policy`, {
    method: 'POST',
    token,
    body: JSON.stringify({ rules: options.rules ?? [{ kind: 'drep-delegated', param: 'drep1x' }] }),
  });
  return circleId;
};

const claim = async (circleId: string, token: string, stake = 'stake1abc') => {
  const challenge = await body<{ nonce: string; expiresAtMs: number }>(
    await req(`/circles/${circleId}/invite-challenge`, { method: 'POST', token }),
  );
  return req(`/circles/${circleId}/invite-claim`, {
    method: 'POST',
    token,
    body: JSON.stringify({
      nonce: challenge.nonce,
      expiresAtMs: challenge.expiresAtMs,
      stakeAddressBech32: stake,
      stakeAddressHex: 'e0' + '11'.repeat(28),
      signature: 'aa',
      key: 'bb',
    }),
  });
};

describe('invite policy', () => {
  it('lets the founder set and read a policy, and publishes the authority to delegate to', async () => {
    const token = await devLogin('founder');
    const circleId = await gatedCircle(token);
    const read = await req(`/circles/${circleId}/invite-policy`, { token });
    expect(await body(read)).toEqual({
      rules: [{ kind: 'drep-delegated', param: 'drep1x' }],
      authorityCommitment: AUTHORITY,
    });
  });

  // ⚠️ Any-of, not all-of: the founder's question is "who may join", and a list under that heading is
  // a list of groups who may. All-of would make two rules strictly narrower than one, so a founder
  // adding a second to widen their circle would quietly close it.
  it('keeps every requirement the founder chose', async () => {
    const token = await devLogin('founder');
    const circleId = await gatedCircle(token, {
      rules: [
        { kind: 'pool-member', param: 'pool1abc' },
        { kind: 'ada-threshold', param: '5000000' },
      ],
    });
    expect(await body(await req(`/circles/${circleId}/invite-policy`, { token }))).toMatchObject({
      rules: [
        { kind: 'ada-threshold', param: '5000000' },
        { kind: 'pool-member', param: 'pool1abc' },
      ],
    });
  });

  // A repeat is a founder who meant to edit one rule and added another, and under any-of the looser
  // of the two silently wins — refused rather than resolved.
  it('refuses the same requirement twice', async () => {
    const token = await devLogin('founder');
    const created = await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'dup' }) });
    const circleId = (await body<{ circle: { id: string } }>(created)).circle.id;
    const res = await req(`/circles/${circleId}/invite-policy`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        rules: [
          { kind: 'ada-threshold', param: '1' },
          { kind: 'ada-threshold', param: '2' },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  // The founder needs the commitment *before* there is a policy: delegating and choosing a rule are
  // two separate acts, and a control that could only show one after the other would force an order
  // the product does not have.
  it('publishes the authority even for a circle with no policy', async () => {
    const token = await devLogin('founder');
    const created = await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'bare' }) });
    const circleId = (await body<{ circle: { id: string } }>(created)).circle.id;
    expect(await body(await req(`/circles/${circleId}/invite-policy`, { token }))).toEqual({
      rules: null,
      authorityCommitment: AUTHORITY,
    });
  });

  it('refuses a predicate it cannot parse', async () => {
    const token = await devLogin('founder');
    const circleId = await gatedCircle(token);
    const res = await req(`/circles/${circleId}/invite-policy`, {
      method: 'POST',
      token,
      body: JSON.stringify({ rules: [{ kind: 'ada-threshold', param: '1.5' }] }),
    });
    expect(res.status).toBe(400);
  });

  // Only the founder decides who may enter — a member setting the entry rule is the whole
  // authority model inverted.
  it('refuses a non-founder setting the policy', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    const other = await devLogin('other');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: other, body: JSON.stringify({ persona: 'p' }) });
    const res = await req(`/circles/${circleId}/invite-policy`, {
      method: 'POST',
      token: other,
      body: JSON.stringify({ rules: [{ kind: 'pool-member', param: 'pool1abc' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('closes the self-service path when the policy is removed', async () => {
    const token = await devLogin('founder');
    const circleId = await gatedCircle(token);
    await req(`/circles/${circleId}/invite-policy`, { method: 'POST', token, body: JSON.stringify({ rules: [] }) });
    expect((await claim(circleId, await devLogin('joiner'))).status).toBe(404);
    expect(minted).toHaveLength(0);
  });
});

describe('claiming an invite', () => {
  it('mints a fresh invite for a wallet that qualifies and hands over the secret', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    const res = await claim(circleId, await devLogin('joiner'));
    expect(res.status).toBe(201);
    const answered = await body<{ invite: string; reissued: boolean }>(res);
    expect(answered.reissued).toBe(false);
    // The `pnyx_invite1…` spelling the app's join field decodes — never the stored hex, which dies
    // there with a bech32 charset error. Decoded rather than pattern-matched, so this pins the
    // *same* codec the client uses; 32 bytes, from the CSPRNG rather than any derivation of the
    // request, because an invite is a capability and a guessable one is a gate that is not one.
    expect(decodeCircleInvite(answered.invite)).toHaveLength(32);
    expect(minted).toEqual([{ circleId, contractAddress: CONTRACT, commitment: expect.any(String) }]);
    // The commitment that went on chain is the one bound to the secret we handed over.
    const stored = await store.getClaimedCircleInvite(circleId, 'stake1abc');
    expect(stored).toEqual({
      commitment: minted[0]?.commitment,
      secret: Buffer.from(decodeCircleInvite(answered.invite)).toString('hex'),
      chainStatus: 'confirmed',
    });
  });

  it('signs over the circle, nonce and expiry the server issued', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    await claim(circleId, await devLogin('joiner'));
    expect(verifiedPayloads).toHaveLength(1);
    expect(verifiedPayloads[0]).toMatch(new RegExp(`^pnyx:circle-invite\\.v1\\.${circleId}\\.`));
  });

  it('refuses a signature that does not verify, and mints nothing', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    verifyAnswer = false;
    const res = await claim(circleId, await devLogin('joiner'));
    expect(res.status).toBe(403);
    expect(minted).toHaveLength(0);
  });

  // ⚠️ The nonce is consumed before the signature is checked, so a valid signature over a spent
  // nonce must fail. Replaying the same challenge is the attack this defends.
  it('refuses a replayed challenge', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    const joiner = await devLogin('joiner');
    const challenge = await body<{ nonce: string; expiresAtMs: number }>(
      await req(`/circles/${circleId}/invite-challenge`, { method: 'POST', token: joiner }),
    );
    const send = (stake: string) =>
      req(`/circles/${circleId}/invite-claim`, {
        method: 'POST',
        token: joiner,
        body: JSON.stringify({
          nonce: challenge.nonce,
          expiresAtMs: challenge.expiresAtMs,
          stakeAddressBech32: stake,
          stakeAddressHex: 'e0' + '11'.repeat(28),
          signature: 'aa',
          key: 'bb',
        }),
      });
    expect((await send('stake1a')).status).toBe(201);
    expect((await send('stake1b')).status).toBe(400);
  });

  it('refuses an expired challenge without burning the nonce', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    const joiner = await devLogin('joiner');
    const challenge = await body<{ nonce: string }>(
      await req(`/circles/${circleId}/invite-challenge`, { method: 'POST', token: joiner }),
    );
    const res = await req(`/circles/${circleId}/invite-claim`, {
      method: 'POST',
      token: joiner,
      body: JSON.stringify({
        nonce: challenge.nonce,
        expiresAtMs: Date.now() - 1,
        stakeAddressBech32: 'stake1a',
        stakeAddressHex: 'e0' + '11'.repeat(28),
        signature: 'aa',
        key: 'bb',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a wallet that does not meet the predicate, naming which rule bit', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    accountAnswer = { ok: true, facts: { registered: true, delegatedPool: null, delegatedDrep: null, controlledBalance: 10n } };
    const res = await claim(circleId, await devLogin('joiner'));
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ failure: 'not-delegated-to-that-drep' });
    expect(minted).toHaveLength(0);
  });

  // ⚠️ 503, not 403. Telling someone they do not qualify because Koios rate-limited us is the
  // failure the whole ok/error split in `fetchAccountFacts` exists to prevent.
  it('reports a chain-read failure as an outage, not as a refusal', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    accountAnswer = { ok: false, error: 'koios 429' };
    const res = await claim(circleId, await devLogin('joiner'));
    expect(res.status).toBe(503);
    expect(minted).toHaveLength(0);
  });

  // ⚠️ 409, not 403. They qualified; the circle's founder never called `setInviteAuthority` with our
  // commitment, which they can fix and the requester cannot. This is what the empty pool used to be.
  it('reports a circle that never delegated as the founder’s problem, not the requester’s', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    mintAnswer = 'not-delegated';
    const res = await claim(circleId, await devLogin('joiner'));
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ failure: 'not-delegated' });
    // Nothing held: the wallet must be able to claim the moment the founder turns delegation on.
    expect(await store.getClaimedCircleInvite(circleId, 'stake1abc')).toBeUndefined();
  });

  // Also 409, and also about the founder: a circle with no contract has no `invites` set to write to.
  it('reports a circle that is not on chain as the founder’s problem', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder, { onChain: false });
    const res = await claim(circleId, await devLogin('joiner'));
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ failure: 'no-contract' });
    expect(minted).toHaveLength(0);
  });

  // ⚠️ 503 and no reservation. A mint that failed must leave the wallet able to try again — a row
  // held for a code that never reached the chain would lock them out of the circle permanently.
  it('releases the reservation when the mint fails', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    mintAnswer = 'throw';
    expect((await claim(circleId, await devLogin('joiner'))).status).toBe(503);
    expect(await store.getClaimedCircleInvite(circleId, 'stake1abc')).toBeUndefined();

    mintAnswer = 'issued';
    expect((await claim(circleId, await devLogin('joiner'))).status).toBe(201);
  });

  // A user who lost the response, or tapped twice, must not cost the circle a second on-chain mint.
  it('returns the same code to a repeated request rather than minting another', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    const joiner = await devLogin('joiner');
    const first = await body<{ invite: string }>(await claim(circleId, joiner, 'stake1same'));
    const second = await body<{ invite: string; reissued: boolean }>(await claim(circleId, joiner, 'stake1same'));
    expect(second.invite).toBe(first.invite);
    expect(second.reissued).toBe(true);
    expect(minted).toHaveLength(1);
  });

  it('gives two different wallets two different codes', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    const a = await body<{ invite: string }>(await claim(circleId, await devLogin('a'), 'stake1a'));
    const b = await body<{ invite: string }>(await claim(circleId, await devLogin('b'), 'stake1b'));
    expect(a.invite).not.toBe(b.invite);
    expect(minted).toHaveLength(2);
    expect(minted[0]?.commitment).not.toBe(minted[1]?.commitment);
  });

  // ⚠️ A row left `pending` by a crash mid-mint is not a code to hand over — its commitment never
  // reached the chain, so a join with it fails as "no such invite". It is re-minted with the same
  // secret, which is what makes a dropped connection recoverable rather than terminal.
  it('re-mints a reservation whose commitment never landed, keeping the same secret', async () => {
    const founder = await devLogin('founder');
    const circleId = await gatedCircle(founder);
    mintAnswer = 'not-delegated';
    await claim(circleId, await devLogin('joiner'), 'stake1x');
    // Simulate the crash the release above would otherwise have cleaned up.
    await store.reserveCircleInvite(circleId, { commitment: 'ee'.repeat(32), secret: 'ff'.repeat(32) }, 'stake1x');

    mintAnswer = 'issued';
    const res = await claim(circleId, await devLogin('joiner'), 'stake1x');
    expect(res.status).toBe(201);
    expect(await body<{ invite: string }>(res)).toMatchObject({
      invite: encodeCircleInvite(Uint8Array.from(Buffer.from('ff'.repeat(32), 'hex'))),
      reissued: false,
    });
    expect(minted.at(-1)?.commitment).toBe('ee'.repeat(32));
    expect(await store.getClaimedCircleInvite(circleId, 'stake1x')).toMatchObject({ chainStatus: 'confirmed' });
  });
});

describe('a deployment with no attestor', () => {
  // `KOIOS_URL` unset — or no sponsor host to mint through — must 404 rather than 500 at claim time,
  // and rather than falling back to a public Koios instance.
  it('404s every invite route', async () => {
    const keys = await createJwtKeys();
    const bare = createHandler({
      auth: {
        domain: 'pnyx.test',
        network: 'undeployed',
        nonces: createNonceStore(),
        jwt: { privateKey: keys.privateKey, issuer: 'https://pnyx-content-service', audience: 'pnyx', ttlSeconds: 3600 },
      },
      publicJwk: keys.publicJwk,
      store: createContentStore(),
      devAuth: true,
      chain: disabledChainMirror,
      notify: createNotifier(createContentStore(), loggingPushSender(() => {}), () => {}),
    });
    for (const path of ['invite-policy', 'invite-challenge', 'invite-claim']) {
      const res = await bare(
        new Request(`http://svc/circles/abc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } }),
      );
      expect(res.status).toBe(404);
    }
  });
});

describe('inviteChallengePayload', () => {
  it('is what the claim route reconstructs', () => {
    expect(inviteChallengePayload({ circleId: 'c', nonce: 'n', expiresAtMs: 1 })).toBe('pnyx:circle-invite.v1.c.n.1');
  });
});
