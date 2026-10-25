import {
  Assets,
  Bytes,
  Address as EvAddress,
  Address as EvolutionAddress,
  Provider as EvolutionProvider,
  TransactionHash,
  TxOut,
  type UTxO,
} from '@evolution-sdk/evolution'
import {MockProvider} from '@evolution-sdk/evolution/sdk/provider/Mock'
import * as EvolutionTransaction from '@evolution-sdk/evolution/Transaction'
import * as TransactionBody from '@evolution-sdk/evolution/TransactionBody'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Tx, Wallet} from '@pnyx/cardano-core'
import {type PendingTx, utxoId} from '@pnyx/wallet'
import {Effect, Layer} from 'effect'
import {afterEach, describe, expect, it} from 'vitest'
import {setCardanoDataStore} from './cardano-store'
import type {CardanoRailConfig} from './config'
import {
  cardanoRailLayer,
  clearCardanoRailLayers,
  makeCardanoRail,
  reconcilePendingTxs,
  seedRailAddressSet,
} from './rail'
import {watermarkOf} from './sync-decision'
import {chainUtxo, mockChain} from './test-provider'
import {testUtxo} from './test-utxo'

const TESTNET_BASE =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'

const CONFIG: CardanoRailConfig = {
  network: 'preprod',
  koiosUrl: 'https://koios.internal/api/v1',
  networkId: 0,
  protocolMagic: 1,
}

const providerUtxo = (
  fill: string,
  index: number,
  coin: bigint,
  assets: readonly (readonly [string, string, bigint])[] = [],
) => chainUtxo({address: TESTNET_BASE, txHash: fill, index, lovelace: coin, assets})

/**
 * A real signed transaction, because `rail.submit` DECODES what it is given.
 *
 * ⚠️ This was `'84a0a0f5f6'` — a transaction whose body is an empty map, so it has no input set
 * and is not a transaction at all. It stood in for one for as long as nothing on the path
 * decoded it: the mock's submit took hex and ignored it. The real submit parses, so the fixture
 * had to become one. [[a-fixture-string-nobody-decodes-is-not-a-value]]
 */
const signedTx = (): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        0,
      )
      const addressHex = Address.fromBech32Sync(Bech32(TESTNET_BASE))
      const body = TransactionBody.toCBORHex(
        TransactionBody.fromEncoded({
          inputs: [Bytes.fromHex(Tx.inputHex(TxHashHex('11'.repeat(32)), 0n))],
          outputs: [
            TxOut.toCBORBytes(
              new TxOut.TransactionOutput({
                address: EvAddress.fromHex(addressHex),
                assets: Assets.fromLovelace(1_000_000n),
                encodingFormat: 'babbage',
              }),
            ),
          ],
          fee: 200_000n,
        }),
      )
      const xprv = yield* account.paymentKey()
      const w = yield* Tx.partialSign(body, xprv)
      return yield* Tx.assemble(body, [{vkeyHex: w.vkeyHex, sigHex: w.sigHex}])
    }) as Effect.Effect<string>,
  )

const railWith = (utxos: readonly ReturnType<typeof providerUtxo>[]) =>
  makeCardanoRail({config: CONFIG, addressBech32: TESTNET_BASE, accountIndex: 0}).pipe(
    Effect.provide(Layer.mergeAll(EvolutionDecodeLayer, mockChain({utxos: [...utxos]}))),
  )

// ⚠️ `evolutionUtxoToWalletUtxo` and its four tests are GONE, with the conversion they covered:
// the rail carries Evolution's `UTxO` end to end, so there is nothing to map. The properties they
// asserted — the dotted `policy.name` spelling, an EMPTY asset name staying empty rather than
// reading as absent, and the address a credential-keyed row came back with — moved to
// `utxo-view.test.ts`, which is where that spelling is now decided.

describe('reconcilePendingTxs', () => {
  const wUtxo = (fill: number, index: number): UTxO.UTxO =>
    testUtxo({txHash: fill, index, address: TESTNET_BASE, lovelace: 1n})
  const hashHex = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString('hex')

  it('confirms when own change appears in the confirmed set', () => {
    const change = wUtxo(0xaa, 0)
    const pending: PendingTx[] = [
      {txHash: TxHashHex(hashHex(0xaa)), consumedUtxoIds: ['x:0'], change: [change], submittedAt: 0},
    ]
    expect(reconcilePendingTxs(new Set([utxoId(change)]), pending)).toEqual([hashHex(0xaa)])
    expect(reconcilePendingTxs(new Set(), pending)).toEqual([])
  })

  it('confirms a no-change tx when its real inputs vanished', () => {
    const consumed = wUtxo(0x01, 0)
    const pending: PendingTx[] = [
      {txHash: TxHashHex(hashHex(0xbb)), consumedUtxoIds: [utxoId(consumed)], change: [], submittedAt: 0},
    ]
    expect(reconcilePendingTxs(new Set(), pending)).toEqual([hashHex(0xbb)])
    expect(reconcilePendingTxs(new Set([utxoId(consumed)]), pending)).toEqual([])
  })

  it('never confirms a no-change tx on virtual inputs alone', () => {
    const changeA = wUtxo(0xaa, 1)
    const pending: PendingTx[] = [
      {txHash: TxHashHex(hashHex(0xaa)), consumedUtxoIds: ['real:0'], change: [changeA], submittedAt: 0},
      {txHash: TxHashHex(hashHex(0xbb)), consumedUtxoIds: [utxoId(changeA)], change: [], submittedAt: 0},
    ]
    // A's change is virtual; B consuming only virtual inputs must not self-confirm.
    expect(reconcilePendingTxs(new Set(), pending)).not.toContain(hashHex(0xbb))
  })
})

describe('makeCardanoRail', () => {
  it('syncs confirmed utxos and reports balance', async () => {
    const rail = await Effect.runPromise(
      railWith([providerUtxo('11', 0, 5_000_000n), providerUtxo('22', 1, 2_000_000n)]),
    )
    await Effect.runPromise(rail.sync)
    const spendable = await Effect.runPromise(rail.spendableUtxos)
    const balance = await Effect.runPromise(rail.balance)
    expect(spendable).toHaveLength(2)
    expect(balance.primary.quantity).toBe(7_000_000n)
  })

  it('submitAndTrack locks inputs and exposes change until reconciled', async () => {
    // ⚠️ The change UTxO sits at the transaction's REAL id, computed from the bytes submitted.
    // It used to be `new Uint8Array(32)`, matching a mock whose submit answered a fixed
    // `00…00` — a hash no transaction has, so the overlay was keyed on a value the chain could
    // never produce and the identity the tracker is built around went unexercised.
    const rail = await Effect.runPromise(railWith([providerUtxo('11', 0, 5_000_000n)]))
    await Effect.runPromise(rail.sync)
    const confirmed = await Effect.runPromise(rail.confirmedUtxos)
    const spent = confirmed[0] as UTxO.UTxO
    const signedTxHex = await signedTx()
    const expectedHash = TransactionHash.toHex(
      TransactionBody.toHash(EvolutionTransaction.fromCBORHex(signedTxHex).body),
    )
    const change: UTxO.UTxO = testUtxo({txHash: expectedHash, address: TESTNET_BASE, lovelace: 4_000_000n})
    const txHash = await Effect.runPromise(
      rail.submitAndTrack(signedTxHex, {consumedUtxoIds: [utxoId(spent)], change: [change]}),
    )
    expect(txHash).toBe(expectedHash)
    const spendable = await Effect.runPromise(rail.spendableUtxos)
    expect(spendable.map(utxoId)).toEqual([utxoId(change)])
    const balance = await Effect.runPromise(rail.balance)
    expect(balance.primary.quantity).toBe(4_000_000n)
  })

  // The min-interval branch used to return with no log at all, so "nobody asked this rail
  // to sync" and "it was asked and declined" were the same empty trail — the ambiguity that
  // cost a session on the 2026-09-09 stale-balance reports.
  //
  // The chain's answer has to *change* between the two calls for this to discriminate: with a
  // fixed mock both a re-fetch and a skip produce the same set, and the first version of this
  // test passed with the throttle branch disabled.
  it('serves the cached set rather than re-fetching when asked again inside the min-interval', async () => {
    /**
     * ⚠️ A chain that CHANGES between syncs, which the shared mock cannot be: it holds its
     * ledger internally, by design, because it is a ledger rather than a lookup table. The
     * subject here is the rail's throttle, so the instrument has to be one whose answer moves.
     */
    let answer = [providerUtxo('11', 0, 5_000_000n)]
    const chain = Layer.succeed(EvolutionProvider.ProviderEffect, {
      ...new MockProvider({}).effect,
      getUtxos: () => Effect.succeed([...answer]),
    } as EvolutionProvider.ProviderEffect)
    const rail = await Effect.runPromise(
      makeCardanoRail({config: CONFIG, addressBech32: TESTNET_BASE, accountIndex: 0}).pipe(
        Effect.provide(Layer.mergeAll(EvolutionDecodeLayer, chain)),
      ),
    )
    await Effect.runPromise(rail.sync)
    expect(await Effect.runPromise(rail.confirmedUtxos)).toHaveLength(1)

    answer = [providerUtxo('11', 0, 5_000_000n), providerUtxo('22', 1, 3_000_000n)]
    await Effect.runPromise(rail.sync)

    const after = await Effect.runPromise(rail.confirmedUtxos)
    expect(after).toHaveLength(1)
    expect((await Effect.runPromise(rail.balance)).primary.quantity).toBe(5_000_000n)
  })
})

describe('cardanoRailLayer', () => {
  // ⚠️ The regression this exists for. `koiosProvider` keeps its epoch-params cache in its own
  // closure and returns a `Layer.succeed` over an already-built provider, so it is built when the
  // factory is called — a fresh layer per call threw the cache away every time. Measured on a
  // device: `tip: 11, epoch_params: 11` in one 60-second window, for data that changes every
  // ~5 days. Identity is the assertion, because sharing the layer is what shares the cache.
  it('returns one layer per (network, endpoint), so the params cache survives', () => {
    clearCardanoRailLayers()

    expect(cardanoRailLayer(CONFIG)).toBe(cardanoRailLayer(CONFIG))
    // A structurally-equal config must hit too — callers build these fresh from `getCardanoRailConfig`.
    expect(cardanoRailLayer({...CONFIG})).toBe(cardanoRailLayer(CONFIG))
  })

  it('never serves one network the layer built for another', () => {
    clearCardanoRailLayers()
    const preprod = cardanoRailLayer(CONFIG)
    const mainnet = cardanoRailLayer({...CONFIG, network: 'mainnet', networkId: 1})
    // The upstream comment warns that a cache keyed on base URL alone leaked across networks;
    // keying on both is what keeps a switch from serving the other chain's params.
    expect(mainnet).not.toBe(preprod)
  })

  it('separates two endpoints on the same network', () => {
    clearCardanoRailLayers()
    const a = cardanoRailLayer(CONFIG)
    const b = cardanoRailLayer({...CONFIG, koiosUrl: 'https://other.internal/api/v1'})

    expect(b).not.toBe(a)
  })

  it('drops what it memoized when asked', () => {
    clearCardanoRailLayers()
    const first = cardanoRailLayer(CONFIG)
    clearCardanoRailLayers()

    expect(cardanoRailLayer(CONFIG)).not.toBe(first)
  })
})

describe('seedRailAddressSet', () => {
  // Same account as TESTNET_BASE, receive index 1 — shares the stake credential, different
  // payment key. The address a dApp picks out of `getUnusedAddresses` looks exactly like this.
  const TESTNET_INDEX_1 =
    'addr_test1qqz85693g4fr8c55mfyxhae8j2u04pydxrgqr73vmwpx3a8927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqlu9096'

  type Query = {readonly groupId: string; readonly chainId: string; readonly accountIndex?: number}

  const storeWith = (rows: ReadonlyArray<Record<string, unknown>>, seen: Query[]) =>
    ({
      listAddresses: (query: Query) => {
        seen.push(query)
        return Effect.succeed(rows)
      },
      // biome-ignore lint/suspicious/noExplicitAny: only `listAddresses` is reached from here.
    }) as any

  afterEach(() => {
    setCardanoDataStore(null as never)
  })

  it('reads the book of the wallet the rail is FOR, not of whatever is selected', async () => {
    // ⚠️ The whole point of passing groupId and accountIndex down rather than reading app state:
    // a review opened for wallet X while wallet Y is active must classify X's addresses as X's.
    const seen: Query[] = []
    setCardanoDataStore(storeWith([], seen))

    await seedRailAddressSet('group-X', 'cardano:preprod' as never, 3, TESTNET_BASE)

    expect(seen).toEqual([{groupId: 'group-X', chainId: 'cardano:preprod', accountIndex: 3}])
  })

  it('returns every derived address except the primary, with its path', async () => {
    const seen: Query[] = []
    setCardanoDataStore(
      storeWith(
        [
          {human: TESTNET_BASE, branch: 'external', index: 0, isUsed: true},
          {human: TESTNET_INDEX_1, branch: 'external', index: 1, isUsed: false},
        ],
        seen,
      ),
    )

    const set = await seedRailAddressSet('group-X', 'cardano:preprod' as never, 0, TESTNET_BASE)

    expect(set?.beyondPrimary).toEqual([TESTNET_INDEX_1])
    // Without the path the address is recognised but cannot be witnessed.
    expect(set?.paths.get(TESTNET_INDEX_1)).toBeDefined()
  })

  it('asks for both branches: change addresses are the wallet’s too', async () => {
    // A rail that knew only the external branch would read its own change as a stranger's.
    const seen: Query[] = []
    setCardanoDataStore(storeWith([], seen))

    await seedRailAddressSet('group-X', 'cardano:preprod' as never, 0, TESTNET_BASE)

    expect(seen[0]).not.toHaveProperty('branch')
  })

  it('answers null when no store is bound, leaving the caller on its primary address', async () => {
    setCardanoDataStore(null as never)
    expect(await seedRailAddressSet('group-X', 'cardano:preprod' as never, 0, TESTNET_BASE)).toBeNull()
  })

  it('answers null when the read fails, rather than pretending the wallet has one address', async () => {
    setCardanoDataStore({listAddresses: () => Effect.fail(new Error('store is gone'))} as never)
    expect(await seedRailAddressSet('group-X', 'cardano:preprod' as never, 0, TESTNET_BASE)).toBeNull()
  })
})

/**
 * The watermark probe, through Evolution's typed client.
 *
 * ⚠️ **This path had no test until it was migrated, and that is how it nearly shipped dead.** The
 * probe reads `chain.getTxsAt` now; the adapter behind `withEvolutionView` was missing that member
 * entirely, so the probe would have seen `undefined`, reported "no history", and sent every sync
 * to a full refetch — silently, because a provider that cannot answer is a legitimate state.
 */
describe('the sync watermark probe', () => {
  const PROBE_TX = 'ab'.repeat(32)

  const railWithRefs = (refs: readonly {txHash: string; blockHeight: number}[]) =>
    makeCardanoRail({config: CONFIG, addressBech32: TESTNET_BASE, accountIndex: 0}).pipe(
      Effect.provide(
        Layer.mergeAll(
          EvolutionDecodeLayer,
          mockChain({
            utxos: [],
            txRefs: refs.map((r) => ({txHash: TransactionHash.fromHex(r.txHash), blockHeight: r.blockHeight})),
          }),
        ),
      ),
    )

  it('reads the newest tx through the typed client, so the sync can be skipped', async () => {
    const rail = await Effect.runPromise(railWithRefs([{txHash: PROBE_TX, blockHeight: 500}]))

    // The member the probe depends on must be SERVED, not absent — absent is what made this
    // silent, and it reads identically to "this backend has no history".
    expect(rail.chain.getTxsAt).toBeTypeOf('function')

    const refs = await Effect.runPromise(rail.chain.getTxsAt!([EvolutionAddress.fromBech32(TESTNET_BASE)], {limit: 1}))
    expect(refs).toHaveLength(1)
    expect(TransactionHash.toHex(refs[0]!.txHash)).toBe(PROBE_TX)
    expect(watermarkOf(refs)).toEqual({newestTxHash: PROBE_TX, newestBlockHeight: 500})
  })

  it('exposes chain reads but NOT submitTx, which is what keeps the leaked-key gate on one path', async () => {
    // ⚠️ This replaced a test that read the same chain through both of the rail's ports. There
    // is one port now, so that property is gone — and this took its place rather than nothing:
    // `rail.submit` is the only route to the network precisely because the client handed to
    // callers cannot submit, so a caller reaching `submitTx` here would bypass the guard
    // without touching a line of it.
    const rail = await Effect.runPromise(railWithRefs([{txHash: PROBE_TX, blockHeight: 500}]))

    expect(rail.chain.getTxsAt).toBeTypeOf('function')
    expect((rail.chain as {submitTx?: unknown}).submitTx).toBeUndefined()
    expect(rail.submit).toBeTypeOf('function')
  })
})
