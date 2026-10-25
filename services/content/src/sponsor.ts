// The sponsor half of the chain plane: balance a device-proven transaction with the sponsor wallet,
// submit it, watch it land, and report where it ended up.
//
// **Why this is a separate piece.** It is the only part of the backend that cannot run on a Worker: it
// needs a wallet synced to live chain continuously, funds, and a long-lived ordered queue. Everything
// else about the service is request-shaped and runs fine on Cloudflare, so the split is drawn exactly
// here (`docs/cloudflare-migration-plan.md`, the `vps-sponsor-service` memory).
//
// It does **not** prove anything. Clients prove on-device; balancing and submitting are not proving
// paths, which is why the box needs no proof server.
//
// The same queue serves both compositions — the monolith `server.ts` (local docker dev, sink writes
// straight to the content store) and the VPS entry point (sink reports back to Cloudflare, which owns
// the D1 row). One implementation, two sinks: forking it is how the deployed path and the path anyone
// actually runs locally drift apart.

import type { ChainClient, ChainTx } from '@pnyx/chain-client/client';
import type { ProvenSettlement } from './chain.js';
import { applySettlement } from './sponsor-client.js';
import type { ChainRef } from './store.js';

/**
 * Where a settlement outcome is recorded.
 *
 * The queue does not know whether that is a local store or an HTTP call to the origin that owns the
 * row — which is the whole point of the seam.
 */
export type SettlementSink = {
  settle(settlement: ProvenSettlement, chain: ChainRef): Promise<void>;
};

export type SponsorQueue = {
  /**
   * Balance + submit a device-proven transaction, settling `settlement` as it goes.
   *
   * **Resolves with where it landed, and rejects with why it did not.** A caller that does not care
   * may drop the promise — the FIFO tail already carries its own handler, so an ignored rejection is
   * logged rather than unhandled. Most kinds do exactly that, because their outcome reaches the app
   * as a ChainRef row moving pending → confirmed/failed.
   *
   * ⚠️ **A transfer has no such row**, so for a transfer the returned promise is the *only* channel
   * that can carry a failure. Acking it on enqueue is what let a transfer die at the sponsor while
   * the device showed "Pending" until its lock expired an hour later (observed 2026-09-30). Same
   * reasoning as `submitIdentityRow` below, which has been awaited for this reason since it shipped.
   */
  submitProven(settlement: ProvenSettlement, txBytes: Uint8Array, requestId?: string): Promise<ChainTx>;
  /**
   * Relay a proven `publishIdentityRow`. Awaited, unlike the others: registration is the precondition
   * for the caller's first login, so it needs to know whether the row is going on chain rather than
   * discovering later that it never did. No ChainRef — the row is not content-plane state.
   *
   * Resolves with where the transaction landed. There is no row to record it on, so if the caller does
   * not log it the only trace of a sponsored registration is "it worked" — and nothing can then find
   * that transaction on chain.
   */
  submitIdentityRow(txBytes: Uint8Array, requestId?: string): Promise<ChainTx>;
  /** Resolves when the queue has drained. For tests and for a clean shutdown. */
  whenIdle(): Promise<void>;
};

const describe = (s: ProvenSettlement): string =>
  s.kind === 'membership'
    ? `membership(${s.circleId}/${s.subject})`
    : s.kind === 'vote'
      ? `vote(${s.proposalId}/${s.subject})`
      : s.kind === 'circle'
        ? `circle(${s.circleId})`
        : s.kind === 'transfer'
          ? `transfer(${s.subject})`
          : s.kind === 'invite'
            ? `invite(${s.circleId}/${s.commitment.slice(0, 8)}…)`
            : s.kind === 'invite-authority'
              ? `invite-authority(${s.circleId})`
              : `proposal(${s.proposalId})`;

/**
 * Serialise submissions onto one ordered chain.
 *
 * Ordered because the chain client's own transaction queue is: two submissions racing produce a
 * coin race (`DustDoubleSpend`) rather than two landed transactions. Dependencies also resolve in
 * order this way — a circle confirms before the join that references it.
 */
export const createSponsorQueue = (
  client: Pick<ChainClient, 'submitProven'>,
  sink: SettlementSink,
  log: (message: string) => void,
): SponsorQueue => {
  let tasks: Promise<unknown> = Promise.resolve();
  /**
   * Queue `task` behind everything already queued and hand its outcome back.
   *
   * ⚠️ **The tail keeps its own `catch` and the caller gets an uncaught-able copy.** `tasks` must
   * never stay rejected or every later op inherits the failure, and the returned promise must still
   * reject so a caller can report it — so the two are deliberately different promises rather than
   * one shared handle.
   */
  const run = <T>(label: string, task: () => Promise<T>): Promise<T> => {
    const result = tasks.then(task, task);
    tasks = result.catch((error: unknown) => {
      log(`sponsor ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;
  };

  return {
    submitProven: (settlement, txBytes, requestId) => {
      // Marked pending immediately so the badge appears before the transaction is anywhere near the
      // chain; the queued task waits on that write so the two cannot land out of order.
      const marked = sink.settle(settlement, { status: 'pending' });
      return run(`submitProven ${describe(settlement)}${requestId === undefined ? '' : ` req=${requestId}`}`, async () => {
        await marked;
        try {
          const tx = await client.submitProven(txBytes);
          // circle/proposal carry the device-computed sequential id; membership/vote have none.
          const chainId = 'chainId' in settlement ? settlement.chainId : undefined;
          await sink.settle(settlement, { status: 'confirmed', txId: tx.txId, ...(chainId ? { chainId } : {}) });
          log(`device-proven ${describe(settlement)} on-chain (${tx.txId})`);
          return tx;
        } catch (error) {
          await sink.settle(settlement, { status: 'failed', error: String(error) });
          throw error;
        }
      });
    },
    submitIdentityRow: (txBytes) => client.submitProven(txBytes),
    whenIdle: () => tasks.then(() => undefined, () => undefined),
  };
};

/**
 * A sink that writes straight to the content store — the monolith composition.
 *
 * Delegates to {@link applySettlement} rather than repeating its switch: the hosted deployment reaches
 * the same writes through `POST /internal/settle`, and two copies of "which row does this settlement
 * touch" is how the two drift. That already happened once — the founder-membership rule was added here
 * and the hosted path, which is the one that runs in production, did not have it.
 */
export const storeSettlementSink = (
  store: Parameters<typeof applySettlement>[0],
): SettlementSink => ({
  settle: (s, chain) => applySettlement(store, s, chain),
});
