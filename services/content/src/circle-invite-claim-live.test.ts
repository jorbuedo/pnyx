// The claim endpoint, driven with a **real wallet** against the **real Koios** rail.
//
// ⚠️ **Everything else about this flow is tested against fakes.** `circle-invite-routes.test.ts`
// drives the same handler with a stub attestor, so it pins the decisions and none of the plumbing:
// no signature is ever produced, no chain read is ever made, and a field Koios renamed or a CIP-8
// binding that refuses a reward address would leave all of it green. This is the one test where a
// real staking key signs a real challenge and a real `account_info` answers.
//
// **What it can reach and what it cannot.** The wallet here is BIP-39's `abandon…about`, whose
// mainnet stake key is *not registered* — so the honest end of this path is the `403
// stake-key-not-registered` refusal. That is still the assertion worth having: reaching that verdict
// means the challenge was issued, the nonce was consumed, the CIP-8 signature verified **against a
// reward address**, Koios was called, and its answer was parsed. A signature failure is a different
// 403 with no `failure` field, so the two cannot be confused.
//
// Seeing a *successful* claim needs a wallet whose stake key is registered and delegating, i.e. a
// funded mainnet key. That is the remaining gap, and no test here can close it.
//
// ⚠️ **Skipped unless `KOIOS_LIVE_TESTS=1`.** It reaches a third party, so it must not run in the
// default suite: a rate limit there would be a red build about somebody else's uptime.
import { beforeAll, describe, expect, it } from 'vitest';
import {type AddressHex, type XprvHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {Cose} from '@pnyx/cardano-core';
import { Effect } from 'effect';
import { createJwtKeys } from './auth.js';
import { disabledChainMirror } from './chain.js';
import { createInviteAttestorPorts } from './circle-invite-worker.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { createContentStore } from './store.js';

const LIVE = process.env.KOIOS_LIVE_TESTS === '1';

/** Cardano **mainnet**, whatever Midnight network a circle is on — the predicates are about real keys. */
const KOIOS_URL = process.env.KOIOS_URL ?? 'https://api.koios.rest/api/v1';

const CONTRACT = 'ab'.repeat(32);
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
const utf8ToHex = (text: string): string =>
  Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');

let handler: (request: Request) => Promise<Response>;
let store: ReturnType<typeof createContentStore>;
let minted: unknown[];
let wallet: { xprv: XprvHex; rewardHex: AddressHex; rewardBech32: string };

beforeAll(async () => {
  if (!LIVE) return;
  // The app's own derivation: CIP-1852 role 2 (staking) at account 0, and the reward address built
  // from that key's hash — `circle-invite-request.ts` signs with exactly this.
  const mnemonic = `${'abandon '.repeat(11)}about`;
  const root = await run(Keys.rootKeyFromMnemonic(mnemonic));
  const xprv = await run(Keys.deriveCip1852(root, 0, 2, 0));
  const pub = await run(Keys.publicKey(xprv));
  const hash = await run(Keys.keyHash(pub));
  const rewardHex = Address.rewardHex(Address.Network.Mainnet, hash);
  const rewardBech32 = await run(Address.toBech32(rewardHex));
  wallet = { xprv, rewardHex, rewardBech32 };

  const keys = await createJwtKeys();
  store = createContentStore();
  minted = [];
  // ⚠️ The **real** verifier and the **real** Koios read; only the mint is a stub. Minting needs the
  // sponsor host's prover, which is verified separately — everything this test exists for happens
  // before it.
  const real = createInviteAttestorPorts({
    koiosUrl: KOIOS_URL,
    mintLink: { url: 'https://sponsor.invalid', token: 'unused', network: 'preprod' },
  });
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
    inviteAttestor: {
      verify: real.verify,
      accountFacts: real.accountFacts,
      authorityCommitment: async () => 'cd'.repeat(32),
      mint: async (input) => {
        minted.push(input);
        return 'issued';
      },
    },
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

describe.skipIf(!LIVE)('claiming an invite with a real wallet against live Koios', () => {
  it('reaches a verdict about the wallet — so the signature, the reward-address binding and the chain read all worked', async () => {
    const token = (
      await body<{ token: string }>(await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name: 'founder' }) }))
    ).token;
    const circleId = (
      await body<{ circle: { id: string } }>(
        await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'live', isOpen: false }) }),
      )
    ).circle.id;
    await store.setCircleChain(circleId, { status: 'confirmed', chainId: CONTRACT });
    await req(`/circles/${circleId}/invite-policy`, {
      method: 'POST',
      token,
      body: JSON.stringify({ rules: [{ kind: 'ada-threshold', param: '1' }] }),
    });

    const challenge = await body<{ nonce: string; expiresAtMs: number; payload: string }>(
      await req(`/circles/${circleId}/invite-challenge`, { method: 'POST', token }),
    );
    // `includeKid: true`, exactly as `circle-invite-request.ts` produces it.
    const signed = await run(
      Cose.signData(wallet.xprv, wallet.rewardHex, utf8ToHex(challenge.payload), true),
    );

    const claim = await req(`/circles/${circleId}/invite-claim`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        nonce: challenge.nonce,
        expiresAtMs: challenge.expiresAtMs,
        stakeAddressBech32: wallet.rewardBech32,
        stakeAddressHex: wallet.rewardHex,
        signature: signed.signature,
        key: signed.key,
      }),
    });

    // ⚠️ **The `failure` field is the whole assertion.** A refused *signature* is also a 403, but
    // carries no `failure` — so this one value proves the CIP-8 check passed against a reward
    // address, Koios was reached, and its row was parsed. A 503 here would mean Koios refused us,
    // which is not a verdict about the wallet and not a pass.
    expect(claim.status).toBe(403);
    expect(await body(claim)).toMatchObject({ failure: 'stake-key-not-registered' });
    // Nothing was minted for a wallet that did not qualify.
    expect(minted).toHaveLength(0);
  });

  // ⚠️ **The defect this pins**, found while answering "was this ever tested with a wallet": the app
  // built its reward address for the *funds* network the picker was on, so with `preview` selected it
  // signed for a `stake_test1…` address and the service asked **mainnet** Koios about it. Mainnet has
  // never seen a testnet address, so every wallet failed as `stake-key-not-registered` — reported as
  // the wallet's problem. The two axes are independent; a predicate about real ADA is mainnet-only.
  it('cannot look up a testnet reward address at all, which is why the app must not build one', async () => {
    const testnet = 'stake_test1uzuyjggttdrvsrdw5xa79ws83n83pywq4ntdyu0mfjkfquqc0je9y';
    const real = createInviteAttestorPorts({
      koiosUrl: KOIOS_URL,
      mintLink: { url: 'https://sponsor.invalid', token: 'unused', network: 'preprod' },
    });
    // ⚠️ **A 500, not an empty answer** — mainnet Koios rejects a testnet bech32 outright. So the
    // symptom was not even a wrong verdict: `fetchAccountFacts` correctly reports it as an outage,
    // the route answers **503 "try again shortly"**, and every person requesting an invite was told
    // to retry a failure that was entirely ours and would never clear.
    expect(await real.accountFacts(testnet)).toEqual({ ok: false, error: 'koios 500' });
  });

  // The negative control: without it, a verifier that refused *everything* would produce the same
  // 403 above and look like a pass.
  it('refuses a signature for a reward address the key does not own', async () => {
    const token = (
      await body<{ token: string }>(await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name: 'founder2' }) }))
    ).token;
    const circleId = (
      await body<{ circle: { id: string } }>(
        await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'live2', isOpen: false }) }),
      )
    ).circle.id;
    await store.setCircleChain(circleId, { status: 'confirmed', chainId: CONTRACT });
    await req(`/circles/${circleId}/invite-policy`, {
      method: 'POST',
      token,
      body: JSON.stringify({ rules: [{ kind: 'ada-threshold', param: '1' }] }),
    });

    const challenge = await body<{ nonce: string; expiresAtMs: number; payload: string }>(
      await req(`/circles/${circleId}/invite-challenge`, { method: 'POST', token }),
    );
    const signed = await run(
      Cose.signData(wallet.xprv, wallet.rewardHex, utf8ToHex(challenge.payload), true),
    );
    // A real, live, registered mainnet stake address that this key demonstrably does not own.
    const someoneElse = 'stake1u9ylzsgxaa6xctf4juup682ar3juj85n8tx3hthnljg47zctvm3rc';
    const claim = await req(`/circles/${circleId}/invite-claim`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        nonce: challenge.nonce,
        expiresAtMs: challenge.expiresAtMs,
        stakeAddressBech32: someoneElse,
        stakeAddressHex: `e1${'49f14106ef746c2d3597381d1d5d1c65c91e933acd1baef3fc915f0b'}`,
        signature: signed.signature,
        key: signed.key,
      }),
    });
    expect(claim.status).toBe(403);
    // No `failure`: refused at the signature, before any verdict about that wallet was reached.
    expect(await body<{ failure?: string }>(claim)).not.toHaveProperty('failure');
  });
});
