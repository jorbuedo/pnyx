// The invite attestor's Worker-side backends: a CIP-8 verifier and the Cardano read.
//
// Its own module for the reason `bug-report-worker.ts` is: the route logic in `routes.ts` is worth
// testing without a network, so the two impure things it needs are a port, and this is the
// production implementation of that port.

import {AddressHex} from '@evolution-sdk/review/Brands'
import * as Cose from '@evolution-sdk/review/Cose';
import { Effect } from 'effect';
import { coseSign1PayloadIs } from './cose-payload.js';
import { fetchAccountFacts } from './koios-account.js';
import type { InviteAttestorPorts } from './routes.js';

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * How this Worker reaches the one thing it cannot do: prove a contract call.
 *
 * The sponsor host holds the wallet, the prover and the invite-authority root; Cloudflare holds none
 * of them and should not. Both routes are behind the same bearer token as every other inward call.
 */
export type InviteMintLink = {
  /** Base URL the tunnel resolves to, e.g. `https://sponsor.internal`. */
  readonly url: string;
  readonly token: string;
  /**
   * Which wallet process on the host answers — one per network, behind a router.
   *
   * ⚠️ **Named rather than defaulted.** The router falls back to `SPONSOR_DEFAULT_NETWORK` when a
   * request names none, which works right up until the default moves; a circle's invites would then
   * be minted by a wallet on a chain the circle is not on, and the refusal arrives deep inside
   * `balanceTx`. It is also what makes the router's "named no network" warning mean something.
   */
  readonly network: string;
  readonly fetchImpl?: typeof fetch;
};

/**
 * The two sentences the contract builder refuses a non-delegating circle with, verbatim.
 *
 * ⚠️ **Narrow on purpose.** A looser pattern — anything containing "invite authority" — also matches
 * *our* configuration failure ("this host holds no invite authority"), which is a 503 we must fix and
 * not a 409 the founder must. The strings are pinned in `preimage.rs`'s `build_issue_invite_proven_tx`
 * and in `circle-invite-worker.test.ts`, so a wording change fails a test rather than silently
 * reclassifying every refusal as an outage.
 */
const NOT_DELEGATED = /this circle has delegated invite issuance to nobody|not this circle.s invite authority/i;

export const createInviteAttestorPorts = (deps: {
  readonly koiosUrl: string;
  readonly mintLink: InviteMintLink;
}): InviteAttestorPorts => ({
  verify: async ({ signatureHex, keyHex, addressHex, expectedPayload }) => {
    // ⚠️ **Content first, and both checks or neither.** `Cose.verifyDataForAddress` proves the
    // signature is valid and that the key owns the address — and nothing about *what* was signed.
    // On its own it would accept any signature this wallet ever produced, which for a Cardano
    // stake key includes the Koios and SteelSwap challenges. The payload comparison is the half
    // that makes this challenge mean this challenge.
    if (!coseSign1PayloadIs(fromHex(signatureHex), expectedPayload)) return false;
    // `verifyDataForAddress`, never `verifyData`: this authorizes an invite, so CIP-8's P1
    // (key ↔ address) is mandatory rather than skipped when the header omits a claim. The address
    // passed here is the one the predicate will be evaluated against, so the binding is what makes
    // the whole check about the right wallet.
    return Effect.runPromise(
      // The address the CLIENT claims to control; P1 inside `verifyDataForAddress` is what
      // tests that claim against the key, so the brand asserts only its form here.
      Cose.verifyDataForAddress({ signature: signatureHex, key: keyHex }, AddressHex(addressHex)).pipe(
        Effect.catchAll((error) => {
          // A malformed signature is an ordinary bad request; log and refuse, never throw into
          // the route.
          console.log(`[invite] signature could not be parsed: ${String(error)}`);
          return Effect.succeed(false);
        }),
      ),
    );
  },
  accountFacts: (stakeAddressBech32) => fetchAccountFacts(deps.koiosUrl, stakeAddressBech32),

  authorityCommitment: async (circleId) => {
    const reply = await callHost(deps.mintLink, '/internal/invite-authority', { circleId });
    const commitment = (reply as { commitment?: unknown }).commitment;
    if (typeof commitment !== 'string' || !/^[0-9a-f]{64}$/.test(commitment)) {
      throw new Error(`the sponsor host did not return an authority commitment: ${JSON.stringify(reply).slice(0, 200)}`);
    }
    return commitment;
  },

  mint: async ({ circleId, contractAddress, commitment }) => {
    let reply: unknown;
    try {
      reply = await callHost(deps.mintLink, '/internal/issue-invite', {
        circleId,
        contractAddress,
        commitment,
        active: true,
      });
    } catch (error) {
      // ⚠️ **The refusal arrives as a message, not a status.** A circle that never delegated is
      // reported by the contract builder as "not this circle's invite authority", and the host
      // forwards it as a 400 — which reaches here as a thrown error like any other transport
      // failure. Separating the two is what keeps a founder's misconfiguration out of the 503 bucket
      // that means "we are broken".
      if (NOT_DELEGATED.test(error instanceof Error ? error.message : String(error))) return 'not-delegated';
      throw error;
    }
    if ((reply as { issued?: unknown }).issued !== true) {
      throw new Error(`the sponsor host did not issue the invite: ${JSON.stringify(reply).slice(0, 200)}`);
    }
    return 'issued';
  },
});

/**
 * One inward call, with the two failure shapes this tunnel produces folded into thrown errors.
 *
 * ⚠️ **A sponsor failure is `200` with `ok: false`**, not a 5xx: Cloudflare replaces the body of any
 * 5xx from a tunnel origin with its own error page, so the host reports genuine failures under a
 * status whose body survives (`sponsor-failure.ts`). Reading only `response.ok` here would take a
 * failed mint for a successful one.
 */
const callHost = async (link: InviteMintLink, path: string, body: Record<string, unknown>): Promise<unknown> => {
  const doFetch = link.fetchImpl ?? fetch;
  const response = await doFetch(`${link.url.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}` },
    body: JSON.stringify({ ...body, network: link.network }),
  });
  const reply = (await response.json().catch(() => ({}))) as { error?: unknown; ok?: unknown };
  if (!response.ok || reply.ok === false) {
    const message = typeof reply.error === 'string' ? reply.error : `sponsor host responded ${response.status}`;
    throw new Error(message);
  }
  return reply;
};
