import {describe, expect, it} from 'vitest'
import {buildGroups, classifyCreds, isSpendable, ownDeltaValue} from './review-common.js'
import type {ReviewedIO, WalletContext} from './types.js'

const WALLET_PAYMENT = 'aa'.repeat(28)
const WALLET_PAYMENT_2 = 'a2'.repeat(28)
const WALLET_STAKE = 'bb'.repeat(28)
const ID_PAYMENT = 'cc'.repeat(28)
const ID_STAKE = 'dd'.repeat(28)
const FOREIGN_PAYMENT = 'ee'.repeat(28)
const FOREIGN_STAKE = 'ff'.repeat(28)
const SCRIPT = '99'.repeat(28)

const key = (hashHex: string) => ({hashHex, isScript: false})
const script = (hashHex: string) => ({hashHex, isScript: true})

const context: WalletContext = {
  paymentKeyHashes: new Set([WALLET_PAYMENT, WALLET_PAYMENT_2]),
  stakeKeyHashHex: WALLET_STAKE,
  identity: {paymentKeyHashes: new Set([ID_PAYMENT]), stakeKeyHashHex: ID_STAKE},
}

/** Context of an install that predates the persisted identity credentials. */
const contextWithoutIdentity: WalletContext = {
  paymentKeyHashes: new Set([WALLET_PAYMENT]),
  stakeKeyHashHex: WALLET_STAKE,
}

describe('classifyCreds', () => {
  it('claims an address whose payment key is the wallet’s', () => {
    expect(classifyCreds(context, key(WALLET_PAYMENT), key(WALLET_STAKE))).toEqual({level: 'own', owner: 'wallet'})
  })

  it('claims an address whose payment key is the identity’s', () => {
    expect(classifyCreds(context, key(ID_PAYMENT), key(ID_STAKE))).toEqual({level: 'own', owner: 'identity'})
  })

  it('does not claim the identity when the context has none', () => {
    expect(classifyCreds(contextWithoutIdentity, key(ID_PAYMENT), key(ID_STAKE))).toEqual({level: 'none'})
  })

  it('reads a script paying to our stake key as our escrow, per owner', () => {
    expect(classifyCreds(context, script(SCRIPT), key(WALLET_STAKE))).toEqual({level: 'escrow', owner: 'wallet'})
    expect(classifyCreds(context, script(SCRIPT), key(ID_STAKE))).toEqual({level: 'escrow', owner: 'identity'})
  })

  it('separates a foreign key carrying our stake key — the hijack shape', () => {
    // Same stake credential as the escrow case above, but a *key* payment
    // credential: someone else can spend it. These two collapsed into one
    // 'stake-only' level before, which is the bug this split fixes.
    expect(classifyCreds(context, key(FOREIGN_PAYMENT), key(WALLET_STAKE))).toEqual({
      level: 'stake-hijack',
      owner: 'wallet',
    })
    expect(classifyCreds(context, key(FOREIGN_PAYMENT), key(ID_STAKE))).toEqual({
      level: 'stake-hijack',
      owner: 'identity',
    })
  })

  it('treats a stranger as a stranger', () => {
    expect(classifyCreds(context, key(FOREIGN_PAYMENT), key(FOREIGN_STAKE))).toEqual({level: 'none'})
    expect(classifyCreds(context, script(SCRIPT), key(FOREIGN_STAKE))).toEqual({level: 'none'})
    expect(classifyCreds(context, undefined, undefined)).toEqual({level: 'none'})
  })

  it('never claims a script stake credential that merely hashes to ours', () => {
    // A *script* whose hash equals our stake key hash is not our key.
    expect(classifyCreds(context, script(SCRIPT), script(WALLET_STAKE))).toEqual({level: 'none'})
  })

  it('prefers the wallet when a credential somehow belongs to both', () => {
    const shared: WalletContext = {
      paymentKeyHashes: new Set([WALLET_PAYMENT]),
      stakeKeyHashHex: WALLET_STAKE,
      identity: {paymentKeyHashes: new Set([WALLET_PAYMENT]), stakeKeyHashHex: WALLET_STAKE},
    }
    expect(classifyCreds(shared, key(WALLET_PAYMENT), key(WALLET_STAKE))).toEqual({level: 'own', owner: 'wallet'})
  })
})

describe('isSpendable', () => {
  it('is true only when we hold the payment credential', () => {
    expect(isSpendable({level: 'own', owner: 'wallet'})).toBe(true)
    expect(isSpendable({level: 'own', owner: 'identity'})).toBe(true)
    expect(isSpendable({level: 'escrow', owner: 'wallet'})).toBe(false)
    expect(isSpendable({level: 'stake-hijack', owner: 'wallet'})).toBe(false)
    expect(isSpendable({level: 'none'})).toBe(false)
  })
})

const io = (hex: string, ownership: ReviewedIO['ownership'], quantity: bigint): ReviewedIO => ({
  address: {hex},
  ownership,
  amounts: [{quantity}],
})

describe('buildGroups', () => {
  it('aggregates the signing wallet into one party and keeps everyone else per-address', () => {
    const inputs = [io('01', {level: 'own', owner: 'wallet'}, 1_000_000n)]
    const outputs = [
      io('02', {level: 'own', owner: 'wallet'}, 300_000n),
      io('03', {level: 'none'}, 500_000n),
      io('04', {level: 'none'}, 100_000n),
    ]

    const {ownGroup, otherGroup} = buildGroups(inputs, outputs)

    expect(ownGroup.parties).toHaveLength(1)
    expect(ownGroup.parties[0]?.addresses.map((a) => a.hex)).toEqual(['01', '02'])
    expect(ownGroup.parties[0]?.sent).toEqual([{quantity: 700_000n}])
    expect(otherGroup.parties.map((p) => p.addresses[0]?.hex)).toEqual(['03', '04'])
  })

  it('partitions the identity, escrows and hijacks into their own tiers', () => {
    const inputs = [io('01', {level: 'own', owner: 'wallet'}, 1_000_000n)]
    const outputs = [
      io('02', {level: 'own', owner: 'identity'}, 400_000n),
      io('03', {level: 'escrow', owner: 'wallet'}, 300_000n),
      io('04', {level: 'stake-hijack', owner: 'wallet'}, 200_000n),
    ]

    const {ownGroup, identityGroup, escrowGroup, otherGroup} = buildGroups(inputs, outputs)

    // The wallet spent 1 ADA; none of the other three is its balance change.
    expect(ownGroup.parties[0]?.addresses.map((a) => a.hex)).toEqual(['01'])
    expect(ownGroup.parties[0]?.sent).toEqual([{quantity: 1_000_000n}])
    expect(identityGroup.parties[0]?.received).toEqual([{quantity: 400_000n}])
    expect(escrowGroup.parties[0]?.received).toEqual([{quantity: 300_000n}])
    // A hijacked address is a counterparty: we cannot spend it.
    expect(otherGroup.parties.map((p) => p.ownership.level)).toEqual(['stake-hijack'])
  })

  it('leaves every tier empty that nothing matched', () => {
    const {ownGroup, identityGroup, escrowGroup, otherGroup} = buildGroups(
      [io('01', {level: 'own', owner: 'wallet'}, 1_000_000n)],
      [io('02', {level: 'none'}, 900_000n)],
    )

    expect(ownGroup.parties).toHaveLength(1)
    expect(otherGroup.parties).toHaveLength(1)
    expect(identityGroup.parties).toEqual([])
    expect(escrowGroup.parties).toEqual([])
    expect(identityGroup.deltas).toEqual([])
    expect(escrowGroup.entries).toEqual([])
  })

  it('aggregates our own addresses per stake credential, not into one lump', () => {
    // Two accounts under one wallet: separate stake keys, separate positions.
    const stakeA = {stake: {hashHex: 'aa'.repeat(28), type: 'key' as const}}
    const stakeB = {stake: {hashHex: 'bb'.repeat(28), type: 'key' as const}}
    const inputs = [{...io('01', {level: 'own', owner: 'wallet'}, 1_000_000n), credentials: stakeA}]
    const outputs = [
      {...io('02', {level: 'own', owner: 'wallet'}, 400_000n), credentials: stakeA},
      {...io('03', {level: 'own', owner: 'wallet'}, 500_000n), credentials: stakeB},
    ]

    const {ownGroup} = buildGroups(inputs, outputs)

    expect(ownGroup.parties).toHaveLength(2)
    expect(ownGroup.parties[0]?.stakeCredHex).toBe('aa'.repeat(28))
    expect(ownGroup.parties[0]?.addresses.map((a) => a.hex)).toEqual(['01', '02'])
    expect(ownGroup.parties[0]?.sent).toEqual([{quantity: 600_000n}])
    expect(ownGroup.parties[1]?.stakeCredHex).toBe('bb'.repeat(28))
    expect(ownGroup.parties[1]?.received).toEqual([{quantity: 500_000n}])
  })

  it('falls back to a single own party when the producer has no credentials', () => {
    // The history path only has addresses — one party, as before.
    const {ownGroup} = buildGroups(
      [io('01', {level: 'own', owner: 'wallet'}, 1_000_000n)],
      [io('02', {level: 'own', owner: 'wallet'}, 400_000n)],
    )

    expect(ownGroup.parties).toHaveLength(1)
    expect(ownGroup.parties[0]?.stakeCredHex).toBeUndefined()
    expect(ownGroup.parties[0]?.addresses.map((a) => a.hex)).toEqual(['01', '02'])
  })

  it('keeps each escrow script its own party, tagged with its delegation target', () => {
    const stake = {stake: {hashHex: 'cc'.repeat(28), type: 'key' as const}}
    const {escrowGroup} = buildGroups(
      [],
      [
        {...io('e1', {level: 'escrow', owner: 'wallet'}, 100_000n), credentials: stake},
        {...io('e2', {level: 'escrow', owner: 'wallet'}, 200_000n), credentials: stake},
      ],
    )

    expect(escrowGroup.parties).toHaveLength(2)
    expect(escrowGroup.parties.map((p) => p.stakeCredHex)).toEqual(['cc'.repeat(28), 'cc'.repeat(28)])
  })
})

describe('ownDeltaValue', () => {
  it('counts only the signing wallet, so an identity receipt is not netted off', () => {
    const inputs = [io('01', {level: 'own', owner: 'wallet'}, 1_000_000n)]
    const outputs = [io('02', {level: 'own', owner: 'identity'}, 900_000n)]

    expect([...ownDeltaValue(inputs, outputs).values()]).toEqual([-1_000_000n])
  })
})

describe('classifyCreds with a shared payment script', () => {
  const OUR_STAKE = '22'.repeat(28)
  const PLB = '33'.repeat(28)
  const THEIR_STAKE = '44'.repeat(28)
  const ctx = {
    paymentKeyHashes: new Set(['11'.repeat(28)]),
    stakeKeyHashHex: OUR_STAKE,
    sharedPaymentScriptHashes: new Set([PLB]),
  }

  it('a shared script over OUR stake credential is ours', () => {
    // A CIP-113 smart wallet. Without this the review reads a transfer as pure gain, because the
    // input it spends looks like somebody else's.
    expect(classifyCreds(ctx, {hashHex: PLB, isScript: true}, {hashHex: OUR_STAKE, isScript: false})).toEqual({
      level: 'own',
      owner: 'wallet',
    })
  })

  it('the same script over SOMEONE ELSE’s stake credential is not', () => {
    // ⚠️ The reason this is separate from `paymentScriptHashes`, where membership alone is enough.
    // The programmable-logic script is shared by every holder, so claiming it outright would count
    // strangers' balances as this wallet's.
    expect(classifyCreds(ctx, {hashHex: PLB, isScript: true}, {hashHex: THEIR_STAKE, isScript: false})).toMatchObject({
      level: 'none',
    })
  })

  it('an unlisted script over our stake credential stays an escrow', () => {
    // A DEX order or a thawing redeem. Unchanged by this addition.
    expect(
      classifyCreds(ctx, {hashHex: '99'.repeat(28), isScript: true}, {hashHex: OUR_STAKE, isScript: false}),
    ).toMatchObject({level: 'escrow'})
  })
})
