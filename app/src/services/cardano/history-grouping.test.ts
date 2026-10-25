import type {AddressGroup, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {activityType, groupActivity, primaryMovement} from './history-grouping'
import {NIGHT_ASSET_ID} from './night-redeem'

const emptyGroup: AddressGroup = {entries: [], deltas: [], parties: []}
/** A group with one counterparty that received value — i.e. a real transfer. */
const receivingGroup: AddressGroup = {
  entries: [],
  deltas: [],
  parties: [{ownership: {level: 'none'}, addresses: [{hex: 'ff'}], sent: [], received: [{quantity: 1n}]}],
}

const txDelta = (delta: {assetId?: string; quantity: bigint}[]): ReviewedTransaction =>
  ({hash: 'x', ownDelta: delta, operations: []}) as unknown as ReviewedTransaction

// Minimal fixtures — groupActivity reads `timestamp`/`hash`; activityType reads
// `operations` plus the party tiers (a withdrawal only labels a tx "rewards"
// when nothing reached another party). Cast to keep the fixtures small.
const tx = (
  hash: string,
  iso: string | undefined,
  ops: {kind: string}[] = [],
  groups: Partial<Pick<ReviewedTransaction, 'identityGroup' | 'escrowGroup' | 'otherGroup'>> = {},
): ReviewedTransaction =>
  ({
    hash,
    timestamp: iso,
    operations: ops,
    ownDelta: [],
    inputs: [],
    outputs: [],
    ownGroup: emptyGroup,
    identityGroup: emptyGroup,
    escrowGroup: emptyGroup,
    otherGroup: emptyGroup,
    ...groups,
  }) as unknown as ReviewedTransaction

const OPTS = {
  nowMs: Date.parse('2026-07-18T12:00:00Z'),
  locale: 'en-US',
  today: 'Today',
  yesterday: 'Yesterday',
  pending: 'Pending',
} as const

describe('groupActivity', () => {
  it("opens one section per day and keeps that day's txs in order", () => {
    const items = groupActivity(
      [tx('a', '2026-07-18T09:00:00Z'), tx('b', '2026-07-18T08:00:00Z'), tx('c', '2026-07-16T10:00:00Z')],
      OPTS,
    )
    // One item per day, not one per row: the day's rows share a single painted card,
    // and the screen needs a box to draw it on.
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.txs.map((t) => t.hash))).toEqual([['a', 'b'], ['c']])
  })

  it('labels today and yesterday from nowMs', () => {
    const items = groupActivity([tx('a', '2026-07-18T09:00:00Z'), tx('b', '2026-07-17T09:00:00Z')], OPTS)
    expect(items.map((i) => i.label)).toEqual(['Today', 'Yesterday'])
  })

  it('gives each section a stable id, so a re-group does not remount every row', () => {
    const first = groupActivity([tx('a', '2026-07-18T09:00:00Z')], OPTS)
    const again = groupActivity([tx('a', '2026-07-18T09:00:00Z'), tx('b', '2026-07-18T08:00:00Z')], OPTS)
    expect(again[0]?.id).toBe(first[0]?.id)
  })

  it('pins timestamp-less txs into a leading Pending section', () => {
    const items = groupActivity([tx('p', undefined), tx('a', '2026-07-18T09:00:00Z')], OPTS)
    expect(items[0]).toMatchObject({kind: 'section', label: 'Pending'})
    expect(items[0]?.txs.map((t) => t.hash)).toEqual(['p'])
  })
})

describe('activityType', () => {
  const at = '2026-07-18T09:00:00Z'

  // A synced transaction is an indexer summary with no script detail, so
  // `contract-execution` (which needs the body's script-data hash) never appears
  // on one. A spent script UTxO is the evidence that survives.
  describe('script spends in the history path', () => {
    const withScriptInput = (hash: string): ReviewedTransaction =>
      ({
        ...tx(hash, at),
        // A real mainnet script address, verified to decode with
        // `paymentIsScript: true` (tx c45ecccae7a9…, spending addr1w9e7ft4…).
        inputs: [
          {
            credentials: {
              payment: {hashHex: '2e7c95d4636db51d9b0ca3861b7e3526211ee98b5d4023c9717df9ca', type: 'script'},
            },
          },
        ],
      }) as unknown as ReviewedTransaction

    it('labels a tx that spends a script UTxO as a contract call', () => {
      expect(
        activityType(withScriptInput('s1'), {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).toBe('smartContract')
    })

    it('does not call our own shared wallet a contract — a native script is not Plutus', () => {
      // A CIP-1854 shared wallet lives at a script address, so every send from one was
      // labelled "Smart Contract". Wrong twice: it is a native script rather than Plutus,
      // and it is the user's own wallet rather than a contract they interacted with.
      // Ownership is what separates it from a DEX, which spends someone *else's* script.
      const ownScriptInput = {
        credentials: {
          payment: {hashHex: '2e7c95d4636db51d9b0ca3861b7e3526211ee98b5d4023c9717df9ca', type: 'script'},
        },
        ownership: {level: 'own', owner: 'self'},
      }
      const own = {...tx('shared-1', at), inputs: [ownScriptInput]} as unknown as ReviewedTransaction
      expect(
        activityType(own, {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).not.toBe('smartContract')
    })

    it('still calls a foreign script spend a contract, which is what a DEX swap is', () => {
      const foreign = {
        ...tx('dex-1', at),
        inputs: [
          {
            credentials: {
              payment: {hashHex: '2e7c95d4636db51d9b0ca3861b7e3526211ee98b5d4023c9717df9ca', type: 'script'},
            },
            ownership: {level: 'none'},
          },
        ],
      } as unknown as ReviewedTransaction
      expect(
        activityType(foreign, {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).toBe('smartContract')
    })

    it('leaves an ordinary key-address spend alone', () => {
      const keyInput = {
        ...tx('s2', at),
        inputs: [{credentials: {payment: {hashHex: 'ab'.repeat(28), type: 'key'}}}],
      } as unknown as ReviewedTransaction
      expect(
        activityType(keyInput, {scriptCredentials: new Set<string>(), plbScriptHashHex: null, registryPolicyHex: null}),
      ).not.toBe('smartContract')
    })

    it('still prefers the NIGHT claim label — a claim IS a script spend too', () => {
      // Guards the ordering: both read the same signal, and `isNightClaim` is
      // checked first, so the specific label must survive the generic one.
      const claim = {
        ...tx('s3', at),
        inputs: [
          {
            credentials: {
              payment: {hashHex: '9015199b65dff1a5b9e281192c0157c23ccb579311232b94fe1c037c', type: 'script'},
            },
            amounts: [{assetId: NIGHT_ASSET_ID, quantity: 42n}],
          },
        ],
        outputs: [],
      } as unknown as ReviewedTransaction
      expect(
        activityType(claim, {scriptCredentials: new Set<string>(), plbScriptHashHex: null, registryPolicyHex: null}),
      ).toBe('nightClaim')
    })
  })

  it('promotes special operations over money-flow direction', () => {
    expect(
      activityType(tx('a', at, [{kind: 'contract-execution'}]), {
        scriptCredentials: new Set<string>(),
        plbScriptHashHex: null,
        registryPolicyHex: null,
      }),
    ).toBe('smartContract')
    expect(
      activityType(tx('b', at, [{kind: 'reward-withdrawal'}]), {
        scriptCredentials: new Set<string>(),
        plbScriptHashHex: null,
        registryPolicyHex: null,
      }),
    ).toBe('rewards')
    expect(
      activityType(tx('c', at, [{kind: 'stake-delegation'}]), {
        scriptCredentials: new Set<string>(),
        plbScriptHashHex: null,
        registryPolicyHex: null,
      }),
    ).toBe('staking')
    expect(
      activityType(tx('d', at, [{kind: 'voting-procedures'}]), {
        scriptCredentials: new Set<string>(),
        plbScriptHashHex: null,
        registryPolicyHex: null,
      }),
    ).toBe('governance')
    expect(
      activityType(tx('e', at, [{kind: 'minting'}]), {
        scriptCredentials: new Set<string>(),
        plbScriptHashHex: null,
        registryPolicyHex: null,
      }),
    ).toBe('mint')
  })

  describe('swept reward withdrawals', () => {
    // Wallets sweep pending rewards into ordinary transactions, so a withdrawal
    // rides along with sends, delegations and mints. Labelling those "Rewards"
    // hid what the transaction actually did — on a real staking wallet that was
    // a plurality of the history.
    it('does not label a send that swept rewards', () => {
      const sendWithSweep = tx('f', at, [{kind: 'reward-withdrawal'}], {otherGroup: receivingGroup})
      expect(
        activityType(sendWithSweep, {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).not.toBe('rewards')
    })

    it('lets the other operation win when a withdrawal rides along', () => {
      expect(
        activityType(tx('g', at, [{kind: 'reward-withdrawal'}, {kind: 'stake-delegation'}]), {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).toBe('staking')
      expect(
        activityType(tx('h', at, [{kind: 'reward-withdrawal'}, {kind: 'minting'}]), {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).toBe('mint')
      expect(
        activityType(tx('i', at, [{kind: 'reward-withdrawal'}, {kind: 'voting-procedures'}]), {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).toBe('governance')
    })

    it('still labels a withdrawal that is the whole story', () => {
      // Rewards landing in our own addresses only — nothing left the wallet.
      expect(
        activityType(tx('j', at, [{kind: 'reward-withdrawal'}]), {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).toBe('rewards')
    })

    it('treats value reaching our own identity as a transfer, not a withdrawal', () => {
      const toIdentity = tx('k', at, [{kind: 'reward-withdrawal'}], {identityGroup: receivingGroup})
      expect(
        activityType(toIdentity, {
          scriptCredentials: new Set<string>(),
          plbScriptHashHex: null,
          registryPolicyHex: null,
        }),
      ).not.toBe('rewards')
    })
  })
})

describe('primaryMovement', () => {
  it('picks the token over ADA change and counts the rest', () => {
    // NIGHT sent, ADA change returns → NIGHT is the headline, +1 more (the ADA).
    const m = primaryMovement(txDelta([{quantity: 1_500_000n}, {assetId: 'p.night', quantity: -1_463_756n}]))
    expect(m).toEqual({assetId: 'p.night', quantity: -1_463_756n, additionalCount: 1})
  })

  it('falls back to ADA when no token moved', () => {
    expect(primaryMovement(txDelta([{quantity: -46_445_854n}]))).toEqual({
      assetId: undefined,
      quantity: -46_445_854n,
      additionalCount: 0,
    })
  })

  it('largest-magnitude token wins among many', () => {
    const m = primaryMovement(
      txDelta([
        {assetId: 'a', quantity: -5n},
        {assetId: 'b', quantity: -317n},
        {assetId: 'c', quantity: 2n},
      ]),
    )
    expect(m.assetId).toBe('b')
    expect(m.additionalCount).toBe(2)
  })
})
