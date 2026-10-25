import {describe, expect, it} from 'vitest'
import {ADA_KEY, type BalanceTimeline} from './balance-timeline'
import {pastTokens} from './past-tokens'

const NIGHT = 'policy1.4e494748'
const GENS = 'policy2.47454e53'
const OLD = 'policy3.4f4c44'

const keysOf = (rows: readonly {assetKey: string}[]) => rows.map((r) => r.assetKey)

describe('pastTokens', () => {
  const timeline: BalanceTimeline = new Map([
    [ADA_KEY, [{ts: 100, balance: 1_000n}]],
    [
      NIGHT,
      [
        {ts: 100, balance: 500n},
        {ts: 200, balance: 0n},
      ],
    ],
    [GENS, [{ts: 200, balance: 900n}]],
    [
      OLD,
      [
        {ts: 10, balance: 5n},
        {ts: 20, balance: 0n},
      ],
    ],
  ])

  it('lists what was held then and is not held now', () => {
    expect(keysOf(pastTokens(timeline, new Set([GENS])))).toEqual([NIGHT, OLD])
  })

  it('excludes what is still held', () => {
    expect(keysOf(pastTokens(timeline, new Set([GENS, NIGHT])))).toEqual([OLD])
  })

  // The wallet's own unit is not a position you exit — a zero ADA balance is an empty wallet.
  it('never lists ADA', () => {
    expect(keysOf(pastTokens(new Map([[ADA_KEY, [{ts: 1, balance: 0n}]]]), new Set()))).toEqual([])
  })

  it('reports the last instant a positive balance was held', () => {
    const rows = pastTokens(timeline, new Set([GENS]))
    expect(rows.find((r) => r.assetKey === NIGHT)?.lastHeldSec).toBe(100)
  })

  it('orders most recently held first', () => {
    expect(keysOf(pastTokens(timeline, new Set([GENS])))).toEqual([NIGHT, OLD])
  })

  // A token that only ever passed through — credited and debited to a net zero without the running
  // balance ever going positive — was never a holding.
  it('ignores an asset that was never held with a positive balance', () => {
    const passthrough: BalanceTimeline = new Map([
      [
        NIGHT,
        [
          {ts: 10, balance: 0n},
          {ts: 20, balance: 0n},
        ],
      ],
    ])
    expect(pastTokens(passthrough, new Set())).toEqual([])
  })

  // Partial local history can leave the running balance negative; that is not a past holding either.
  it('ignores an asset whose history only ever goes negative', () => {
    expect(pastTokens(new Map([[NIGHT, [{ts: 10, balance: -5n}]]]), new Set())).toEqual([])
  })

  // The defect this rule exists for, seen 2026-09-01: all of a token sent to the wallet's own
  // address. Every input carrying it is locked while the tx confirms, and the output that carries it
  // back is a *payment*, not change — so the rail's spendable view drops it for minutes. The tx
  // timeline nets a self-send to zero, so its running balance never dips, and that disagreement is
  // what tells us this is a confirmation window rather than an exit.
  it('does not call a token past while the wallet’s own timeline still shows a balance', () => {
    const selfSend: BalanceTimeline = new Map([
      [
        NIGHT,
        [
          {ts: 100, balance: 500n},
          // A send to self: outputs − inputs nets to zero, so the running balance is unchanged.
          {ts: 200, balance: 500n},
        ],
      ],
    ])
    expect(pastTokens(selfSend, new Set())).toEqual([])
  })

  // The veto is one-directional: `heldNow` stays the primary test, so a tip that is not positive
  // decides nothing on its own and a genuine exit is still reported.
  it('still lists a token whose timeline ends at zero', () => {
    const exited: BalanceTimeline = new Map([
      [
        NIGHT,
        [
          {ts: 100, balance: 500n},
          {ts: 200, balance: 0n},
        ],
      ],
    ])
    expect(keysOf(pastTokens(exited, new Set()))).toEqual([NIGHT])
  })

  // A partial history truncates the *old* end, so a missing early receive can only push the tip too
  // low — never too high. A positive tip is therefore trustworthy even when the history is not.
  it('vetoes on the tip even when an earlier step is missing', () => {
    const partial: BalanceTimeline = new Map([[NIGHT, [{ts: 300, balance: 25n}]]])
    expect(pastTokens(partial, new Set())).toEqual([])
  })

  it('is empty for a wallet that never held a token', () => {
    expect(pastTokens(new Map([[ADA_KEY, [{ts: 1, balance: 10n}]]]), new Set())).toEqual([])
  })

  // Re-entering a position and exiting again reports the *latest* exit, not the first.
  it('uses the most recent positive step when a position was re-entered', () => {
    const reentered: BalanceTimeline = new Map([
      [
        NIGHT,
        [
          {ts: 10, balance: 5n},
          {ts: 20, balance: 0n},
          {ts: 30, balance: 7n},
          {ts: 40, balance: 0n},
        ],
      ],
    ])
    expect(pastTokens(reentered, new Set())[0]?.lastHeldSec).toBe(30)
  })
})
