import {describe, expect, it} from 'vitest'
import {
  ADA_ID,
  addTarget,
  addTargetToken,
  allocationRemaining,
  applyBasketToSingleTarget,
  availableForTarget,
  basketAddToken,
  basketFullyAllocated,
  basketRemoveToken,
  basketSetAmount,
  basketToggleSendAll,
  CARDANO_RAIL,
  clearBasketSendAll,
  emptyBasket,
  initialSendState,
  isTargetResolved,
  MAX_TARGETS,
  maxTargetsFor,
  type ResolvedTarget,
  removeTarget,
  type SendState,
  setSendRail,
  setSoleTargetAmount,
  setTargetAddress,
  setTargetAmount,
  setTargetMidnightResolution,
  setTargetResolution,
  setTargetSendAll,
  validateMidnightSend,
  validateSend,
} from './state'

const TOKEN = `${'aa'.repeat(28)}.7401`
const ADDR_A = '00'.repeat(29)
const ADDR_B = '01'.repeat(29)

const resolve = (s: SendState, i: number, hex: string) => setTargetResolution(s, i, hex, null)

describe('send state — targets', () => {
  it('adds up to MAX_TARGETS and removes down to 1', () => {
    let s = initialSendState()
    for (let i = 0; i < 10; i++) s = addTarget(s)
    expect(s.targets).toHaveLength(MAX_TARGETS)
    for (let i = 0; i < 10; i++) s = removeTarget(s, 0)
    expect(s.targets).toHaveLength(1)
  })

  it('setting an address clears prior resolution', () => {
    let s = resolve(initialSendState(), 0, ADDR_A)
    expect(s.targets[0]?.resolvedAddressHex).toBe(ADDR_A)
    s = setTargetAddress(s, 0, 'addr1new')
    expect(s.targets[0]?.resolvedAddressHex).toBeNull()
  })
})

describe('availableForTarget — cross-target allocation', () => {
  it('subtracts other targets explicit commitments', () => {
    let s = addTarget(initialSendState())
    s = setTargetAmount(s, 0, ADA_ID, 3_000_000n)
    const balance = new Map([[ADA_ID, 10_000_000n]])
    expect(availableForTarget(ADA_ID, 1, balance, s.targets)).toBe(7_000_000n)
  })

  it('is zero when another target claims send-all', () => {
    let s = addTarget(initialSendState())
    s = setTargetSendAll(s, 0, ADA_ID, true)
    const balance = new Map([[ADA_ID, 10_000_000n]])
    expect(availableForTarget(ADA_ID, 1, balance, s.targets)).toBe(0n)
  })

  it('never goes negative when over-committed', () => {
    let s = addTarget(initialSendState())
    s = setTargetAmount(s, 0, ADA_ID, 20_000_000n)
    const balance = new Map([[ADA_ID, 10_000_000n]])
    expect(availableForTarget(ADA_ID, 1, balance, s.targets)).toBe(0n)
  })
})

describe('validateSend', () => {
  // A stand-in floor that, like the ledger's, grows with what the output holds:
  // enough to tell "too little ADA for these tokens" from "fine".
  const opts = {
    adaFeeReserve: 200_000n,
    minAdaFor: (t: ResolvedTarget) =>
      1_000_000n + BigInt([...t.amounts.keys()].filter((id) => id !== ADA_ID).length) * 200_000n,
  }

  it('rejects an unresolved recipient', () => {
    const s = setTargetAmount(initialSendState(), 0, ADA_ID, 2_000_000n)
    expect(validateSend(s, new Map([[ADA_ID, 5_000_000n]]), opts)).toMatchObject({
      ok: false,
      error: 'unresolvedAddress',
      targetIndex: 0,
    })
  })

  it('accepts a simple ADA send', () => {
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = setTargetAmount(s, 0, ADA_ID, 2_000_000n)
    const r = validateSend(s, new Map([[ADA_ID, 5_000_000n]]), opts)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.targets[0]?.amounts.get(ADA_ID)).toBe(2_000_000n)
  })

  it('flags aggregate over-spend across two recipients', () => {
    let s = addTarget(initialSendState())
    s = resolve(s, 0, ADDR_A)
    s = resolve(s, 1, ADDR_B)
    s = setTargetAmount(s, 0, ADA_ID, 4_000_000n)
    s = setTargetAmount(s, 1, ADA_ID, 4_000_000n)
    expect(validateSend(s, new Map([[ADA_ID, 6_000_000n]]), opts)).toMatchObject({
      ok: false,
      error: 'insufficientFunds',
    })
  })

  it('resolves ADA send-all minus the fee reserve', () => {
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = setTargetSendAll(s, 0, ADA_ID, true)
    const r = validateSend(s, new Map([[ADA_ID, 10_000_000n]]), opts)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.targets[0]?.amounts.get(ADA_ID)).toBe(10_000_000n - 200_000n)
  })

  it('splits MAX across two targets (second gets the remainder)', () => {
    let s = addTarget(initialSendState())
    s = resolve(s, 0, ADDR_A)
    s = resolve(s, 1, ADDR_B)
    s = setTargetAmount(s, 0, ADA_ID, 3_000_000n)
    s = setTargetSendAll(s, 1, ADA_ID, true)
    const r = validateSend(s, new Map([[ADA_ID, 10_000_000n]]), opts)
    expect(r.ok).toBe(true)
    // target 1 gets 10 − 3 = 7, minus the fee reserve
    if (r.ok) expect(r.targets[1]?.amounts.get(ADA_ID)).toBe(7_000_000n - 200_000n)
  })

  it('requires min-ADA on a token-bearing output', () => {
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = addTargetToken(s, 0, TOKEN)
    s = setTargetAmount(s, 0, TOKEN, 5n)
    s = setTargetAmount(s, 0, ADA_ID, 500_000n) // below the floor for one token
    const balance = new Map([
      [ADA_ID, 10_000_000n],
      [TOKEN, 10n],
    ])
    expect(validateSend(s, balance, opts)).toMatchObject({
      ok: false,
      error: 'belowMinAda',
      targetIndex: 0,
      requiredMinAda: 1_200_000n,
    })
  })

  it('completes a token-only output with the floor instead of refusing it', () => {
    // ⚠️ **The defect.** "Send all of this token" states no ADA, and the old rule returned
    // `belowMinAda` before the floor was even computed — so the message could not name a figure and
    // the user had to discover it and type it themselves. A Cardano output must carry ADA; the floor
    // is the answer to "how much", not a question to put back to them.
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = addTargetToken(s, 0, TOKEN)
    s = setTargetSendAll(s, 0, TOKEN, true)
    const balance = new Map([
      [ADA_ID, 10_000_000n],
      [TOKEN, 10n],
    ])
    const r = validateSend(s, balance, opts)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // One token → 1_000_000 + 200_000 by the fixture's floor.
    expect(r.targets[0]?.amounts.get(ADA_ID)).toBe(1_200_000n)
    // The whole token balance still goes, which is what was asked for.
    expect(r.targets[0]?.amounts.get(TOKEN)).toBe(10n)
  })

  it('reports insufficient funds when the floor cannot be covered', () => {
    // The user's own question: add it *if it is available*. When it is not, the honest answer is that
    // there is not enough ADA — never a silent output below the floor the chain would refuse.
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = addTargetToken(s, 0, TOKEN)
    s = setTargetSendAll(s, 0, TOKEN, true)
    const balance = new Map([
      [ADA_ID, 500_000n],
      [TOKEN, 10n],
    ])
    expect(validateSend(s, balance, opts)).toMatchObject({ok: false, error: 'insufficientFunds'})
  })

  it('still refuses a token-only output when the floor cannot be computed', () => {
    // `null` from `minAdaFor` means "unknown", never "no floor" — completing from it would invent one.
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = addTargetToken(s, 0, TOKEN)
    s = setTargetSendAll(s, 0, TOKEN, true)
    const balance = new Map([
      [ADA_ID, 10_000_000n],
      [TOKEN, 10n],
    ])
    expect(validateSend(s, balance, {...opts, minAdaFor: () => null})).toMatchObject({
      ok: false,
      error: 'belowMinAda',
    })
  })

  it('accepts a multi-asset output with sufficient min-ADA', () => {
    let s = resolve(initialSendState(), 0, ADDR_A)
    s = addTargetToken(s, 0, TOKEN)
    s = setTargetAmount(s, 0, TOKEN, 5n)
    s = setTargetAmount(s, 0, ADA_ID, 1_500_000n)
    const balance = new Map([
      [ADA_ID, 10_000_000n],
      [TOKEN, 10n],
    ])
    const r = validateSend(s, balance, opts)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.targets[0]?.amounts.get(TOKEN)).toBe(5n)
      expect(r.targets[0]?.amounts.get(ADA_ID)).toBe(1_500_000n)
    }
  })
})

describe('send state — basket', () => {
  it('starts with a non-removable ADA row', () => {
    let b = emptyBasket()
    expect([...b.amounts.keys()]).toEqual([ADA_ID])
    b = basketRemoveToken(b, ADA_ID)
    expect(b.amounts.has(ADA_ID)).toBe(true)
  })

  it('adds tokens once and removes them with their send-all flag', () => {
    let b = basketAddToken(emptyBasket(), TOKEN)
    b = basketAddToken(b, TOKEN)
    expect([...b.amounts.keys()]).toEqual([ADA_ID, TOKEN])
    b = basketToggleSendAll(b, TOKEN, true)
    b = basketRemoveToken(b, TOKEN)
    expect(b.amounts.has(TOKEN)).toBe(false)
    expect(b.sendAll.has(TOKEN)).toBe(false)
  })

  it('typing an amount clears send-all for that asset', () => {
    let b = basketToggleSendAll(emptyBasket(), ADA_ID, true)
    expect(b.sendAll.has(ADA_ID)).toBe(true)
    b = basketSetAmount(b, ADA_ID, 5n)
    expect(b.sendAll.has(ADA_ID)).toBe(false)
    expect(b.amounts.get(ADA_ID)).toBe(5n)
  })

  it('clearBasketSendAll drops every flag but keeps amounts', () => {
    let b = basketSetAmount(emptyBasket(), ADA_ID, 5n)
    b = basketAddToken(b, TOKEN)
    b = basketToggleSendAll(b, TOKEN, true)
    b = clearBasketSendAll(b)
    expect(b.sendAll.size).toBe(0)
    expect(b.amounts.get(ADA_ID)).toBe(5n)
  })

  it('applyBasketToSingleTarget mirrors amounts and send-all onto target 0', () => {
    const s = resolve(initialSendState(), 0, ADDR_A)
    let b = basketSetAmount(emptyBasket(), ADA_ID, 2_000_000n)
    b = basketToggleSendAll(b, TOKEN, true)
    const applied = applyBasketToSingleTarget(s, b)
    expect(applied.targets[0]?.amounts.get(ADA_ID)).toBe(2_000_000n)
    expect(applied.targets[0]?.sendAll.has(TOKEN)).toBe(true)
  })

  it('tracks allocation remaining and completeness across targets', () => {
    let s = addTarget(resolve(initialSendState(), 0, ADDR_A))
    s = resolve(s, 1, ADDR_B)
    const b = basketSetAmount(emptyBasket(), ADA_ID, 10n)
    expect(allocationRemaining(b, s.targets, ADA_ID)).toBe(10n)
    expect(basketFullyAllocated(b, s.targets)).toBe(false)
    s = setTargetAmount(s, 0, ADA_ID, 4n)
    expect(allocationRemaining(b, s.targets, ADA_ID)).toBe(6n)
    s = setTargetAmount(s, 1, ADA_ID, 6n)
    expect(allocationRemaining(b, s.targets, ADA_ID)).toBe(0n)
    expect(basketFullyAllocated(b, s.targets)).toBe(true)
    // Over-allocation reports the overshoot as a negative. Clamping it at zero made this
    // case render as the same green "0 left" as an exact split, while Review stayed
    // disabled with nothing on screen explaining why.
    s = setTargetAmount(s, 1, ADA_ID, 7n)
    expect(allocationRemaining(b, s.targets, ADA_ID)).toBe(-1n)
    expect(basketFullyAllocated(b, s.targets)).toBe(false)
  })
})

const MN_ADDR = 'mn_addr_preprod1g84s5k7cxzw5fvxq3hgx4tjnse8nnp8s5wctep275catzsunah8q9e3aqx'
const NIGHT = `midnight:${'00'.repeat(32)}`
const MIDNIGHT_RAIL = {chain: 'midnight', rail: 'unshielded'} as const

describe('send state — rail', () => {
  it('starts on Cardano, because an empty funnel has no address to decide from', () => {
    expect(initialSendState().rail).toEqual(CARDANO_RAIL)
    expect(maxTargetsFor(CARDANO_RAIL)).toBe(MAX_TARGETS)
  })

  it('pays exactly one recipient on Midnight, and will not add another', () => {
    let s = setSendRail(initialSendState(), MIDNIGHT_RAIL)
    expect(maxTargetsFor(MIDNIGHT_RAIL)).toBe(1)
    s = addTarget(s)
    expect(s.targets).toHaveLength(1)
  })

  it('drops extra recipients and every co-funding source when it switches to Midnight', () => {
    let s = initialSendState()
    s = addTarget(addTarget(s))
    s = {...s, sources: [{groupId: 'g', name: 'w', isComposer: true, lovelace: 5n, assets: new Map()}]}
    s = setSendRail(s, MIDNIGHT_RAIL)
    expect(s.targets).toHaveLength(1)
    expect(s.sources).toEqual([])
  })

  it("drops Cardano's empty ADA row, which means nothing on Midnight", () => {
    const s = setSendRail(initialSendState(), MIDNIGHT_RAIL)
    expect(s.targets[0]?.amounts.has(ADA_ID)).toBe(false)
  })

  it('restores the ADA row when it switches back', () => {
    const s = setSendRail(setSendRail(initialSendState(), MIDNIGHT_RAIL), CARDANO_RAIL)
    expect(s.targets[0]?.amounts.get(ADA_ID)).toBe(0n)
  })

  it('is a no-op on the rail already held, so it cannot wipe a half-typed send', () => {
    let s = setSendRail(initialSendState(), MIDNIGHT_RAIL)
    s = setTargetMidnightResolution(s, 0, MN_ADDR)
    expect(setSendRail(s, MIDNIGHT_RAIL)).toBe(s)
  })

  it('reads resolution from the field the rail actually populates', () => {
    const cardano = setTargetResolution(initialSendState(), 0, ADDR_A, null)
    expect(isTargetResolved(cardano.targets[0] as never, CARDANO_RAIL)).toBe(true)
    // The same target on Midnight is NOT resolved: an address hex is not a Midnight address.
    expect(isTargetResolved(cardano.targets[0] as never, MIDNIGHT_RAIL)).toBe(false)

    const midnight = setTargetMidnightResolution(setSendRail(initialSendState(), MIDNIGHT_RAIL), 0, MN_ADDR)
    expect(isTargetResolved(midnight.targets[0] as never, MIDNIGHT_RAIL)).toBe(true)
  })

  it('forgets a Midnight resolution the moment the address is edited', () => {
    let s = setSendRail(initialSendState(), MIDNIGHT_RAIL)
    s = setTargetMidnightResolution(s, 0, MN_ADDR)
    s = setTargetAddress(s, 0, 'mn_addr_preprod1typo')
    expect(s.targets[0]?.resolvedMidnightAddress).toBeNull()
  })
})

describe('validateMidnightSend', () => {
  const seed = () => {
    const s = setSendRail(initialSendState(), MIDNIGHT_RAIL)
    return setTargetMidnightResolution(s, 0, MN_ADDR)
  }

  it('accepts one recipient, one asset, one amount', () => {
    const s = setTargetAmount(seed(), 0, NIGHT, 1_000_000n)
    expect(validateMidnightSend(s, 5_000_000n)).toEqual({
      ok: true,
      address: MN_ADDR,
      assetId: NIGHT,
      amount: 1_000_000n,
    })
  })

  it('refuses an unresolved recipient', () => {
    const s = setTargetAmount(setSendRail(initialSendState(), MIDNIGHT_RAIL), 0, NIGHT, 1n)
    expect(validateMidnightSend(s, 5n)).toEqual({ok: false, error: 'unresolvedAddress'})
  })

  it('refuses an empty amount', () => {
    expect(validateMidnightSend(seed(), 5n)).toEqual({ok: false, error: 'noAssets'})
    expect(validateMidnightSend(setTargetAmount(seed(), 0, NIGHT, 0n), 5n)).toEqual({ok: false, error: 'noAssets'})
  })

  it('refuses more than one asset — a transfer carries one', () => {
    let s = setTargetAmount(seed(), 0, NIGHT, 1n)
    s = setTargetAmount(s, 0, `midnight:${'ff'.repeat(32)}`, 2n)
    expect(validateMidnightSend(s, 500n)).toEqual({ok: false, error: 'invalidAmount'})
  })

  it('refuses an overspend it can see', () => {
    const s = setTargetAmount(seed(), 0, NIGHT, 10n)
    expect(validateMidnightSend(s, 9n)).toEqual({ok: false, error: 'insufficientFunds'})
  })

  it('passes an unknown balance through rather than inventing a zero', () => {
    const s = setTargetAmount(seed(), 0, NIGHT, 10n)
    expect(validateMidnightSend(s, null)).toMatchObject({ok: true, amount: 10n})
  })
})

describe('setSoleTargetAmount', () => {
  it('replaces what the target pays rather than adding to it', () => {
    // ⚠️ The Midnight rail pays one token. Picking a second one after going back must not leave the
    // first behind — `validateMidnightSend` refuses two positive figures and names neither.
    const first = setSoleTargetAmount(initialSendState(), 0, 'midnight:shielded:aa', 5n)
    const second = setSoleTargetAmount(first, 0, 'midnight:shielded:bb', 7n)
    expect([...(second.targets[0]?.amounts ?? [])]).toEqual([['midnight:shielded:bb', 7n]])
  })

  it('leaves Cardano’s merging setter alone', () => {
    const basket = setTargetAmount(setTargetAmount(initialSendState(), 0, 'policy.name', 5n), 0, 'other.name', 7n)
    expect(basket.targets[0]?.amounts.size).toBe(3)
  })
})
