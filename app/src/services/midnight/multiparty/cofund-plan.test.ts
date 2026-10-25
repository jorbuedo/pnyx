// Choosing each wallet's inputs for a co-funded payment. Getting this wrong is a silently wrong
// transaction — the wrong wallet paying, or a payment built from a figure nobody stated — so the
// rules are pinned here rather than left to the orchestration that calls it.
import {describe, expect, it} from 'vitest'
import type {UnshieldedUtxo} from '../wallet/unshielded-utxo-set'
import {type CoFundSource, describeCoFundFailure, planCoFunding} from './cofund-plan'

const NIGHT = '00'.repeat(32)

const utxo = (value: bigint, outputIndex: number): UnshieldedUtxo => ({
  owner: 'owner',
  tokenType: NIGHT,
  value,
  intentHash: `${outputIndex}`.padStart(64, '0'),
  outputIndex,
  ctime: null,
  registeredForDustGeneration: true,
})

const source = (name: string, pledge: bigint, values: readonly bigint[]): CoFundSource => ({
  scopeKey: `group-${name}:0`,
  name,
  owner: new Uint8Array(32).fill(name.length),
  utxos: values.map((v, i) => utxo(v, i)),
  pledge,
})

describe('planCoFunding', () => {
  it('makes the payment the sum of the pledges', () => {
    const plan = planCoFunding([source('A', 2_000n, [3_000n]), source('B', 4_000n, [5_000n])])
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.payment).toBe(6_000n)
  })

  it('lets a wallet pledge less than one input holds — the remainder returns to it', () => {
    // The native builder writes each contributor's change, so exact change is not required and a
    // wallet must not be refused for lacking it.
    const plan = planCoFunding([source('A', 1n, [1_000n])])
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.contributions[0]?.inputs).toHaveLength(1)
      expect(plan.payment).toBe(1n)
    }
  })

  it('takes largest-first, so a pledge costs as few inputs as it can', () => {
    const plan = planCoFunding([source('A', 900n, [100n, 500n, 400n, 50n])])
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.contributions[0]?.inputs.map((i) => i.value)).toEqual([500n, 400n])
  })

  it('names the wallet that cannot cover its pledge, and what it actually holds', () => {
    const plan = planCoFunding([source('A', 2_000n, [3_000n]), source('Bob', 9_000n, [1_000n, 2_000n])])
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.failure).toEqual({kind: 'source-short', name: 'Bob', pledge: 9_000n, held: 3_000n})
      expect(describeCoFundFailure(plan.failure)).toContain('Bob')
    }
  })

  it('drops a wallet that pledged nothing rather than gathering its inputs', () => {
    const plan = planCoFunding([source('A', 2_000n, [3_000n]), source('B', 0n, [5_000n])])
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.contributions).toHaveLength(1)
      expect(plan.contributions[0]?.name).toBe('A')
    }
  })

  it('refuses when nobody pledged anything', () => {
    const plan = planCoFunding([source('A', 0n, [3_000n])])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.failure.kind).toBe('nothing-pledged')
  })

  it('refuses an empty round', () => {
    const plan = planCoFunding([])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.failure.kind).toBe('nothing-pledged')
  })

  it('refuses the same wallet twice — its inputs would be gathered twice over', () => {
    const twice = source('A', 1_000n, [3_000n])
    const plan = planCoFunding([twice, twice])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.failure.kind).toBe('duplicate-source')
  })

  it('keeps each wallet’s own owner key on its own contribution', () => {
    // The owner is what binds an input to the wallet that must sign it. Crossing them would produce a
    // transaction every signature fails to satisfy.
    const plan = planCoFunding([source('A', 1n, [10n]), source('Bee', 1n, [10n])])
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.contributions[0]?.owner[0]).toBe(1)
      expect(plan.contributions[1]?.owner[0]).toBe(3)
    }
  })
})
