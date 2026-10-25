// The concrete checks behind `GET /status`. Kept apart from `status.ts` so the roll-up and the page
// stay pure and testable, and only the parts that touch the network live here.

import type { SponsorLink } from './sponsor-client.js';
import { type Component, isComponentState } from './status.js';
import type { ContentStore } from './store.js';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Ask the sponsor host for its own verdict.
 *
 * Its `/status` answers 503 while the wallet is still syncing, with a perfectly good body — so the HTTP
 * status is ignored and the body is what counts. Only a network error or an unparseable body means
 * "unreachable", which is the distinction that separates "the box is down" from "the box is starting".
 *
 * ⚠️ **Bounded, because the sponsor can be alive and unable to answer.** A cold DUST rebuild pins its
 * single JS thread for ~35 minutes and its own HTTP port starves — observed 2026-08-25, when this
 * endpoint returned *nothing at all* for minutes because the subrequest never settled. A health page
 * that goes silent exactly when something is wrong with the thing it reports on is worse than one that
 * says "no answer".
 */
const SPONSOR_TIMEOUT_MS = 5_000;

export const sponsorProbe =
  (link: SponsorLink | undefined) =>
  async (): Promise<Component> => {
    if (link === undefined) {
      return { state: 'unknown', detail: 'no sponsor is configured for this deployment' };
    }
    const doFetch = link.fetchImpl ?? fetch;
    const base = link.url.replace(/\/+$/, '');
    let body: unknown;
    try {
      const res = await doFetch(`${base}/status`, {
        headers: { authorization: `Bearer ${link.token}` },
        signal: AbortSignal.timeout(SPONSOR_TIMEOUT_MS),
      });
      if (res.status === 401) return { state: 'failing', detail: 'sponsor rejected our token' };
      body = await res.json();
    } catch (error) {
      // A timeout is not the same fact as a refused connection: the box is up and busy, which is what a
      // long rebuild looks like from here. Reported as such rather than folded into "unreachable".
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return timedOut
        ? { state: 'failing', detail: `sponsor did not answer within ${SPONSOR_TIMEOUT_MS} ms` }
        : { state: 'failing', detail: `sponsor unreachable: ${message(error)}` };
    }
    const report = body as { status?: unknown; reasons?: unknown; networks?: unknown };
    if (!isComponentState(report.status)) {
      // Deliberately not echoing the body: it is unrecognisable, so nothing here knows what is in it.
      return { state: 'failing', detail: 'sponsor answered without a recognisable status' };
    }
    // Only the status, the reasons and the network *names* cross this boundary. The sponsor's own
    // `/status` carries balances and is behind its token; this endpoint is public, and reasons are
    // written to be safe to publish.
    const reasons = Array.isArray(report.reasons) ? report.reasons.filter((r): r is string => typeof r === 'string') : [];
    const detail = [networksLine(report.networks), ...reasons].filter((one) => one !== null).join('; ');
    return { state: report.status, detail: detail === '' ? null : detail };
  };

/**
 * Which networks the host serves, and each one's word — `preview ok, preprod ok, mainnet starting`.
 *
 * ⚠️ **Names only, never a balance.** This page is public. What it adds over `reasons` is the networks
 * that are *fine*: a report listing only what is wrong cannot be told from a host that has quietly
 * stopped serving a network altogether, which is how "the sponsor is ok" hid a preview outage on
 * 2026-08-28.
 *
 * `null` for a single-network host, which has no `networks` field and nothing to summarise.
 */
const networksLine = (networks: unknown): string | null => {
  if (typeof networks !== 'object' || networks === null || Array.isArray(networks)) return null;
  const parts = Object.entries(networks as Record<string, unknown>).map(([network, report]) => {
    const status = (report as { status?: unknown } | null)?.status;
    return `${network} ${typeof status === 'string' ? status : 'unknown'}`;
  });
  return parts.length === 0 ? null : parts.join(', ');
};

/** Prove the D1 binding answers. `listCircles` is the cheapest read that touches it. */
export const storeProbe =
  (store: Pick<ContentStore, 'listCircles'>) =>
  async (): Promise<Component> => {
    try {
      // The count is deliberately not reported: circles can be private, and this page is public. That
      // the read returned at all is the whole signal — it proves the binding answers.
      await store.listCircles();
      return { state: 'ok', detail: 'binding answers' };
    } catch (error) {
      return { state: 'failing', detail: `store read failed: ${message(error)}` };
    }
  };

/**
 * Whether this deployment can write to chain at all.
 *
 * `degraded` rather than `failing` when the chain plane is off: the content plane still serves, and a
 * deployment can legitimately run without one — it is the pre-VPS composition. But it is not `ok`, since
 * registration and every sponsored write will refuse.
 */
export const chainProbe =
  (chain: { readonly enabled: boolean; readonly identityCodeDigest?: string }) =>
  async (): Promise<Component> => {
    if (!chain.enabled) return { state: 'degraded', detail: 'chain plane disabled; writes are refused' };
    // The **template**, not a deployment: with one contract per identity there is no address to report,
    // and a digest is what says which identity contracts this deployment will believe.
    if (chain.identityCodeDigest === undefined || chain.identityCodeDigest === '') {
      return { state: 'degraded', detail: 'no identity template configured; logins cannot be checked' };
    }
    return { state: 'ok', detail: `identity template ${chain.identityCodeDigest.slice(0, 12)}…` };
  };
