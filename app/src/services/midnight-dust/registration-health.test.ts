import {describe, expect, it} from 'vitest'
import {
  type AssessRegistrationInput,
  assessRegistration,
  type CnightUtxo,
  generatesDust,
  type RegistrationUtxo,
} from './registration-health'

const STAKE = '3a57af7913f0578ceddb35cd72e9abc3644189afb6607ce6d22d076e'
const DUST = 'aa'.repeat(33)
const OTHER_DUST = 'bb'.repeat(33)
const LAG = 100

const reg = (txHash: string, slot: number, dustAddr: string = DUST): RegistrationUtxo => ({
  owner: STAKE,
  dustAddr,
  txSlot: slot,
  ref: {txHash, index: 0},
})

/**
 * A registration whose destination could not be read. A separate helper because an
 * explicit `undefined` argument triggers a default parameter instead of overriding it —
 * which silently turned this case into the ordinary one.
 */
const regUnverified = (txHash: string, slot: number): RegistrationUtxo => ({
  owner: STAKE,
  dustAddr: undefined,
  txSlot: slot,
  ref: {txHash, index: 0},
})

const cnight = (slot: number): CnightUtxo => ({ref: {txHash: `c${slot}`, index: 0}, receiptSlot: slot, value: 1n})

/** cNIGHT sitting in the change of the transaction `txHash`, at that transaction's slot. */
const cnightFrom = (txHash: string, slot: number): CnightUtxo => ({
  ref: {txHash, index: 1},
  receiptSlot: slot,
  value: 1n,
})

const assess = (patch: Partial<AssessRegistrationInput>) =>
  assessRegistration({
    regs: [],
    cnight: [],
    observedDust: null,
    lagWindow: LAG,
    ...patch,
  })

describe('assessRegistration', () => {
  it('every outcome names something to tell the user', () => {
    // The failure this module exists to prevent is a silent zero. No branch may return
    // without a surface key.
    const cases: Partial<AssessRegistrationInput>[] = [
      {},
      {regs: [reg('a', 10), reg('b', 20)]},
      {regs: [regUnverified('a', 10)]},
      {regs: [reg('a', 10, OTHER_DUST)]},
      {regs: [reg('a', 10), reg('b', 20), reg('c', 30)]},
      {regs: [reg('a', 10)], observedDust: {accruing: true, cursorSlot: 500}},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500, eligibleNight: 5n}},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500, eligibleNight: 0n}},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500, eligibleNight: 0n}, cnight: [cnight(1)]},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 50}},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500}},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500}, cnight: [cnight(1)]},
      {regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500}, cnight: [cnight(50)]},
    ]

    for (const patch of cases) {
      expect(assess(patch).surfaceKey).not.toBe('')
    }
  })

  it('no registrations → register', () => {
    const out = assess({})
    expect(out.state).toBe('Unregistered')
    expect(out.action).toEqual({kind: 'register'})
  })

  it('several registrations → repair, keeping the newest', () => {
    // Observability treats a multiply-registered account as unregistered, so this state
    // blocks DUST entirely and must be reported as a problem, not as "registered".
    // Keeps the newest, whatever it points at: preferring one aimed at this wallet would
    // quietly overrule a deliberate delegation.
    const out = assess({regs: [reg('old', 10), reg('newest', 300, OTHER_DUST), reg('middle', 20)]})

    expect(out.state).toBe('MultiRegistered')
    expect(out.action).toEqual({
      kind: 'repairMultiRegistration',
      keep: {txHash: 'newest', index: 0},
      remove: [
        {txHash: 'old', index: 0},
        {txHash: 'middle', index: 0},
      ],
    })
  })

  it('a destination this wallet does not own is not a fault', () => {
    // Designating a recipient you do not control is the documented delegation and
    // fee-sponsorship hook. Flagging it would nag every delegating user to "fix" a
    // registration that is exactly what they asked for.
    const out = assess({regs: [reg('a', 10, OTHER_DUST)], observedDust: {accruing: true, cursorSlot: 1}})

    expect(out.state).toBe('HealthyActive')
    expect(out.action).toEqual({kind: 'none'})
  })

  it('never proposes changing the destination or deregistering on its own', () => {
    // Both are deliberate user choices, so they must never arrive as a recommendation.
    const kinds = [
      assess({regs: [reg('a', 10, OTHER_DUST)]}).action.kind,
      assess({regs: [regUnverified('a', 10)]}).action.kind,
      assess({regs: [reg('a', 10)], observedDust: {accruing: true, cursorSlot: 1}}).action.kind,
    ]
    expect(kinds).toEqual(['none', 'none', 'none'])
  })

  it('accruing DUST → healthy', () => {
    const out = assess({regs: [reg('a', 10)], observedDust: {accruing: true, cursorSlot: 500}})
    expect(out.state).toBe('HealthyActive')
    expect(out.surfaceKey).toBe('generating')
  })

  describe('with the indexer reporting eligible NIGHT', () => {
    it('eligible NIGHT present → starting, no lag guessing', () => {
      // Authoritative, so the cursor is not consulted even though it is far past the window.
      const out = assess({regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 9999, eligibleNight: 5n}})
      expect(out.state).toBe('HealthyActive')
      expect(out.surfaceKey).toBe('starting')
    })

    it('no eligible NIGHT and no cNIGHT → nothing to generate from', () => {
      const out = assess({regs: [reg('a', 10)], observedDust: {accruing: false, cursorSlot: 500, eligibleNight: 0n}})
      expect(out.state).toBe('NoGeneration')
      expect(out.noGenCause).toBe('zeroBalance')
      expect(out.action).toEqual({kind: 'none'})
    })

    it('no eligible NIGHT but cNIGHT held → self-send to activate it', () => {
      // Only cNIGHT received after registration counts, so a user waiting forever is
      // seeing correct protocol behaviour and has to be told what to do about it.
      const out = assess({
        regs: [reg('a', 10)],
        observedDust: {accruing: false, cursorSlot: 500, eligibleNight: 0n},
        cnight: [cnight(1), cnight(2)],
      })

      expect(out.state).toBe('NoGeneration')
      expect(out.noGenCause).toBe('predatesRegistration')
      expect(out.action).toEqual({
        kind: 'activateExistingCnight',
        utxos: [
          {txHash: 'c1', index: 0},
          {txHash: 'c2', index: 0},
        ],
      })
    })
  })

  describe('what Cardano alone already settles', () => {
    // These need no Midnight data, so they must not sit behind the observability gate.
    // While they did, and with no observability reader wired, every registered wallet read
    // as "starting" and the activation surface could never appear.
    it('no cNIGHT at all → nothing to generate from, with or without observability', () => {
      for (const observedDust of [null, {accruing: false, cursorSlot: 50}]) {
        const out = assess({regs: [reg('a', 10)], observedDust})
        expect(out.state).toBe('NoGeneration')
        expect(out.noGenCause).toBe('zeroBalance')
        expect(out.action).toEqual({kind: 'none'})
      }
    })

    it('all cNIGHT predates the registration → self-send, even with no observability', () => {
      const out = assess({regs: [reg('a', 100)], observedDust: null, cnight: [cnight(10)]})
      expect(out.noGenCause).toBe('predatesRegistration')
      expect(out.action.kind).toBe('activateExistingCnight')
    })
  })

  describe('falling back to the lag window', () => {
    it('inside the window → catching up, no action', () => {
      const out = assess({
        regs: [reg('a', 10)],
        observedDust: {accruing: false, cursorSlot: 50},
        cnight: [cnight(20)],
      })
      expect(out.state).toBe('HealthyActive')
      expect(out.surfaceKey).toBe('starting')
    })

    it('observability unavailable but eligible cNIGHT held → catching up, never broken', () => {
      const out = assess({regs: [reg('a', 10)], observedDust: null, cnight: [cnight(20)]})
      expect(out.state).toBe('HealthyActive')
      expect(out.action).toEqual({kind: 'none'})
    })

    it('past the window with eligible cNIGHT → blame the network, not the wallet', () => {
      // Nothing wallet-side to fix, so recommending an action would charge a fee for nothing.
      const out = assess({
        regs: [reg('a', 100)],
        observedDust: {accruing: false, cursorSlot: 500},
        cnight: [cnight(150)],
      })

      expect(out.noGenCause).toBe('observabilityLag')
      expect(out.action).toEqual({kind: 'none'})
    })
  })
})

describe('an undated cNIGHT UTxO', () => {
  // Caught for real on 2026-07-28: the reader dated an out-of-window UTxO `0`, the assessment
  // read that as "predates registration", and a wallet the Midnight indexer reports as
  // generating was told to pay a fee to move NIGHT that was already working.
  const undated: CnightUtxo = {ref: {txHash: 'cx', index: 0}, receiptSlot: null, value: 1n}

  it('does not generate, but also does not prove that nothing generates', () => {
    expect(generatesDust(undated, reg('a', 100))).toBe(false)

    const out = assess({regs: [reg('a', 100)], observedDust: null, cnight: [undated]})
    expect(out.noGenCause).not.toBe('predatesRegistration')
    expect(out.action).toEqual({kind: 'none'})
  })

  it('blocks the diagnosis even when every dated sibling predates the registration', () => {
    const out = assess({regs: [reg('a', 100)], observedDust: null, cnight: [cnight(10), undated]})
    expect(out.action.kind).not.toBe('activateExistingCnight')
  })
})

describe('generatesDust', () => {
  it("excludes the registration's own change", () => {
    // The registration's coin selection can pull NIGHT in, and that NIGHT comes back as
    // change at the registration's own slot. It is an output of the registration, not a
    // receipt after it, so it still has to move again in a posterior transaction.
    expect(generatesDust(cnightFrom('a', 10), reg('a', 10))).toBe(false)
  })

  it('includes a chained self-send that lands in the same slot', () => {
    // A leg chained onto the registration spends its change, so it is posterior — even
    // though both can be accepted into one block and share a slot.
    expect(generatesDust(cnightFrom('b', 10), reg('a', 10))).toBe(true)
  })

  it('excludes NIGHT received before the registration', () => {
    expect(generatesDust(cnightFrom('b', 9), reg('a', 10))).toBe(false)
  })
})

describe("assessRegistration and the registration's own change", () => {
  it('still recommends activation when the only cNIGHT is the registration change', () => {
    const out = assess({
      regs: [reg('a', 10)],
      observedDust: {accruing: false, cursorSlot: 500},
      cnight: [cnightFrom('a', 10)],
    })
    expect(out.state).toBe('NoGeneration')
    expect(out.noGenCause).toBe('predatesRegistration')
  })
})
