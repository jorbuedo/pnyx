// Chain mirror regression tests.
//
// The headline scenario mirrors the on-device incident (2026-07-05): join + vote seconds
// apart; the join tx confirmed, then the vote was rejected at submission with
// `RpcError: 1010: Invalid Transaction: Custom error: 117`. Whatever the node-side cause
// (that day: zero-fee empty DustActions; the same shape covers a genuine dust
// double-spend race), the mirror + submitter must keep the vote 'pending' through the
// retry, resync the wallet, resubmit a rebuilt tx, and land both 'confirmed'.
import { type CoinSync, createTxSubmitter } from '@pnyx/chain-client/submission';
import type { ChainClient } from '@pnyx/chain-client/client';
import { describe, expect, it } from 'vitest';
import { createChainMirror } from './chain.js';
import { createContentStore } from './store.js';

const RPC_1010 = 'RpcError: 1010: Invalid Transaction: Custom error: 117';

describe('chain mirror coin-race recovery', () => {
  it('recovers when the second submission is rejected on a coin the first already spent', async () => {
    const store = createContentStore();
    const events: string[] = [];
    let resynced = false;
    const coinSync: CoinSync = {
      waitForOwnSpends: async () => {
        events.push('wait-observed');
      },
      resync: async () => {
        events.push('resync');
        resynced = true;
      },
    };

    // The race: the second transaction was balanced against the coin set from before the first's
    // spend, so the node rejects it the way it rejects a double-spend. Only after the wallet resyncs
    // can a rebuilt submission land. Driven through `submitProven` because that is the only rail
    // left — the 2026-07-05 incident predates it, but the submitter it exercises is the same one.
    let attempts = 0;
    const statusDuringRetry: (string | undefined)[] = [];
    const submitTx = createTxSubmitter(coinSync, {
      backoffMs: 1,
      sleep: async () => {
        statusDuringRetry.push((await store.getVoteChain(proposal.id, 'dev:alice'))?.status);
      },
    });

    const client = {
      submitProven: (txBytes: Uint8Array) =>
        submitTx('submitProven', async () => {
          attempts++;
          const which = txBytes[0] === 1 ? 'join' : 'vote';
          events.push(`submit:${which}#${attempts}`);
          if (which === 'vote' && !resynced) {
            throw new Error(RPC_1010);
          }
          return { txId: `tx-${which}`, blockHeight: String(attempts) };
        }),
    } as unknown as ChainClient;
    const mirror = createChainMirror(client, store, 'identity-addr', () => {});

    const circle = await store.createCircle({
      name: 'Race',
      description: '',
      subject: 'dev:owner',
      persona: 'owner',
      disclosed: false,
      isOpen: true,
    });
    const proposal = await store.createProposal({ circleId: circle.id, title: 'Fund it', body: '', author: 'owner' });
    await store.join({ circleId: circle.id, subject: 'dev:alice', persona: 'alice', disclosed: false });
    await store.castVote({ proposalId: proposal.id, subject: 'dev:alice', value: 'yes' });

    // The real-device repro: two device-proven submissions seconds apart.
    mirror.submitProven({ kind: 'membership', circleId: circle.id, subject: 'dev:alice' }, new Uint8Array([1]));
    mirror.submitProven({ kind: 'vote', proposalId: proposal.id, subject: 'dev:alice' }, new Uint8Array([2]));
    await mirror.whenIdle();

    expect(attempts).toBe(3); // join, vote rejected 1010, vote again after resync
    expect(events).toEqual([
      'submit:join#1',
      'wait-observed',
      'submit:vote#2',
      'resync',
      'submit:vote#3',
      'wait-observed',
    ]);
    expect(statusDuringRetry).toEqual(['pending']); // stays pending through the retry
    expect((await store.getMembership(circle.id, 'dev:alice'))?.chain).toMatchObject({
      status: 'confirmed',
      txId: 'tx-join',
    });
    expect(await store.getVoteChain(proposal.id, 'dev:alice')).toMatchObject({ status: 'confirmed', txId: 'tx-vote' });
  });

  it('blocks the queue after each submission until the wallet observed its own spend', async () => {
    const events: string[] = [];
    const coinSync: CoinSync = {
      waitForOwnSpends: async () => {
        events.push('wait-observed');
      },
      resync: async () => {},
    };
    const submit = createTxSubmitter(coinSync);
    await submit('join', async () => {
      events.push('submit:join');
      return {};
    });
    await submit('vote', async () => {
      events.push('submit:vote');
      return {};
    });
    expect(events).toEqual(['submit:join', 'wait-observed', 'submit:vote', 'wait-observed']);
  });
});

describe('chain mirror submitProven (device-proving rail)', () => {
  const stubClient = (submitProven: ChainClient['submitProven']): ChainClient => ({
    submitProven,
    readContractState: async () => new Uint8Array(),
    readIdentityRow: async () => undefined,
    stop: async () => {},
  });

  it('settles a device-proven membership pending → confirmed with the submitted txId', async () => {
    const store = createContentStore();
    const seen: Uint8Array[] = [];
    const client = stubClient(async (bytes) => {
      seen.push(bytes);
      return { txId: 'tx-proven-join', blockHeight: '9' };
    });
    const mirror = createChainMirror(client, store, 'contract-addr', () => {});

    const circle = await store.createCircle({ name: 'C', description: '', subject: 'dev:o', persona: 'o', disclosed: false, isOpen: true });
    await store.join({ circleId: circle.id, subject: 'dev:alice', persona: 'alice', disclosed: false });

    mirror.submitProven({ kind: 'membership', circleId: circle.id, subject: 'dev:alice' }, new Uint8Array([1, 2, 3]));
    await mirror.whenIdle();

    expect(seen).toEqual([new Uint8Array([1, 2, 3])]);
    expect((await store.getMembership(circle.id, 'dev:alice'))?.chain).toMatchObject({
      status: 'confirmed',
      txId: 'tx-proven-join',
    });
  });

  it('records the device-computed chainId for a proposal settlement', async () => {
    const store = createContentStore();
    const mirror = createChainMirror(
      stubClient(async () => ({ txId: 'tx-proven-prop', blockHeight: '9' })),
      store,
      'contract-addr',
      () => {},
    );
    const circle = await store.createCircle({ name: 'C', description: '', subject: 'dev:o', persona: 'o', disclosed: false, isOpen: true });
    const proposal = await store.createProposal({ circleId: circle.id, title: 'P', body: '', author: 'o' });

    mirror.submitProven({ kind: 'proposal', proposalId: proposal.id, chainId: '7' }, new Uint8Array([9]));
    await mirror.whenIdle();

    expect((await store.getProposal(proposal.id))?.chain).toMatchObject({
      status: 'confirmed',
      txId: 'tx-proven-prop',
      chainId: '7',
    });
  });

  it('marks the ChainRef failed when submitProven rejects', async () => {
    const store = createContentStore();
    const mirror = createChainMirror(
      stubClient(async () => {
        throw new Error('balance: insufficient dust');
      }),
      store,
      'contract-addr',
      () => {},
    );
    const circle = await store.createCircle({ name: 'C', description: '', subject: 'dev:o', persona: 'o', disclosed: false, isOpen: true });
    await store.join({ circleId: circle.id, subject: 'dev:alice', persona: 'alice', disclosed: false });

    mirror.submitProven({ kind: 'membership', circleId: circle.id, subject: 'dev:alice' }, new Uint8Array([1]));
    await mirror.whenIdle();

    expect((await store.getMembership(circle.id, 'dev:alice'))?.chain).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('insufficient dust'),
    });
  });
});


/*
 * The local mirror used to enqueue and answer `accepted: true` unconditionally — its own comment said
 * so. A transfer refused by the node therefore reached the device as a 202, and the device showed
 * "Pending" until its input lock expired. Preprod, 2026-09-30.
 */
describe('createChainMirror reports what the queue actually did', () => {
  const transfer = { kind: 'transfer', subject: 'pnyx_id1' } as const;

  it('answers with the tx id once the queue has submitted', async () => {
    const store = createContentStore();
    const client = {
      submitProven: () => Promise.resolve({ txId: 'tx-landed', blockHeight: '11' }),
    } as unknown as ChainClient;
    const mirror = createChainMirror(client, store, 'identity-addr', () => {});

    await expect(mirror.submitProven(transfer, new Uint8Array([1]))).resolves.toEqual({
      accepted: true,
      txId: 'tx-landed',
    });
  });

  it('answers accepted:false with the reason when the node refused', async () => {
    const store = createContentStore();
    const client = {
      submitProven: () => Promise.reject(new Error('Custom error: 104 — InvalidError::Transcript')),
    } as unknown as ChainClient;
    const mirror = createChainMirror(client, store, 'identity-addr', () => {});

    const outcome = await mirror.submitProven(transfer, new Uint8Array([1]));
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted === false && outcome.error).toContain('Custom error: 104');
  });
})
