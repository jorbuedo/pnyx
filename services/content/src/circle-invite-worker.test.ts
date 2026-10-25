// The Worker→sponsor-host half of the invite attestor.
//
// Two things are worth pinning, and both are about telling failures apart:
//
//   - **a sponsor failure is `200` + `ok: false`**, not a 5xx — Cloudflare replaces the body of any
//     5xx from a tunnel origin with its own error page, so reading `response.ok` alone would take a
//     failed mint for a successful one
//   - **"this circle never delegated" is not "we are broken"** — one is a `409` its founder fixes,
//     the other a `503` we fix, and the difference arrives only as a sentence in an error message
import { describe, expect, it } from 'vitest';
import { createInviteAttestorPorts } from './circle-invite-worker.js';

const link = (fetchImpl: typeof fetch) => ({
  url: 'https://sponsor.internal/',
  token: 'shh',
  network: 'preprod',
  fetchImpl,
});

const ports = (fetchImpl: typeof fetch) => createInviteAttestorPorts({ koiosUrl: 'https://koios.test', mintLink: link(fetchImpl) });

const reply = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as never;

const MINT = { circleId: 'c1', contractAddress: 'ab'.repeat(32), commitment: 'cd'.repeat(32) };

describe('authorityCommitment', () => {
  it('returns what the host derived', async () => {
    expect(await ports(reply({ commitment: 'ef'.repeat(32), minting: true })).authorityCommitment('c1')).toBe(
      'ef'.repeat(32),
    );
  });

  it('sends the token and the circle id', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ commitment: 'ef'.repeat(32) }));
    }) as never as typeof fetch;
    await ports(spy).authorityCommitment('c1');
    // One slash, not two: the base URL's trailing slash is stripped so the path is not doubled.
    expect(seen?.url).toBe('https://sponsor.internal/internal/invite-authority');
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer shh');
    // ⚠️ The network is named rather than left to the router's default: one wallet process per
    // network sits behind it, and a defaulted route would mint a circle's invite on the wrong chain.
    expect(JSON.parse(String(seen?.init.body))).toEqual({ circleId: 'c1', network: 'preprod' });
  });

  // A host that answered with something else is a bug on our side, and must not be passed along as a
  // commitment a founder would then post on chain.
  it.each([{}, { commitment: 'short' }, { commitment: 42 }])('throws on a malformed reply (%j)', async (bad) => {
    await expect(ports(reply(bad)).authorityCommitment('c1')).rejects.toThrow(/authority commitment/);
  });

  it('throws when the host refuses', async () => {
    await expect(ports(reply({ error: 'this host holds no invite authority' }, 404)).authorityCommitment('c1')).rejects.toThrow(
      /no invite authority/,
    );
  });
});

describe('mint', () => {
  it('reports a landed invite', async () => {
    expect(await ports(reply({ issued: true, txId: 'tx' }, 202)).mint(MINT)).toBe('issued');
  });

  // ⚠️ The two sentences the contract builder refuses a non-delegating circle with. They arrive as a
  // 400 from the host, i.e. as a thrown error like any transport failure — separating them is what
  // keeps a founder's misconfiguration out of the bucket that means "we are broken".
  it.each([
    'issue-invite refused: could not mint an invite: this circle has delegated invite issuance to nobody',
    "issue-invite refused: could not mint an invite: not this circle's invite authority",
  ])('classifies a non-delegating circle rather than throwing (%s)', async (message) => {
    expect(await ports(reply({ error: message }, 400)).mint(MINT)).toBe('not-delegated');
  });

  // ⚠️ The narrow half of that classification: our own missing configuration also mentions the invite
  // authority, and reporting it as the founder's problem would leave a 409 nobody can act on.
  it('does not classify our own missing configuration as the founder’s problem', async () => {
    await expect(ports(reply({ error: 'this host holds no invite authority: INVITE_AUTHORITY_ROOT is not set' }, 404)).mint(MINT)).rejects.toThrow();
  });

  // ⚠️ 200 + `ok: false` is how the host reports a genuine failure, because a 5xx body does not
  // survive the tunnel. Reading `response.ok` alone would report this as a successfully minted invite.
  it('treats a 200 with ok:false as a failure', async () => {
    await expect(ports(reply({ ok: false, error: 'issue-invite failed: balance failed' }, 200)).mint(MINT)).rejects.toThrow(
      /balance failed/,
    );
  });

  it('throws when the host answers without issuing', async () => {
    await expect(ports(reply({ accepted: true })).mint(MINT)).rejects.toThrow(/did not issue/);
  });
});
