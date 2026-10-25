import {describe, expect, it} from 'vitest'
import {type ContributedUtxo, type Contribution, composeMultiparty, type MinAdaFor} from './compose'
import {makeValue} from './value'

const ADA = 1_000_000n
/** Enough for any plain-ADA output; the asset cases override it explicitly. */
const minAda: MinAdaFor = () => 1n * ADA

let nextHash = 0
const utxo = (over: Partial<ContributedUtxo> & {lovelace: bigint}): ContributedUtxo => ({
  txHash: over.txHash ?? `${(nextHash++ % 256).toString(16).padStart(2, '0')}`.repeat(32),
  index: over.index ?? nextHash,
  addressHex: over.addressHex ?? 'addr_alice',
  lovelace: over.lovelace,
  ...(over.assets === undefined ? {} : {assets: over.assets}),
})

const alice = (over: Partial<Contribution> = {}): Contribution => ({
  walletId: 'alice',
  name: 'Alice',
  isComposer: true,
  available: [utxo({lovelace: 100n * ADA, addressHex: 'addr_alice'})],
  value: makeValue(25n * ADA),
  ...over,
})

const bob = (over: Partial<Contribution> = {}): Contribution => ({
  walletId: 'bob',
  name: 'Bob',
  available: [utxo({lovelace: 200n * ADA, addressHex: 'addr_bob'})],
  value: makeValue(25n * ADA),
  ...over,
})

const ok = (result: ReturnType<typeof composeMultiparty>) => {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${JSON.stringify(result.failure, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))}`,
    )
  }
  return result.composed
}

const failure = (result: ReturnType<typeof composeMultiparty>) => {
  if (result.ok) throw new Error('expected a failure')
  return result.failure
}

const partyIn = (composed: ReturnType<typeof ok>, walletId: string) =>
  composed.parties.find((p) => p.walletId === walletId)

describe('composeMultiparty — the worked two-party case', () => {
  const composed = ok(composeMultiparty([alice(), bob()], minAda))

  it('sends the sum of the contributions', () => {
    expect(composed.total.lovelace).toBe(50n * ADA)
  })

  it('returns the co-contributor their whole surplus, explicitly', () => {
    expect(composed.returns).toHaveLength(1)
    expect(composed.returns[0]?.walletId).toBe('bob')
    expect(composed.returns[0]?.returned.lovelace).toBe(175n * ADA)
    expect(composed.returns[0]?.returnAddressHex).toBe('addr_bob')
  })

  it('never gives the composer a return output — that is what change is for', () => {
    expect(composed.returns.map((r) => r.walletId)).not.toContain('alice')
    expect(composed.changeAddressHex).toBe('addr_alice')
  })

  it('pins every selected coin, the composer’s included', () => {
    // Leaving the composer's selectable let coin selection drop them entirely once the
    // co-contributors covered the outputs — and the body is what the roster is read from,
    // so the wallet building the transaction stopped being asked to sign it.
    expect(composed.mandatoryInputs).toHaveLength(2)
  })
})

describe('composeMultiparty — the theft case', () => {
  it('leaves no co-contributor surplus for the change to absorb', () => {
    const composed = ok(composeMultiparty([alice(), bob()], minAda))
    const bobParty = partyIn(composed, 'bob')
    const spent = bobParty?.selected.reduce((sum, u) => sum + u.lovelace, 0n) ?? 0n
    expect((bobParty?.returned.lovelace ?? 0n) + 25n * ADA).toBe(spent)
  })

  it('holds for many parties at once', () => {
    const carol: Contribution = {
      walletId: 'carol',
      name: 'Carol',
      available: [utxo({lovelace: 40n * ADA, addressHex: 'addr_carol'})],
      value: makeValue(10n * ADA),
    }
    const composed = ok(composeMultiparty([alice(), bob(), carol], minAda))
    expect(composed.total.lovelace).toBe(60n * ADA)
    expect(composed.returns.map((r) => r.walletId).sort()).toEqual(['bob', 'carol'])
  })
})

describe('composeMultiparty — per-party coin selection', () => {
  it('draws only the coins a contribution needs, not the whole wallet', () => {
    // The bug this replaced: every UTxO was pinned, so putting in 3 ADA from a fragmented
    // wallet spent all of it — the real source of the transaction-size pressure.
    const fragmented = bob({
      available: Array.from({length: 50}, () => utxo({lovelace: 5n * ADA, addressHex: 'addr_bob'})),
      value: makeValue(3n * ADA),
    })
    const composed = ok(composeMultiparty([alice(), fragmented], minAda))
    expect(partyIn(composed, 'bob')?.selected).toHaveLength(1)
    expect(partyIn(composed, 'bob')?.returned.lovelace).toBe(2n * ADA)
  })

  it('draws another coin when the surplus would be below min-ADA', () => {
    // 3.5 out of a single 4 ADA coin leaves 0.5, which is not representable as an output,
    // so a second coin is drawn rather than the remainder being folded into the fee.
    const tight = bob({
      available: [
        utxo({lovelace: 4n * ADA, addressHex: 'addr_bob'}),
        utxo({lovelace: 4n * ADA, addressHex: 'addr_bob'}),
      ],
      value: makeValue(3n * ADA + 500_000n),
    })
    const composed = ok(composeMultiparty([alice(), tight], minAda))
    expect(partyIn(composed, 'bob')?.selected).toHaveLength(2)
    expect(partyIn(composed, 'bob')?.returned.lovelace).toBe(4n * ADA + 500_000n)
  })

  it('writes no return when a party contributes exactly one whole coin', () => {
    const exact = bob({available: [utxo({lovelace: 25n * ADA, addressHex: 'addr_bob'})], value: makeValue(25n * ADA)})
    const composed = ok(composeMultiparty([alice(), exact], minAda))
    expect(composed.returns).toEqual([])
    // Still spent, so still on the roster and still owing a signature.
    expect(partyIn(composed, 'bob')?.selected).toHaveLength(1)
  })

  it('refuses when everything the party holds still cannot leave a lawful return', () => {
    const nearly = bob({
      available: [utxo({lovelace: 3n * ADA + 100n, addressHex: 'addr_bob'})],
      value: makeValue(3n * ADA),
    })
    expect(failure(composeMultiparty([alice(), nearly], minAda))).toMatchObject({
      kind: 'return-below-min-ada',
      name: 'Bob',
      returned: 100n,
    })
  })
})

describe('composeMultiparty — native tokens', () => {
  const TOKEN = 'policy.aaa'

  it('returns tokens the party did not contribute', () => {
    const holder = bob({
      available: [utxo({lovelace: 200n * ADA, addressHex: 'addr_bob', assets: new Map([[TOKEN, 10n]])})],
      value: makeValue(25n * ADA),
    })
    const composed = ok(composeMultiparty([alice(), holder], minAda))
    expect(composed.returns[0]?.returned.assets.get(TOKEN)).toBe(10n)
  })

  it('contributes tokens and returns only the remainder', () => {
    const holder = bob({
      available: [utxo({lovelace: 200n * ADA, addressHex: 'addr_bob', assets: new Map([[TOKEN, 10n]])})],
      value: makeValue(25n * ADA, new Map([[TOKEN, 4n]])),
    })
    const composed = ok(composeMultiparty([alice(), holder], minAda))
    expect(composed.total.assets.get(TOKEN)).toBe(4n)
    expect(composed.returns[0]?.returned.assets.get(TOKEN)).toBe(6n)
  })

  it('drops an asset contributed in full rather than returning a zero entry', () => {
    // `{A: 0}` must equal `{}` — a zero entry would inflate the return's min-ADA and make
    // two equal values compare unequal.
    const holder = bob({
      available: [utxo({lovelace: 200n * ADA, addressHex: 'addr_bob', assets: new Map([[TOKEN, 4n]])})],
      value: makeValue(25n * ADA, new Map([[TOKEN, 4n]])),
    })
    const composed = ok(composeMultiparty([alice(), holder], minAda))
    expect(composed.returns[0]?.returned.assets.size).toBe(0)
  })

  it('prefers the coins that carry a contributed token', () => {
    const holder = bob({
      available: [
        utxo({lovelace: 90n * ADA, addressHex: 'addr_plain'}),
        utxo({lovelace: 10n * ADA, addressHex: 'addr_tokens', assets: new Map([[TOKEN, 7n]])}),
      ],
      value: makeValue(5n * ADA, new Map([[TOKEN, 7n]])),
    })
    const composed = ok(composeMultiparty([alice(), holder], minAda))
    expect(partyIn(composed, 'bob')?.selected[0]?.addressHex).toBe('addr_tokens')
  })

  it('refuses a token contribution the party does not hold', () => {
    const holder = bob({value: makeValue(25n * ADA, new Map([[TOKEN, 1n]]))})
    expect(failure(composeMultiparty([alice(), holder], minAda))).toMatchObject({
      kind: 'contribution-exceeds-inputs',
      name: 'Bob',
    })
  })
})

describe('composeMultiparty — refusals, each naming the party', () => {
  it('refuses a single contributor: that is an ordinary send', () => {
    expect(failure(composeMultiparty([alice()], minAda))).toEqual({kind: 'single-contributor'})
  })

  it('refuses with no composer, and with more than one', () => {
    expect(failure(composeMultiparty([alice({isComposer: false}), bob()], minAda))).toEqual({kind: 'no-composer'})
    expect(failure(composeMultiparty([alice(), bob({isComposer: true})], minAda))).toEqual({kind: 'multiple-composers'})
  })

  it('refuses a composer with no inputs — they own the change and pay the fee from it', () => {
    expect(failure(composeMultiparty([alice({available: []}), bob()], minAda))).toEqual({
      kind: 'composer-has-no-inputs',
    })
  })

  it('refuses a co-contributor with no inputs, by name', () => {
    expect(failure(composeMultiparty([alice(), bob({available: []})], minAda))).toEqual({
      kind: 'party-has-no-inputs',
      walletId: 'bob',
      name: 'Bob',
    })
  })

  it('refuses a party contributing nothing while still owing a signature', () => {
    expect(failure(composeMultiparty([alice(), bob({value: makeValue(0n)})], minAda))).toMatchObject({
      kind: 'zero-contribution',
      name: 'Bob',
    })
  })

  it('refuses a contribution larger than the party holds', () => {
    expect(failure(composeMultiparty([alice(), bob({value: makeValue(500n * ADA)})], minAda))).toMatchObject({
      kind: 'contribution-exceeds-inputs',
      name: 'Bob',
    })
  })

  it('refuses the same UTxO offered by two parties', () => {
    const shared = utxo({lovelace: 50n * ADA, txHash: 'ee'.repeat(32), index: 3})
    const result = composeMultiparty(
      [alice({available: [shared]}), bob({available: [shared], value: makeValue(1n * ADA)})],
      minAda,
    )
    expect(failure(result)).toEqual({kind: 'duplicate-input', txHash: 'ee'.repeat(32), index: 3})
  })
})
