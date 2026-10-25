// The sink the VPS composition uses: report a settlement back to the origin that owns the row.
//
// Cloudflare owns the D1 content plane, so the sponsor host must not hold a second copy of what a
// circle's chain status is — the app would then have two sources of truth for one badge. The sponsor
// reports outcomes inward and CF writes them.
//
// Retries because the alternative is a permanently wrong row: the transaction has already landed
// on chain when the report is sent, so dropping it would leave a confirmed circle displaying
// `pending` forever, with nothing to reconcile it. Bounded, then logged loudly and given up on —
// see the note on `attempts`.

import type { ProvenSettlement } from './chain.js';
import type { SettlementSink } from './sponsor.js';
import type { ChainRef } from './store.js';

export type CallbackOptions = {
  /** The origin that owns the content plane, e.g. `https://pnyx.pxkq.uk`. */
  readonly originUrl: string;
  /** Shared secret; the origin refuses a report without it. */
  readonly token: string;
  /** How many times to try before giving up. Default 5. */
  readonly attempts?: number;
  /** Backoff between attempts, in ms. Default 2s, doubling. */
  readonly baseDelayMs?: number;
  readonly log: (message: string) => void;
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * Report settlements to the content origin.
 *
 * The report is idempotent by construction — it states what a ref *is* rather than incrementing
 * anything — so a retry that duplicates a delivered report is harmless. That is what makes retrying
 * the right call here and not merely a hopeful one.
 */
export const callbackSettlementSink = (options: CallbackOptions): SettlementSink => {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoint = `${options.originUrl.replace(/\/+$/, '')}/internal/settle`;

  const post = async (settlement: ProvenSettlement, chain: ChainRef): Promise<boolean> => {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ settlement, chain }),
    });
    // 4xx is our own bug (bad token, bad shape) and will not fix itself by repetition; 5xx and
    // network failures are worth another go.
    if (res.status >= 400 && res.status < 500) {
      options.log(`settlement report rejected ${res.status} (not retrying): ${await res.text().catch(() => '')}`);
      return true;
    }
    return res.ok;
  };

  return {
    settle: async (settlement, chain) => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          if (await post(settlement, chain)) return;
        } catch (error) {
          options.log(`settlement report attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
      // Loudly, because the row is now wrong and no later event will correct it: the transaction
      // landed but the content plane still says pending.
      options.log(
        `GAVE UP reporting settlement after ${attempts} attempts — ${JSON.stringify(settlement)} is ` +
          `${chain.status} on chain but the content plane was not told`,
      );
    },
  };
};
