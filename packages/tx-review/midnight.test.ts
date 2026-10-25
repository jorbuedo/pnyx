import {describe, expect, it} from 'vitest'

import {
  type MidnightFundingDraft,
  type MidnightTransferDraft,
  reviewMidnightFunding,
  reviewMidnightTransfer,
  viewMidnightActivity,
} from './midnight'

const NIGHT = '0'.repeat(64)
const OURS = 'mn_addr_preprod1ours'
const THEM = 'mn_addr_preprod1them'

const draft = (overrides: Partial<MidnightTransferDraft> = {}): MidnightTransferDraft => ({
  rail: 'unshielded',
  network: 'preprod',
  tokenType: NIGHT,
  recipient: THEM,
  recipientNetwork: 'preprod',
  amount: 1_000_000n,
  ourAddresses: [OURS],
  selected: 3_500_000n,
  inputCount: 2,
  balance: 10_000_000n,
  fee: {by: 'sponsor'},
  ttlSecs: 1_800_000_000,
  ...overrides,
})

describe('reviewMidnightTransfer', () => {
  it('derives the change from what was selected rather than trusting a caller', () => {
    const view = reviewMidnightTransfer(draft())
    expect(view.change).toBe(2_500_000n)
    expect(view.amount).toBe(1_000_000n)
    expect(view.inputCount).toBe(2)
  })

  it('reports an exact spend as no change, not as a missing figure', () => {
    const view = reviewMidnightTransfer(draft({amount: 3_500_000n, selected: 3_500_000n}))
    expect(view.change).toBe(0n)
  })

  it('never reports negative change when the selection cannot cover the amount', () => {
    // The builder refuses this outright; the review must not render a negative return in the moment
    // before it does.
    const view = reviewMidnightTransfer(draft({amount: 9_000_000n, selected: 3_500_000n}))
    expect(view.change).toBe(0n)
  })

  it('is clean for an ordinary payment', () => {
    expect(reviewMidnightTransfer(draft()).warnings).toEqual([])
  })

  it('warns when the recipient names another network', () => {
    // Well-formed and unspendable here: the danger is a send that looks fine and lands nowhere the
    // recipient is watching.
    const view = reviewMidnightTransfer(draft({recipient: 'mn_addr1them', recipientNetwork: 'mainnet'}))
    expect(view.warnings).toContain('recipient-on-another-network')
  })

  /**
   * Paying yourself is legitimate — moving between your own wallets, consolidating a rail — so it is
   * a note, not a hazard. A screen cannot render it in the warning colour if the model never calls it
   * one.
   */
  it('notes paying ourselves, and does not call it a warning', () => {
    const view = reviewMidnightTransfer(draft({recipient: OURS}))
    expect(view.notes).toContain('sending-to-self')
    expect(view.warnings).toEqual([])
  })

  it('warns when the amount takes the whole balance', () => {
    expect(reviewMidnightTransfer(draft({amount: 10_000_000n})).warnings).toContain('spends-entire-balance')
    expect(reviewMidnightTransfer(draft({amount: 9_999_999n})).warnings).not.toContain('spends-entire-balance')
  })

  /**
   * An unknown balance is not "all of it". The first caller of this filled the field with the amount
   * itself, so the warning fired on every send — including one spending a thousandth of the wallet.
   */
  it('stays silent about a whole-balance spend when the balance is unknown', () => {
    expect(reviewMidnightTransfer(draft({balance: null, amount: 1_000_000n})).warnings).not.toContain(
      'spends-entire-balance',
    )
    expect(reviewMidnightTransfer(draft({balance: null, amount: 10_000_000_000n})).warnings).not.toContain(
      'spends-entire-balance',
    )
  })

  it('carries the fee payer rather than deciding it', () => {
    expect(reviewMidnightTransfer(draft()).fee).toEqual({by: 'sponsor'})
    expect(reviewMidnightTransfer(draft({fee: {by: 'self', dust: 42n}})).fee).toEqual({by: 'self', dust: 42n})
  })

  it('flags proving for the shielded rail only', () => {
    expect(reviewMidnightTransfer(draft({rail: 'shielded'})).needsProving).toBe(true)
    expect(reviewMidnightTransfer(draft({rail: 'unshielded'})).needsProving).toBe(false)
  })

  it('does not treat normal operation as a warning', () => {
    // Sponsored fees and shielded proving are properties of the rail, carried as fields. A screen
    // that renders them as warnings teaches people to ignore warnings.
    const shielded = reviewMidnightTransfer(draft({rail: 'shielded'}))
    expect(shielded.warnings).toEqual([])
    expect(shielded.notes).toEqual([])
  })
})

describe('viewMidnightActivity', () => {
  const settled = {
    hash: 'abc123',
    timestamp: '2026-08-20T12:00:00.000Z',
    blockHeight: 2_185_099,
    direction: 'sent' as const,
    netByToken: new Map([[NIGHT, -1_000_000n]]),
    fee: 500n,
    counterparties: [THEM],
    ourSpentCount: 46,
    ourCreatedCount: 1,
  }

  it('carries the chain facts through', () => {
    const view = viewMidnightActivity({tx: settled, rail: 'unshielded', network: 'preprod'})
    expect(view.mode).toBe('detail')
    expect(view.hash).toBe('abc123')
    expect(view.blockHeight).toBe(2_185_099)
    expect(view.netByToken.get(NIGHT)).toBe(-1_000_000n)
    expect(view.counterparties).toEqual([THEM])
    expect(view.confirmed).toBe(true)
  })

  it('reads a missing block as unconfirmed rather than lost', () => {
    const {blockHeight: _dropped, timestamp: _also, ...pending} = settled
    const view = viewMidnightActivity({tx: pending, rail: 'unshielded', network: 'preprod'})
    expect(view.confirmed).toBe(false)
    expect(view.blockHeight).toBeUndefined()
    expect(view.timestamp).toBeUndefined()
  })

  /**
   * The screen used to say Midnight "reports what a transaction moved, not the outputs it selected".
   * It reports the holder's side of both, and 46 spent against 1 returned is a real preprod transfer
   * (block 2191987) — the recipient's output is the transaction's second one and is deliberately not
   * counted, because an address-scoped feed never sees it.
   */
  it('carries the holder-side output counts, which the detail screen once denied existed', () => {
    const view = viewMidnightActivity({tx: settled, rail: 'unshielded', network: 'preprod'})
    expect(view.ourSpentCount).toBe(46)
    expect(view.ourCreatedCount).toBe(1)
  })

  it('keeps an absent fee absent instead of calling it free', () => {
    const {fee: _dropped, ...noFee} = settled
    expect(viewMidnightActivity({tx: noFee, rail: 'unshielded', network: 'preprod'}).fee).toBeUndefined()
    expect(viewMidnightActivity({tx: settled, rail: 'unshielded', network: 'preprod'}).fee).toBe(500n)
  })
})

describe('reviewMidnightFunding', () => {
  const OTHER = '07'.repeat(32)
  const fundingDraft = (over: Partial<MidnightFundingDraft> = {}): MidnightFundingDraft => ({
    network: 'preprod',
    origin: 'https://dapp.example',
    legs: [{tokenType: NIGHT, segment: 1, owed: 1_000_000n, balance: 5_500_250_000n}],
    fee: {by: 'sponsor'},
    ...over,
  })

  it('totals what is owed per token', () => {
    const view = reviewMidnightFunding(fundingDraft())
    expect(view.totalByToken.get(NIGHT)).toBe(1_000_000n)
  })

  it('sums the same token across segments, because that is what leaves the wallet', () => {
    // Two rows of 3 do not read as 6 unless they are added, and 6 is the figure being approved.
    const view = reviewMidnightFunding(
      fundingDraft({
        legs: [
          {tokenType: NIGHT, segment: 1, owed: 3n, balance: 100n},
          {tokenType: NIGHT, segment: 2, owed: 3n, balance: 100n},
        ],
      }),
    )
    expect(view.totalByToken.get(NIGHT)).toBe(6n)
  })

  it('keeps tokens apart', () => {
    const view = reviewMidnightFunding(
      fundingDraft({
        legs: [
          {tokenType: NIGHT, segment: 1, owed: 10n, balance: 100n},
          {tokenType: OTHER, segment: 1, owed: 40n, balance: 100n},
        ],
      }),
    )
    expect([...view.totalByToken.entries()].sort()).toEqual([
      [NIGHT, 10n],
      [OTHER, 40n],
    ])
  })

  it('always says the contents are not described', () => {
    // A property of every such request, not of a suspicious one: nothing on this rail renders a dApp's
    // own intents, and funding one authorises them.
    expect(reviewMidnightFunding(fundingDraft()).warnings).toContain('contents-not-described')
  })

  it('warns when funding it would leave nothing of that token', () => {
    const view = reviewMidnightFunding(
      fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 100n, balance: 100n}]}),
    )
    expect(view.warnings).toContain('funds-entire-balance')
  })

  it('does not warn about a whole balance it cannot see', () => {
    // `null` is "not synced", not "empty" — the same rule the transfer draft states.
    const view = reviewMidnightFunding(
      fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 100n, balance: null}]}),
    )
    expect(view.warnings).not.toContain('funds-entire-balance')
  })

  it('does not warn on a partial spend', () => {
    const view = reviewMidnightFunding(fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 1n, balance: 100n}]}))
    expect(view.warnings).not.toContain('funds-entire-balance')
  })

  it('raises the whole-balance warning once, not once per leg', () => {
    const view = reviewMidnightFunding(
      fundingDraft({
        legs: [
          {tokenType: NIGHT, segment: 1, owed: 100n, balance: 100n},
          {tokenType: OTHER, segment: 1, owed: 50n, balance: 50n},
        ],
      }),
    )
    expect(view.warnings.filter((w) => w === 'funds-entire-balance')).toHaveLength(1)
  })

  it('says it cannot cover a token the wallet holds too little of', () => {
    // Better here than after biometrics: the model can already see this cannot work.
    const view = reviewMidnightFunding(
      fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 200n, balance: 100n}]}),
    )
    expect(view.warnings).toContain('cannot-cover')
  })

  it('does not also claim a whole-balance spend when it cannot cover it', () => {
    // There is nothing to spend everything of. Two warnings would describe two different situations.
    const view = reviewMidnightFunding(
      fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 200n, balance: 100n}]}),
    )
    expect(view.warnings).not.toContain('funds-entire-balance')
  })

  it('treats an exact match as a whole-balance spend, not as short', () => {
    const view = reviewMidnightFunding(
      fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 100n, balance: 100n}]}),
    )
    expect(view.warnings).toContain('funds-entire-balance')
    expect(view.warnings).not.toContain('cannot-cover')
  })

  it('does not claim it cannot cover a balance it cannot see', () => {
    const view = reviewMidnightFunding(
      fundingDraft({legs: [{tokenType: NIGHT, segment: 1, owed: 200n, balance: null}]}),
    )
    expect(view.warnings).not.toContain('cannot-cover')
  })

  it('reports both cases when one token is short and another is exactly spent', () => {
    const view = reviewMidnightFunding(
      fundingDraft({
        legs: [
          {tokenType: NIGHT, segment: 1, owed: 100n, balance: 100n},
          {tokenType: OTHER, segment: 1, owed: 200n, balance: 50n},
        ],
      }),
    )
    expect(view.warnings).toEqual(['contents-not-described', 'funds-entire-balance', 'cannot-cover'])
  })

  it('carries the origin through unchanged, for the screen to render as unverified', () => {
    expect(reviewMidnightFunding(fundingDraft({origin: 'https://evil.example'})).origin).toBe('https://evil.example')
  })

  it('reports no legs as nothing owed rather than failing', () => {
    // A transaction that is already balanced: the native side returns it untouched, and this describes
    // that honestly instead of inventing a figure.
    const view = reviewMidnightFunding(fundingDraft({legs: []}))
    expect(view.totalByToken.size).toBe(0)
    expect(view.warnings).toEqual(['contents-not-described'])
  })
})
