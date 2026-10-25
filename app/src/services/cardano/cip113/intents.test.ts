import {describe, expect, it} from 'vitest'
import {type IntentTarget, programmableIntents} from './intents'
import type {ProgrammableRecipient} from './recipient'

const POLICY = '16b37cfebd14a0d3da5e8738333b21a145a9f6429f396199d22b67a5'
const NAME = '54455354'
const TEST = `${POLICY}.${NAME}`
const OTHER = `${'77'.repeat(28)}.${NAME}`

const stakeOf = (address: string): string => address.replace('addr_', '').padEnd(56, '0').slice(0, 56)

/** Resolves anything that looks like an address; refuses one that starts with `bad`. */
const resolve = (address: string): ProgrammableRecipient =>
  address.startsWith('bad')
    ? {kind: 'refused', reason: 'no-stake-credential', detail: 'that address has no staking key'}
    : ({kind: 'resolved', owner: {kind: 'key', hashHex: stakeOf(address)}} as unknown as ProgrammableRecipient)

const target = (address: string, amounts: Record<string, bigint>): IntentTarget => ({
  address,
  amounts: new Map(Object.entries(amounts)),
})

describe('programmableIntents', () => {
  it('gives every recipient their own allocation', () => {
    // ⚠️ The regression: only `targets[0]` was read, so the second recipient got nothing and the
    // transaction was valid anyway — it just paid one person and kept the rest.
    const build = programmableIntents(
      [target('addr_alice', {[TEST]: 100n}), target('addr_bob', {[TEST]: 250n})],
      [TEST],
      resolve,
    )
    expect(build.kind).toBe('ok')
    if (build.kind !== 'ok') return
    expect(build.intents).toHaveLength(2)
    expect(build.intents.map((i) => i.quantity)).toEqual([100n, 250n])
    expect(build.intents[0]?.recipient.hashHex).toBe(stakeOf('addr_alice'))
    expect(build.intents[1]?.recipient.hashHex).toBe(stakeOf('addr_bob'))
  })

  it('never gives one recipient another recipient amount', () => {
    // The basket is a total across the send. Reading it per recipient would send each of them all
    // of it — the mirror-image bug of dropping them.
    const build = programmableIntents(
      [target('addr_alice', {[TEST]: 100n}), target('addr_bob', {[TEST]: 250n})],
      [TEST],
      resolve,
    )
    if (build.kind !== 'ok') throw new Error('expected ok')
    expect(build.intents.reduce((sum, i) => sum + i.quantity, 0n)).toBe(350n)
  })

  it('emits one intent per asset per recipient', () => {
    const build = programmableIntents([target('addr_alice', {[TEST]: 5n, [OTHER]: 7n})], [TEST, OTHER], resolve)
    if (build.kind !== 'ok') throw new Error('expected ok')
    expect(build.intents.map((i) => `${i.policyHex}.${i.assetNameHex}=${i.quantity}`)).toEqual([
      `${TEST}=5`,
      `${OTHER}=7`,
    ])
  })

  it('skips an asset a recipient was allocated none of', () => {
    const build = programmableIntents([target('addr_alice', {[TEST]: 5n, [OTHER]: 0n})], [TEST, OTHER], resolve)
    if (build.kind !== 'ok') throw new Error('expected ok')
    expect(build.intents).toHaveLength(1)
  })

  it('refuses the whole build for one unusable recipient, and names them', () => {
    // Not "drop that one and send to the others" — a send that quietly reaches three of four
    // people is the failure this module exists to prevent.
    const build = programmableIntents(
      [target('addr_alice', {[TEST]: 100n}), target('bad_carol', {[TEST]: 100n})],
      [TEST],
      resolve,
    )
    expect(build).toMatchObject({kind: 'refused', address: 'bad_carol'})
  })

  it('reports empty rather than building a transfer that moves nothing', () => {
    const build = programmableIntents([target('addr_alice', {[TEST]: 0n})], [TEST], resolve)
    expect(build.kind).toBe('empty')
  })

  it('reports empty for no recipients at all', () => {
    expect(programmableIntents([], [TEST], resolve).kind).toBe('empty')
  })
})
