import type {Plan} from '@evolution-sdk/plan'
import {describe, expect, it} from 'vitest'
import {
  type HistoryWalletContext,
  historyDirection,
  type IndexedCardanoTx,
  reviewCardanoFromHistory,
} from './history.js'

const PARAMS: Plan.ProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
}

const OWN = 'addr_test1own'
const OTHER = 'addr_test1other'
const REWARD = 'stake_test1own'

const context: HistoryWalletContext = {
  ownAddressesBech32: new Set([OWN]),
  rewardAddressBech32: REWARD,
}

const WALLET_PAYMENT = 'aa'.repeat(28)
const WALLET_STAKE = 'bb'.repeat(28)
const ESCROW_SCRIPT = '99'.repeat(28)
const FOREIGN_PAYMENT = 'ee'.repeat(28)
const ESCROW_ADDR = 'addr_test1escrow'
const HIJACK_ADDR = 'addr_test1hijack'

/**
 * The history path only has bech32 addresses, so the app injects a credential
 * inspector; without it every non-own address is just "other". This fake stands
 * in for the app's codec-backed one.
 */
const contextWithCredentials: HistoryWalletContext = {
  ownAddressesBech32: new Set([OWN]),
  rewardAddressBech32: REWARD,
  wallet: {paymentKeyHashes: new Set([WALLET_PAYMENT]), stakeKeyHashHex: WALLET_STAKE},
  credentialsOf: (address) => {
    if (address === ESCROW_ADDR) {
      return {payment: {hashHex: ESCROW_SCRIPT, type: 'script'}, stake: {hashHex: WALLET_STAKE, type: 'key'}}
    }
    if (address === HIJACK_ADDR) {
      return {payment: {hashHex: FOREIGN_PAYMENT, type: 'key'}, stake: {hashHex: WALLET_STAKE, type: 'key'}}
    }
    return undefined
  },
}

describe('reviewCardanoFromHistory — credential tiers', () => {
  const spend = (to: string): IndexedCardanoTx => ({
    hash: 'cc'.repeat(32),
    time: '2026-07-20T00:00:00Z',
    fee: 200_000n,
    inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: []}],
    outputs: [{addressBech32: to, coin: 9_800_000n, tokens: []}],
  })

  it('finds our escrow in indexed history, not just on the signing path', () => {
    const r = reviewCardanoFromHistory(spend(ESCROW_ADDR), contextWithCredentials, PARAMS)

    expect(r.escrowGroup.parties).toHaveLength(1)
    expect(r.escrowGroup.parties[0]?.ownership).toEqual({level: 'escrow', owner: 'wallet'})
    expect(r.otherGroup.parties).toEqual([])
  })

  it('warns about a foreign address reusing our stake key', () => {
    const r = reviewCardanoFromHistory(spend(HIJACK_ADDR), contextWithCredentials, PARAMS)

    expect(r.otherGroup.parties[0]?.ownership).toEqual({level: 'stake-hijack', owner: 'wallet'})
    expect(r.warnings).toContain('stake-credential-reuse')
  })

  it('carries the credentials through for the address inspector', () => {
    const r = reviewCardanoFromHistory(spend(ESCROW_ADDR), contextWithCredentials, PARAMS)

    expect(r.outputs[0]?.credentials).toEqual({
      payment: {hashHex: ESCROW_SCRIPT, type: 'script'},
      stake: {hashHex: WALLET_STAKE, type: 'key'},
    })
  })

  it('degrades to own/other without an inspector, as before', () => {
    const r = reviewCardanoFromHistory(spend(ESCROW_ADDR), context, PARAMS)

    expect(r.escrowGroup.parties).toEqual([])
    expect(r.otherGroup.parties[0]?.ownership).toEqual({level: 'none'})
    expect(r.outputs[0]?.credentials).toBeUndefined()
  })
})

describe('reviewCardanoFromHistory', () => {
  it('classifies a sent tx (own input, foreign output + own change) with negative delta', () => {
    const tx: IndexedCardanoTx = {
      hash: 'aa'.repeat(32),
      time: '2026-07-13T00:00:00Z',
      fee: 170_000n,
      inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: []}],
      outputs: [
        {addressBech32: OTHER, coin: 6_000_000n, tokens: []},
        {addressBech32: OWN, coin: 3_830_000n, tokens: []},
      ],
    }
    const r = reviewCardanoFromHistory(tx, context, PARAMS)
    expect(r.hash).toBe('aa'.repeat(32))
    expect(r.timestamp).toBe('2026-07-13T00:00:00Z')
    // own delta: +3.83 change − 10 input = −6.17 ADA (fee implicit)
    expect(r.ownDelta).toEqual([{quantity: -6_170_000n}])
    expect(r.counterparties).toEqual([{address: {hex: OTHER, bech32: OTHER}, received: [{quantity: 6_000_000n}]}])
    expect(historyDirection(r)).toBe('sent')
  })

  it('leaves status absent when the source did not report the phase-2 verdict', () => {
    // Koios `/tx_info` carries no such flag. Claiming `confirmed` here would make
    // a script-failed transaction — on-chain, collateral consumed — read as a
    // success, and there would be no way to tell the two apart.
    const tx: IndexedCardanoTx = {hash: 'aa'.repeat(32), fee: 170_000n, inputs: [], outputs: []}
    expect(reviewCardanoFromHistory(tx, context, PARAMS).status).toBeUndefined()
  })

  it('reports the verdict both ways when the source does report it', () => {
    const base = {hash: 'aa'.repeat(32), fee: 170_000n, inputs: [], outputs: []}
    expect(reviewCardanoFromHistory({...base, valid: true}, context, PARAMS).status).toBe('confirmed')
    expect(reviewCardanoFromHistory({...base, valid: false}, context, PARAMS).status).toBe('failed')
  })

  it('carries the block context, and reports nothing rather than zeroes without it', () => {
    const base = {hash: 'aa'.repeat(32), fee: 170_000n, inputs: [], outputs: []}
    expect(
      reviewCardanoFromHistory(
        {...base, slot: 152_741_887, blockHeight: 11_984_231, epochNo: 553, blockHashHex: 'ef'.repeat(32)},
        context,
        PARAMS,
      ).block,
    ).toEqual({slot: 152_741_887, height: 11_984_231, epoch: 553, hashHex: 'ef'.repeat(32)})
    // No block facts at all ⇒ no `block` object, so a consumer cannot mistake an
    // unreported height for height zero.
    expect(reviewCardanoFromHistory(base, context, PARAMS).block).toBeUndefined()
    // A partially-reporting indexer carries only what it reported.
    expect(reviewCardanoFromHistory({...base, blockHeight: 11_984_231}, context, PARAMS).block).toEqual({
      height: 11_984_231,
    })
  })

  it('has no CBOR — an indexed summary never saw the bytes', () => {
    // The Details tab keys its copy row off this. Absent must stay absent here,
    // or the row would offer bytes we never held.
    const tx: IndexedCardanoTx = {hash: 'aa'.repeat(32), fee: 170_000n, inputs: [], outputs: []}
    expect(reviewCardanoFromHistory(tx, context, PARAMS).cbor).toBeUndefined()
  })

  it('carries each IO outpoint through, and preserves its absence', () => {
    const inputHash = 'dd'.repeat(32)
    const hash = 'aa'.repeat(32)
    const tx: IndexedCardanoTx = {
      hash,
      fee: 170_000n,
      inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: [], outpoint: {txHashHex: inputHash, index: 2}}],
      outputs: [
        {addressBech32: OTHER, coin: 6_000_000n, tokens: [], outpoint: {txHashHex: hash, index: 0}},
        {addressBech32: OWN, coin: 3_830_000n, tokens: []},
      ],
    }
    const r = reviewCardanoFromHistory(tx, context, PARAMS)
    expect(r.inputs[0]?.outpoint).toEqual({txHashHex: inputHash, index: 2})
    expect(r.outputs[0]?.outpoint).toEqual({txHashHex: hash, index: 0})
    expect(r.outputs[1]?.outpoint).toBeUndefined()
  })

  it('classifies a received tx (foreign input, own output) with positive delta', () => {
    const tx: IndexedCardanoTx = {
      hash: 'bb'.repeat(32),
      fee: 170_000n,
      inputs: [{addressBech32: OTHER, coin: 5_000_000n, tokens: []}],
      outputs: [{addressBech32: OWN, coin: 4_830_000n, tokens: []}],
    }
    const r = reviewCardanoFromHistory(tx, context, PARAMS)
    expect(r.ownDelta).toEqual([{quantity: 4_830_000n}])
    expect(historyDirection(r)).toBe('received')
  })

  it('extracts a stake-delegation certificate + reward withdrawal', () => {
    const tx: IndexedCardanoTx = {
      hash: 'cc'.repeat(32),
      fee: 180_000n,
      inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: []}],
      outputs: [{addressBech32: OWN, coin: 12_320_000n, tokens: []}],
      certificates: [{kind: 'stake-delegation', credentialHashHex: 'ab'.repeat(28), poolKeyHashHex: 'cd'.repeat(28)}],
      withdrawals: [{rewardAddressBech32: REWARD, amount: 2_500_000n}],
    }
    const r = reviewCardanoFromHistory(tx, context, PARAMS)
    const deleg = r.operations.find((o) => o.kind === 'stake-delegation')
    expect(deleg).toMatchObject({kind: 'stake-delegation', poolKeyHashHex: 'cd'.repeat(28)})
    const wd = r.operations.find((o) => o.kind === 'reward-withdrawal')
    expect(wd).toMatchObject({kind: 'reward-withdrawal', amount: 2_500_000n, own: true})
    // −10 in + 12.32 out = +2.32, which is the 2.5 withdrawn less the 0.18 fee. The withdrawal is
    // not added on top of that: it is already in the output.
    expect(r.ownDelta).toEqual([{quantity: 2_320_000n}])
  })

  it('sources a legacy stake-registration deposit from protocol params', () => {
    const tx: IndexedCardanoTx = {
      hash: 'dd'.repeat(32),
      fee: 180_000n,
      inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: []}],
      outputs: [{addressBech32: OWN, coin: 7_820_000n, tokens: []}],
      certificates: [{kind: 'stake-registration', credentialHashHex: 'ab'.repeat(28)}],
    }
    const r = reviewCardanoFromHistory(tx, context, PARAMS)
    expect(r.operations.find((o) => o.kind === 'stake-registration')).toMatchObject({deposit: 2_000_000n})
  })

  it('renders native-token movement and a mint op', () => {
    const ASSET = {policyIdHex: 'ff'.repeat(28), assetNameHex: '414243', amount: 5n}
    const tx: IndexedCardanoTx = {
      hash: 'ee'.repeat(32),
      fee: 200_000n,
      inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: []}],
      outputs: [{addressBech32: OWN, coin: 9_800_000n, tokens: [ASSET]}],
      mint: [{policyIdHex: ASSET.policyIdHex, assetNameHex: ASSET.assetNameHex, amount: 5n}],
    }
    const r = reviewCardanoFromHistory(tx, context, PARAMS)
    const mint = r.operations.find((o) => o.kind === 'minting')
    expect(mint).toMatchObject({kind: 'minting', policyIdHex: ASSET.policyIdHex, burns: false})
    // own delta carries the token (+5) even though ADA net is negative (fee)
    expect(
      r.ownDelta.some((a) => a.assetId === `${ASSET.policyIdHex}.${ASSET.assetNameHex}` && a.quantity === 5n),
    ).toBe(true)
    expect(r.warnings).toContain('minting')
  })
})

describe('reviewCardanoFromHistory — a mint into our own CIP-113 smart wallet', () => {
  const SMART_WALLET = 'addr_test1smartwallet'
  const TOKEN = {policyIdHex: '0b'.repeat(28), assetNameHex: '54455354', amount: 1_000_000n}

  // The shape of the real issuance (preview `e45d4dce…`): our address funds it, the whole supply
  // plus its min-ada lands at our smart wallet, change comes back to us.
  const mint: IndexedCardanoTx = {
    hash: 'ab'.repeat(32),
    time: '2026-08-27T00:00:00Z',
    fee: 318_657n,
    inputs: [{addressBech32: OWN, coin: 10_000_000n, tokens: []}],
    outputs: [
      {addressBech32: OWN, coin: 7_681_343n, tokens: []},
      {addressBech32: SMART_WALLET, coin: 2_000_000n, tokens: [TOKEN]},
    ],
    mint: [TOKEN],
  }
  const assetId = `${TOKEN.policyIdHex}.${TOKEN.assetNameHex}`

  // ⚠️ The defect. A smart wallet is the deployment's PLB script over OUR stake credential, so it is
  // in no address list and no gap scan — and ownership here is set membership. Left out, the mint
  // reviewed as a small ada payment to a stranger, and the token detail screen (which filters
  // activity on `ownDelta`) showed "no transactions" over a balance it was displaying.
  it('counts the minted token in ownDelta when the smart wallet is known to be ours', () => {
    const r = reviewCardanoFromHistory(mint, {...context, ownAddressesBech32: new Set([OWN, SMART_WALLET])}, PARAMS)
    const got = r.ownDelta.find((d) => d.assetId === assetId)
    expect(got?.quantity).toBe(1_000_000n)
  })

  it('omits it when the smart wallet is not in the own set — the state that produced the bug', () => {
    const r = reviewCardanoFromHistory(mint, context, PARAMS)
    expect(r.ownDelta.find((d) => d.assetId === assetId)).toBeUndefined()
  })
})
