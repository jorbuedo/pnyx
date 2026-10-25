import {
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  Provider as EvolutionProvider,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {scriptsAt} from './derive'
import {
  discoverSharedWallet,
  indexesOf,
  type SharedUtxo,
  scanUtxoOf,
  selectUtxos,
  sharedScanReader,
  sumAssets,
  type UtxoReader,
} from './discovery'
import {flatTemplate, tagAt} from './template'
import type {SharedWallet} from './types'

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const XPUB_A = '00'.repeat(32) + '11'.repeat(32)
const XPUB_B = '22'.repeat(32) + '33'.repeat(32)

const wallet = (): SharedWallet => {
  const coSigners = [
    {tag: tagAt(0), name: 'Alice', accountXpubHex: XpubHex(XPUB_A), isSelf: true},
    {tag: tagAt(1), name: 'Bob', accountXpubHex: XpubHex(XPUB_B)},
  ]
  const t = flatTemplate(
    {kind: 'all'},
    coSigners.map((c) => c.tag),
  )
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners,
    paymentTemplate: t,
    delegationTemplate: t,
    network: Address.Network.Testnet,
    accountIndex: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
  }
}

/** Addresses for the first n indexes, so a reader can be keyed by address. */
const addressesFor = async (n: number): Promise<readonly string[]> => {
  const w = wallet()
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push((await run(scriptsAt(w, i))).addressBech32)
  return out
}

/** A reader that funds exactly the given indexes with 1 ADA each. */
const readerFunding = (funded: ReadonlySet<number>, addresses: readonly string[]): UtxoReader => {
  const indexOfAddress = new Map(addresses.map((a, i) => [a, i]))
  return (address) => {
    const index = indexOfAddress.get(address)
    if (index === undefined || !funded.has(index)) return Effect.succeed([])
    return Effect.succeed([{txHash: `tx${index}`, index: 0, coin: 1_000_000n, assets: []}])
  }
}

const utxo = (over: Partial<SharedUtxo> = {}): SharedUtxo => ({
  txHash: 'aa',
  index: 0,
  coin: 1_000_000n,
  assets: [],
  keyIndex: 0,
  addressBech32: 'addr_test1x',
  ...over,
})

describe('discoverSharedWallet', () => {
  it('stops after the gap when nothing is funded', async () => {
    const addresses = await addressesFor(40)
    const d = await run(discoverSharedWallet(wallet(), readerFunding(new Set(), addresses), {gap: 5}))
    expect(d.addresses).toHaveLength(5)
    expect(d.coin).toBe(0n)
    expect(d.nextUnusedIndex).toBe(0)
    expect(d.truncated).toBe(false)
  })

  it('finds funds past a hole — the gap counter resets on a used address', async () => {
    // Indexes 1-3 are empty but within the gap, so index 4 is still reached, and
    // reaching it resets the counter. Stopping at the first empty address would
    // miss index 4 entirely.
    const addresses = await addressesFor(40)
    const d = await run(discoverSharedWallet(wallet(), readerFunding(new Set([0, 4]), addresses), {gap: 5}))
    expect(d.coin).toBe(2_000_000n)
    expect(d.utxos.map((u) => u.keyIndex)).toEqual([0, 4])
    // …and the scan then runs 5 further indexes past the last used one.
    expect(d.addresses).toHaveLength(10)
  })

  it('does not look past the gap once it is reached', async () => {
    // Index 12 is beyond a gap of 5 from index 0, so a correct scan misses it.
    const addresses = await addressesFor(40)
    const d = await run(discoverSharedWallet(wallet(), readerFunding(new Set([0, 12]), addresses), {gap: 5}))
    expect(d.coin).toBe(1_000_000n)
  })

  it('tags every UTxO with the index that can sign it', async () => {
    const addresses = await addressesFor(10)
    const d = await run(discoverSharedWallet(wallet(), readerFunding(new Set([3]), addresses), {gap: 5}))
    expect(d.utxos[0]?.keyIndex).toBe(3)
    expect(d.utxos[0]?.addressBech32).toBe(addresses[3])
  })

  it('reports the first unused index for a fresh receive address', async () => {
    const addresses = await addressesFor(10)
    const d = await run(discoverSharedWallet(wallet(), readerFunding(new Set([0, 1]), addresses), {gap: 3}))
    expect(d.nextUnusedIndex).toBe(2)
  })

  it('flags a truncated scan instead of under-reporting silently', async () => {
    // Every address funded, so the gap never closes — the cap stops it.
    const addresses = await addressesFor(20)
    const all = new Set(addresses.map((_, i) => i))
    const d = await run(discoverSharedWallet(wallet(), readerFunding(all, addresses), {gap: 5, maxIndexes: 4}))
    expect(d.truncated).toBe(true)
    expect(d.addresses).toHaveLength(4)
  })
})

describe('sumAssets', () => {
  it('adds quantities per policy and name', () => {
    const totals = sumAssets([
      utxo({assets: [{policyHex: 'p1', nameHex: 'n1', quantity: 5n}]}),
      utxo({assets: [{policyHex: 'p1', nameHex: 'n1', quantity: 7n}]}),
      utxo({assets: [{policyHex: 'p1', nameHex: 'n2', quantity: 1n}]}),
    ])
    expect(totals).toEqual([
      {policyHex: 'p1', nameHex: 'n1', quantity: 12n},
      {policyHex: 'p1', nameHex: 'n2', quantity: 1n},
    ])
  })

  it('keeps different policies with the same asset name apart', () => {
    const totals = sumAssets([
      utxo({assets: [{policyHex: 'p1', nameHex: 'n', quantity: 1n}]}),
      utxo({assets: [{policyHex: 'p2', nameHex: 'n', quantity: 1n}]}),
    ])
    expect(totals).toHaveLength(2)
  })

  it('is empty for ADA-only UTxOs', () => {
    expect(sumAssets([utxo()])).toEqual([])
  })
})

describe('selectUtxos', () => {
  it('takes the largest first and reports sufficiency', () => {
    const result = selectUtxos([utxo({coin: 1n}), utxo({coin: 10n}), utxo({coin: 5n})], 12n)
    expect(result.selected.map((u) => u.coin)).toEqual([10n, 5n])
    expect(result.total).toBe(15n)
    expect(result.sufficient).toBe(true)
  })

  it('reports insufficiency rather than pretending', () => {
    const result = selectUtxos([utxo({coin: 1n})], 100n)
    expect(result.sufficient).toBe(false)
    expect(result.total).toBe(1n)
  })

  it('selects nothing for a zero target', () => {
    expect(selectUtxos([utxo({coin: 5n})], 0n).selected).toEqual([])
  })
})

describe('indexesOf', () => {
  it('lists the distinct indexes a spend spans, in order', () => {
    // Each index needs its own witness — a co-signer's key differs per index.
    expect(indexesOf([utxo({keyIndex: 3}), utxo({keyIndex: 0}), utxo({keyIndex: 3})])).toEqual([0, 3])
  })

  it('is empty for no UTxOs', () => {
    expect(indexesOf([])).toEqual([])
  })
})

const TESTNET_BASE =
  'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh'

describe('scanUtxoOf', () => {
  const POLICY = 'aa'.repeat(28)

  const typed = (assets?: readonly [string, string, bigint][]) =>
    new EvolutionUTxO.UTxO({
      transactionId: TransactionHash.fromHex('bc'.repeat(32)),
      index: 3n,
      address: EvolutionAddress.fromBech32(TESTNET_BASE),
      assets: (assets ?? []).reduce(
        (acc, [policy, name, quantity]) => EvolutionAssets.addByHex(acc, policy, name, quantity),
        EvolutionAssets.fromLovelace(1_500_000n),
      ),
    })

  it('carries the hash, index and lovelace across', () => {
    expect(scanUtxoOf(typed())).toEqual({
      txHash: 'bc'.repeat(32),
      index: 3,
      coin: 1_500_000n,
      assets: [],
    })
  })

  it('flattens the multi-asset map, keeping an EMPTY asset name empty', () => {
    // The empty name is a real asset name, not a missing one — the case that once
    // rendered as the string 'null'.
    const row = scanUtxoOf(
      typed([
        [POLICY, '', 7n],
        [POLICY, '4142', 9n],
      ]),
    )
    expect(row.assets).toEqual([
      {policyHex: POLICY, nameHex: '', quantity: 7n},
      {policyHex: POLICY, nameHex: '4142', quantity: 9n},
    ])
  })
})

const SHED =
  '429 <html><body><h1>429 Too Many Requests</h1>\nYou have sent too many requests in a given amount of time.\n</body></html>\n'

/** A chain client that refuses the first `refusals` reads, then answers empty. */
const refusing = (refusals: number) => {
  let seen = 0
  return {
    getUtxos: ((_address) =>
      Effect.suspend(() => {
        seen += 1
        return seen <= refusals ? Effect.fail(new EvolutionProvider.ProviderError({message: SHED})) : Effect.succeed([])
      })) as EvolutionProvider.ProviderEffect['getUtxos'],
    calls: () => seen,
  }
}

describe('sharedScanReader', () => {
  it('finishes the walk after a refusal instead of taking the rail down', async () => {
    const chain = refusing(2)
    const refused: string[] = []
    const discovered = await run(
      discoverSharedWallet(
        wallet(),
        sharedScanReader(chain.getUtxos, (r) => refused.push(r.kind)),
        {gap: 3},
      ),
    )
    // Three addresses walked, plus the two reads that were refused and re-asked.
    expect(discovered.addresses).toHaveLength(3)
    expect(chain.calls()).toBe(5)
    expect(refused).toEqual(['shed', 'shed'])
  })

  it('fails the walk when the refusals outlast the retries, rather than reporting empty addresses', async () => {
    // An address that cannot be read is not an address with nothing on it: treating
    // it as empty would move the wallet's spending index onto an index holding zero.
    const chain = refusing(Number.POSITIVE_INFINITY)
    const exit = await Effect.runPromiseExit(
      discoverSharedWallet(
        wallet(),
        sharedScanReader(chain.getUtxos, () => undefined),
        {gap: 3},
      ) as Effect.Effect<unknown>,
    )
    expect(exit._tag).toBe('Failure')
  }, 20_000)

  it('passes a non-429 failure straight through — waiting would not fix it', async () => {
    const getUtxos = ((_address) =>
      Effect.fail(
        new EvolutionProvider.ProviderError({message: '400 bad address'}),
      )) as EvolutionProvider.ProviderEffect['getUtxos']
    const exit = await Effect.runPromiseExit(
      discoverSharedWallet(
        wallet(),
        sharedScanReader(getUtxos, () => undefined),
        {gap: 3},
      ) as Effect.Effect<unknown>,
    )
    expect(exit._tag).toBe('Failure')
  })

  it('reports a malformed address as a failure rather than throwing a defect past every handler', async () => {
    const reader = sharedScanReader(
      (() => Effect.succeed([])) as EvolutionProvider.ProviderEffect['getUtxos'],
      () => undefined,
    )
    const exit = await Effect.runPromiseExit(reader('not-an-address' as never) as Effect.Effect<unknown>)
    expect(exit._tag).toBe('Failure')
    // A defect, not a failure, is what an unguarded `fromBech32` would produce.
    expect(exit._tag === 'Failure' && exit.cause._tag).not.toBe('Die')
  })
})
