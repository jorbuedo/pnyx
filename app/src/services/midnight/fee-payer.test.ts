import {describe, expect, it} from 'vitest'

import {type DustReadiness, decideFeePayer, type FeeMode} from './fee-payer'

const ready = (over: Partial<DustReadiness> = {}): DustReadiness => ({
  balance: 1_000_000n,
  staleness: 'current' as const,
  estimatedFee: 1_000n,
  // A state built by an event replay. Today's fast sync produces `0` here, so the spendable case has
  // to be stated explicitly — a factory defaulting to `null` would make every test below vacuous.
  blockTimeSecs: 1_755_000_000,
  ...over,
})

describe('sponsor mode', () => {
  it('always sponsors, whatever the DUST rail says', () => {
    // The default must not become conditional: today every send is sponsored and that has to keep
    // working even on a wallet with a perfectly good DUST state.
    for (const dust of [ready(), ready({balance: null}), ready({staleness: 'activity' as const})]) {
      expect(decideFeePayer('sponsor', dust)).toEqual({kind: 'pay', payer: {by: 'sponsor'}})
    }
  })
})

describe('self mode', () => {
  it('pays its own way, carrying the fee', () => {
    expect(decideFeePayer('self', ready())).toEqual({kind: 'pay', payer: {by: 'self', dust: 1_000n}})
  })

  it('refuses rather than falling back when DUST was never synced', () => {
    // ⚠️ Falling back would answer the request by a different party than the caller chose — the same
    // substitution the connector's `payFees: false` refusal exists to prevent.
    const decision = decideFeePayer('self', ready({balance: null}))
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') expect(decision.reason).toMatch(/has not synced/)
  })

  it('distinguishes "never looked" from "holds none"', () => {
    const never = decideFeePayer('self', ready({balance: null}))
    const empty = decideFeePayer('self', ready({balance: 0n}))
    expect(never.kind).toBe('refuse')
    expect(empty.kind).toBe('refuse')
    if (never.kind === 'refuse' && empty.kind === 'refuse') {
      expect(never.reason).not.toBe(empty.reason)
    }
  })

  it('refuses a stale state even when the balance looks sufficient', () => {
    // A stale state may not know an output it holds was already spent, and the ledger rejects the pair.
    const decision = decideFeePayer('self', ready({staleness: 'activity' as const}))
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') expect(decision.reason).toMatch(/moved since/)
  })

  // A self-funded fee is only knowable after the build, so requiring a price here made the mode
  // unreachable. It proceeds with `dust: null` — unknown, and reported as unknown rather than as zero.
  it('proceeds unpriced, carrying the unknown rather than a zero', () => {
    expect(decideFeePayer('self', ready({estimatedFee: null}))).toEqual({
      kind: 'pay',
      payer: {by: 'self', dust: null},
    })
  })

  it('still refuses when the wallet holds no DUST at all, priced or not', () => {
    const decision = decideFeePayer('self', ready({balance: 0n, estimatedFee: null}))
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') expect(decision.reason).toMatch(/no DUST/)
  })

  it('refuses when the balance is short, naming both figures', () => {
    const decision = decideFeePayer('self', ready({balance: 5n, estimatedFee: 9n}))
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      expect(decision.reason).toContain('5')
      expect(decision.reason).toContain('9')
    }
  })

  it('pays when the balance exactly covers the fee', () => {
    expect(decideFeePayer('self', ready({balance: 9n, estimatedFee: 9n})).kind).toBe('pay')
  })
})

describe('prefer-self mode', () => {
  it('pays its own way when it can', () => {
    expect(decideFeePayer('prefer-self', ready())).toEqual({kind: 'pay', payer: {by: 'self', dust: 1_000n}})
  })

  it('falls back to the sponsor rather than failing, and says why every time', () => {
    // The point of the mode: strictly better for privacy, and never worse for reliability.
    //
    // ⚠️ **The reason is not decoration.** It used to be computed and dropped, so the review changed
    // from "From your DUST" to "Paid for you" with nothing said and nothing logged — the app quietly
    // changed who pays a user's fee. Asserted for every branch, because each has its own answer and a
    // single spot-check would let the others go blank.
    for (const dust of [
      ready({balance: null}),
      ready({staleness: 'activity' as const}),
      ready({balance: 0n}),
      ready({balance: 1n}),
    ]) {
      const decision = decideFeePayer('prefer-self', dust)
      expect(decision.kind).toBe('pay')
      expect(decision.kind === 'pay' && decision.payer).toEqual({by: 'sponsor'})
      const why = decision.kind === 'pay' ? decision.substitutedBecause : undefined
      expect(typeof why).toBe('string')
      expect(why).not.toBe('')
    }
  })

  // Unpriced is the normal case for a send, so this is the mode's actual happy path rather than an
  // edge: it must attempt self-funding, and the build refuses later if the state turns out short.
  it('attempts self-funding when the fee is not priced yet, and substitutes nothing', () => {
    // Absent means nothing was substituted, which is a different fact from an empty reason.
    expect(decideFeePayer('prefer-self', ready({estimatedFee: null}))).toEqual({
      kind: 'pay',
      payer: {by: 'self', dust: null},
    })
  })

  it('never refuses', () => {
    const modes: FeeMode[] = ['prefer-self']
    for (const mode of modes) {
      for (const dust of [ready(), ready({balance: null}), ready({staleness: 'activity' as const})]) {
        expect(decideFeePayer(mode, dust).kind).toBe('pay')
      }
    }
  })
})

describe('the block time', () => {
  // The device case, 2026-08-23: `staleness: current`, watermarks equal, 8 UTxOs, 0.32 DUST — and the
  // send still refused, because the fast sync leaves the state belonging to no instant. The review said
  // "From your DUST" and the payer changed after the press. `docs/DUST_SPEND_PROOF.md`.
  it('refuses a state with no block time even when everything else is perfect', () => {
    for (const blockTimeSecs of [null, 0]) {
      const decision = decideFeePayer('self', ready({blockTimeSecs}))
      expect(decision.kind).toBe('refuse')
      if (decision.kind === 'refuse') expect(decision.reason).toContain('block time')
    }
  })

  it('substitutes the sponsor under prefer-self, saying it is the block time', () => {
    const decision = decideFeePayer('prefer-self', ready({blockTimeSecs: 0}))
    expect(decision.kind === 'pay' && decision.payer).toEqual({by: 'sponsor'})
    expect(decision.kind === 'pay' ? decision.substitutedBecause : '').toContain('block time')
  })

  // ⚠️ Ordering, asserted because it is the honest-message rule and nothing else would catch a swap:
  // a stale wallet with no block time must hear about the block time, not be sent to a refresh that
  // cannot restore self-funding.
  it('outranks the reasons a refresh would fix', () => {
    const decision = decideFeePayer('self', ready({blockTimeSecs: 0, staleness: 'activity' as const}))
    expect(decision.kind === 'refuse' && decision.reason).toContain('block time')
    expect(decision.kind === 'refuse' && decision.reason).not.toContain('moved since')
  })

  // The mode's happy path must stay reachable: a replayed state pays for itself unpriced, exactly as
  // before. Without this the check above could be "always refuse" and every other test would pass.
  it('lets a replayed state pay for itself', () => {
    expect(decideFeePayer('prefer-self', ready({estimatedFee: null}))).toEqual({
      kind: 'pay',
      payer: {by: 'self', dust: null},
    })
  })
})

describe('staleness is not age', () => {
  const held = {balance: 1_000n, estimatedFee: 10n, blockTimeSecs: 1_755_000_000}

  // The whole point of the change: a state synced hours ago is spendable if nothing has moved, and the
  // old fifteen-minute flag refused exactly that — pushing every send onto the sponsor after a quarter
  // of an hour with no way to get back.
  it('spends from a state the chain has not moved past, however old', () => {
    expect(decideFeePayer('prefer-self', {...held, staleness: 'current'})).toEqual({
      kind: 'pay',
      payer: {by: 'self', dust: 10n},
    })
  })

  it('refuses a state the chain has moved past, however recent — naming movement, not emptiness', () => {
    const decision = decideFeePayer('prefer-self', {...held, staleness: 'activity'})
    expect(decision.kind === 'pay' && decision.payer).toEqual({by: 'sponsor'})
    // The wallet holds 1,000 SPECK against a 10 SPECK fee, so a reason about funds would be false.
    expect(decision.kind === 'pay' ? decision.substitutedBecause : '').toContain('moved')
  })

  // "We cannot tell" is not "fine": a state with no watermark to compare cannot be shown to be safe,
  // and being wrong here costs a rejected spend rather than a slower one.
  it('refuses when it cannot be checked at all', () => {
    const decision = decideFeePayer('self', {...held, staleness: 'unknown'})
    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') expect(decision.reason).toMatch(/cannot be checked/)
  })
})
