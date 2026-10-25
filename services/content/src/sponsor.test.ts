// The sponsor queue: ordering, the pending→confirmed/failed transitions, and that one failure does
// not poison the queue behind it.
import { describe, expect, it, vi } from 'vitest';
import type { Circle } from './store.js';
import type { ProvenSettlement } from './chain.js';
import { callbackSettlementSink } from './sponsor-callback.js';
import { createSponsorQueue, storeSettlementSink } from './sponsor.js';
import type { ChainRef } from './store.js';

const circle = (id: string): ProvenSettlement => ({ kind: 'circle', circleId: id, chainId: '7' });
const membership: ProvenSettlement = { kind: 'membership', circleId: 'c1', subject: 'pnyx_id1' };

const recordingSink = () => {
  const seen: { settlement: ProvenSettlement; chain: ChainRef }[] = [];
  return { seen, settle: async (settlement: ProvenSettlement, chain: ChainRef) => void seen.push({ settlement, chain }) };
};

describe('createSponsorQueue', () => {
  it('marks pending immediately, then confirmed with the tx id', async () => {
    const sink = recordingSink();
    const queue = createSponsorQueue({ submitProven: async () => ({ txId: 'tx-1', blockHeight: '1' }) }, sink, () => {});

    queue.submitProven(circle('c1'), new Uint8Array([1]));
    // Pending is written synchronously enough that the badge appears before anything reaches chain.
    await Promise.resolve();
    expect(sink.seen[0]?.chain.status).toBe('pending');

    await queue.whenIdle();
    expect(sink.seen.map((s) => s.chain.status)).toEqual(['pending', 'confirmed']);
    expect(sink.seen[1]?.chain).toMatchObject({ status: 'confirmed', txId: 'tx-1', chainId: '7' });
  });

  // A sponsored registration settles no ChainRef, so the returned tx is the *only* handle on it. Dropping
  // it — as this did until 2026-08-04 — leaves "it worked" and no way to find the transaction on chain.
  it('hands back where an identity row landed', async () => {
    const queue = createSponsorQueue(
      { submitProven: async () => ({ txId: 'tx-id-row', blockHeight: '4242' }) },
      recordingSink(),
      () => {},
    );
    await expect(queue.submitIdentityRow(new Uint8Array([1]))).resolves.toEqual({
      txId: 'tx-id-row',
      blockHeight: '4242',
    });
  });

  it('propagates an identity-row failure rather than resolving as if it landed', async () => {
    const queue = createSponsorQueue(
      {
        submitProven: async () => {
          throw new Error('sponsorship refused: nope');
        },
      },
      recordingSink(),
      () => {},
    );
    await expect(queue.submitIdentityRow(new Uint8Array([1]))).rejects.toThrow('sponsorship refused: nope');
  });

  // membership/vote carry no on-chain id, so none must be invented for them.
  it('omits chainId for settlements that have none', async () => {
    const sink = recordingSink();
    const queue = createSponsorQueue({ submitProven: async () => ({ txId: 'tx-2', blockHeight: '1' }) }, sink, () => {});
    queue.submitProven(membership, new Uint8Array([1]));
    await queue.whenIdle();
    expect(sink.seen[1]?.chain.chainId).toBeUndefined();
  });

  it('records a failure with its reason instead of leaving the ref pending', async () => {
    const sink = recordingSink();
    const queue = createSponsorQueue(
      {
        submitProven: async () => {
          throw new Error('insufficient dust');
        },
      },
      sink,
      () => {},
    );
    queue.submitProven(circle('c1'), new Uint8Array([1]));
    await queue.whenIdle();
    expect(sink.seen[1]?.chain).toMatchObject({ status: 'failed' });
    expect(sink.seen[1]?.chain.error).toContain('insufficient dust');
  });

  // Ordered on purpose: concurrent submissions from one wallet produce a coin race rather than two
  // landed transactions, and dependencies (a circle before the join that references it) need the order.
  it('submits strictly in order', async () => {
    const order: string[] = [];
    const queue = createSponsorQueue(
      {
        submitProven: async (bytes: Uint8Array) => {
          const label = `tx-${bytes[0]}`;
          // The first one takes longer, so an unordered queue would finish it second.
          await new Promise((resolve) => setTimeout(resolve, bytes[0] === 1 ? 20 : 0));
          order.push(label);
          return { txId: label, blockHeight: '1' };
        },
      },
      recordingSink(),
      () => {},
    );
    queue.submitProven(circle('c1'), new Uint8Array([1]));
    queue.submitProven(circle('c2'), new Uint8Array([2]));
    await queue.whenIdle();
    expect(order).toEqual(['tx-1', 'tx-2']);
  });

  // One user's failed transaction must not stop everybody else's.
  it('keeps draining after a failure', async () => {
    let calls = 0;
    const sink = recordingSink();
    const queue = createSponsorQueue(
      {
        submitProven: async () => {
          calls += 1;
          if (calls === 1) throw new Error('nope');
          return { txId: 'tx-ok', blockHeight: '1' };
        },
      },
      sink,
      () => {},
    );
    queue.submitProven(circle('c1'), new Uint8Array([1]));
    queue.submitProven(circle('c2'), new Uint8Array([2]));
    await queue.whenIdle();
    expect(sink.seen.filter((s) => s.chain.status === 'confirmed')).toHaveLength(1);
    expect(sink.seen.filter((s) => s.chain.status === 'failed')).toHaveLength(1);
  });
});

describe('storeSettlementSink', () => {
  const sinkOver = (calls: string[], founderSubject?: string) =>
    storeSettlementSink({
      getCircle: async () =>
        ({ id: 'c1', name: 'C', description: '', author: 'a', createdAt: 'now', memberCount: 1, isOpen: true,
           ...(founderSubject === undefined ? {} : { founderSubject }) }) as Circle,
      setCircleChain: async (id) => void calls.push(`circle:${id}`),
      setMembershipChain: async (id, subject) => void calls.push(`membership:${id}:${subject}`),
      setProposalChain: async (id) => void calls.push(`proposal:${id}`),
      confirmCircleInvite: async (id, commitment) => void calls.push(`invite:${id}:${commitment}`),
      setVoteChain: async (id, subject) => void calls.push(`vote:${id}:${subject}`),
    });

  it('routes each settlement kind to its own setter', async () => {
    const calls: string[] = [];
    const sink = sinkOver(calls);
    await sink.settle({ kind: 'circle', circleId: 'c1' }, { status: 'pending' });
    await sink.settle(membership, { status: 'pending' });
    await sink.settle({ kind: 'proposal', proposalId: 'p1' }, { status: 'pending' });
    await sink.settle({ kind: 'vote', proposalId: 'p1', subject: 's1' }, { status: 'pending' });
    expect(calls).toEqual(['circle:c1', 'membership:c1:pnyx_id1', 'proposal:p1', 'vote:p1:s1']);
  });

  // The constructor seats the founder's member leaf, so the deploy *is* their join — there is no
  // second transaction whose settlement would otherwise mark it.
  it("settles the founder's membership with the circle's own deploy", async () => {
    const calls: string[] = [];
    await sinkOver(calls, 'pnyx_founder').settle({ kind: 'circle', circleId: 'c1' }, { status: 'confirmed', txId: 't' });
    expect(calls).toEqual(['circle:c1', 'membership:c1:pnyx_founder']);
  });

  // Before the founder settles their deploy there is no subject recorded, and inventing one would
  // write a membership row against a subject nobody owns.
  it('settles only the circle when no founder subject is recorded yet', async () => {
    const calls: string[] = [];
    await sinkOver(calls).settle({ kind: 'circle', circleId: 'c1' }, { status: 'confirmed', txId: 't' });
    expect(calls).toEqual(['circle:c1']);
  });
});

describe('callbackSettlementSink', () => {
  const sleep = async () => {};

  it('reports the settlement to the origin with the shared secret', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo, _init?: RequestInit) => new Response('{}', { status: 200 }));
    const sink = callbackSettlementSink({
      originUrl: 'https://origin.test/',
      token: 'secret',
      log: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await sink.settle(circle('c1'), { status: 'confirmed', txId: 'tx-1' });
    // Trailing slash in the origin must not produce a double slash in the path.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://origin.test/internal/settle');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toEqual({
      settlement: { kind: 'circle', circleId: 'c1', chainId: '7' },
      chain: { status: 'confirmed', txId: 'tx-1' },
    });
  });

  // The transaction has already landed when the report is sent, so dropping it would leave a
  // confirmed circle showing `pending` forever with nothing to reconcile it.
  it('retries a 5xx until it succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('', { status: calls < 3 ? 500 : 200 });
    });
    const sink = callbackSettlementSink({
      originUrl: 'https://origin.test',
      token: 't',
      log: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await sink.settle(circle('c1'), { status: 'confirmed', txId: 'x' });
    expect(calls).toBe(3);
  });

  // A 4xx is our own bug — a bad token or a bad shape — and repetition will not fix it.
  it('does not retry a 4xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad token', { status: 401 }));
    const log = vi.fn();
    const sink = callbackSettlementSink({
      originUrl: 'https://origin.test',
      token: 't',
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await sink.settle(circle('c1'), { status: 'confirmed', txId: 'x' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });

  // Giving up must be loud: the chain and the content plane now disagree and nothing will correct it.
  it('gives up after the attempt budget, saying what is now wrong', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('tunnel down');
    });
    const log = vi.fn();
    const sink = callbackSettlementSink({
      originUrl: 'https://origin.test',
      token: 't',
      attempts: 3,
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    await sink.settle(circle('c1'), { status: 'confirmed', txId: 'x' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.at(-1)?.[0]).toContain('GAVE UP');
  });
});

/*
 * The queue used to return `void`, so a sponsored transfer's only failure channel was this host's
 * journal: the origin answered 202 on enqueue and the device showed "Pending" until its input lock
 * expired an hour later. Observed on preprod 2026-09-30 — the transfer never reached a block and
 * nothing anywhere told the device. `submitProven` now resolves with where it landed.
 */
describe('createSponsorQueue reports where a submission landed', () => {
  const transfer: ProvenSettlement = { kind: 'transfer', subject: 'pnyx_id1' };

  it('resolves with the tx the client submitted', async () => {
    const sink = recordingSink();
    const queue = createSponsorQueue(
      { submitProven: async () => ({ txId: 'tx-9', blockHeight: '42' }) },
      sink,
      () => {},
    );

    await expect(queue.submitProven(transfer, new Uint8Array([1]))).resolves.toEqual({
      txId: 'tx-9',
      blockHeight: '42',
    });
  });

  it('rejects with the reason the chain client gave, rather than swallowing it', async () => {
    const sink = recordingSink();
    const queue = createSponsorQueue(
      { submitProven: () => Promise.reject(new Error('Custom error: 104 — InvalidError::Transcript')) },
      sink,
      () => {},
    );

    await expect(queue.submitProven(transfer, new Uint8Array([1]))).rejects.toThrow('Custom error: 104');
    // The failure still reaches the sink, so a settlement that HAS a row is unaffected by the change.
    expect(sink.seen.at(-1)?.chain.status).toBe('failed');
  });

  // The tail must not stay rejected, or every later submission inherits the earlier failure — and a
  // caller that never awaits must not raise an unhandled rejection either.
  it('a rejected submission does not poison the ones behind it', async () => {
    const sink = recordingSink();
    let call = 0;
    const queue = createSponsorQueue(
      {
        submitProven: async () => {
          call += 1;
          if (call === 1) throw new Error('first one fails');
          return { txId: 'tx-after', blockHeight: '7' };
        },
      },
      sink,
      () => {},
    );

    await expect(queue.submitProven(transfer, new Uint8Array([1]))).rejects.toThrow('first one fails');
    await expect(queue.submitProven(transfer, new Uint8Array([2]))).resolves.toEqual({
      txId: 'tx-after',
      blockHeight: '7',
    });
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });

  it('whenIdle settles even when the last submission failed', async () => {
    const sink = recordingSink();
    const queue = createSponsorQueue({ submitProven: () => Promise.reject(new Error('nope')) }, sink, () => {});
    queue.submitProven(transfer, new Uint8Array([1])).catch(() => undefined);
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });
});
