/**
 * The app→library seam for CIP-139: that `createCardanoHandlerContext` actually wires the
 * rail's provider into a query surface. The dapp-connector tests build a query context
 * directly, so without this nothing would catch the wiring being absent — and the failure
 * mode is silent, since a missing `query` just means the extension is never advertised.
 */

import {
  DatumOption,
  Address as EvAddress,
  Assets as EvolutionAssets,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {MockProvider} from '@evolution-sdk/evolution/sdk/provider/Mock'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Decode, layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {setCardanoDataStore} from './cardano-store'
import {createCardanoHandlerContext} from './dapp-context'
import type {CardanoRail} from './rail'
import {testUtxo} from './test-utxo'

const TX = 'ab'.repeat(32)
// ⚠️ A REAL bech32 address. The previous constant was not one — both codecs reject it —
// and nothing noticed while the string was only ever a key into a stub's UTxO map.
const DATUM = 'd8799f0142cafeff' // constr 0 [1, h'cafe']
// ⚠️ A real bech32: the typed view decodes it, where the wallet-shaped port carried it through.
const ADDRESS = 'addr_test1vzpwq95z3xyum8vqndgdd9mdnmafh3djcxnc6jemlgdmswcve6tkw'

const decode = Effect.runSync(Effect.flatMap(Decode, Effect.succeed).pipe(Effect.provide(EvolutionDecodeLayer)))

/**
 * Only the members `createCardanoHandlerContext` touches.
 *
 * ⚠️ The chain is Evolution's own mock, not a hand-written object. It used to be the
 * wallet-shaped stub plus `ToEvolution.toEvolutionProvider` over a SECOND copy of the same
 * fields — written twice because the rail carried both ports, and the second copy is where
 * `'addr_test1vrxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumng5y82j7` lived: a bech32 nothing
 * decoded, so it stood in for an address for as long as the port carried it straight through.
 */
const rail = (): CardanoRail =>
  ({
    config: {networkId: 0, protocolMagic: 1, network: 'preprod', koiosUrl: 'https://k/api/v1'},
    account: {addressHex: '00'.repeat(29), stakeKeyHashHex: 'cd'.repeat(28)},
    spendableUtxos: Effect.succeed([]),
    decode,
    submit: () => Effect.succeed(TX),
    chain: new MockProvider({
      utxos: [
        new EvolutionUTxO.UTxO({
          transactionId: TransactionHash.fromHex(TX),
          index: 0n,
          address: EvAddress.fromBech32(ADDRESS),
          assets: EvolutionAssets.fromLovelace(2_000_000n),
          // ⚠️ Through the real DECODER, which is what records the original bytes against the
          // object. CIP-139 emits `datum_hex` only when a provider preserved them — a datum
          // built from scratch has no original to report, and re-deriving one would fabricate
          // exactly the value the field exists to guarantee. Constructing the class directly
          // produced a UTxO whose datum had no `datum_hex` at all.
          // `[1, #6.24(bytes)]` — the inline-datum arm of the CDDL, around DATUM's 8 bytes.
          datumOption: DatumOption.fromCBORHex(`8201d81848${DATUM}`),
        }),
      ],
      // The tip the `experimental_tip` assertion below reads. ⚠️ Seeded, because the mock's
      // own default is a different slot — an assertion against a default is an assertion about
      // the mock rather than about the wiring.
      tip: {slot: 42, blockHash: 'ab'.repeat(32), epoch: 7},
    }).effect,
  }) as unknown as CardanoRail

// Narrows the optional query surface by failing the test, rather than asserting it away.
// `context.query!` would hand `undefined` straight to Effect and report the absence as
// whatever that produced downstream, several frames from the cause.
const queryOf = (context: ReturnType<typeof createCardanoHandlerContext>) => {
  const {query} = context
  if (query === undefined) throw new Error('createCardanoHandlerContext wired no query surface')
  return query
}

describe('createCardanoHandlerContext — CIP-139 wiring', () => {
  it('hands the handler a query surface built from the rail`s provider', async () => {
    const context = createCardanoHandlerContext(rail())
    expect(context.query).toBeDefined()
    // Proof it is the RAIL's provider and not an empty shell: the stub's UTxO comes back,
    // encoded as CIP-116 with the inline datum carried both ways.
    // A decoded address, as the handler hands it over: the fork's query layer takes domain
    // values and the wire decode happens at the handler boundary.
    const [utxo] = await Effect.runPromise(queryOf(context).getUtxosByAddress(EvAddress.fromBech32(ADDRESS)))
    expect(utxo?.input).toEqual({transaction_id: TX, index: 0})
    expect(utxo?.output.datum_hex).toBe(DATUM)
    expect(utxo?.output.plutus_data).toEqual({
      tag: 'datum',
      value: {
        tag: 'constr',
        alternative: '0',
        data: [
          {tag: 'integer', value: '1'},
          {tag: 'bytes', value: 'cafe'},
        ],
      },
    })
  })

  it('serves the experimental tip, which CIP-139 has no operation for', async () => {
    const context = createCardanoHandlerContext(rail())
    // The block hash comes through too: a slot is reused after a rollback, the hash is not.
    expect(await Effect.runPromise(queryOf(context).tip)).toEqual({
      slot: 42,
      epoch: 7,
      blockHash: 'ab'.repeat(32),
    })
  })

  it('a chain read the backend cannot answer fails as InternalError, reason intact', async () => {
    // The reason names the missing provider member — the difference between a debuggable
    // report and "something went wrong".
    const context = createCardanoHandlerContext(rail())
    const error = await Effect.runPromise(Effect.flip(queryOf(context).getAllPools()))
    expect(error.code).toBe(-2)
    expect(error.message).toContain('ProviderEffect.getPools')
  })
})

/**
 * The CIP-30 address surface: what a dApp is told the wallet holds.
 *
 * These are the assertions this file should have carried since 2026-07-13. On that day
 * the rail gained `knownAddresses` two and a half hours after this context was written,
 * every other path adopted it, and the context kept answering with the single address an
 * account had when it was authored. Nothing here failed, because nothing here looked.
 *
 * Found from outside: a NIGHT-redeem dApp scanned a wallet, was handed exactly one
 * address, and reported no allocation for a wallet that held a redeemable one on a
 * discovered address.
 */
describe('createCardanoHandlerContext — CIP-30 addresses', () => {
  const ACCOUNT_HEX = '00'.repeat(29)
  /**
   * ⚠️ The REAL decoder, where a stand-in used to return `hex:${bech32}`.
   *
   * What this file tests is WHICH addresses get served and in what order, not how an address is
   * encoded — so deriving the expectation with the same function production uses is not a
   * tautology, it is holding the subject still. The stand-in stopped being reached when
   * `dapp-context` started calling the address tier directly, and a test whose fake is no longer
   * consulted asserts nothing.
   */
  const hexOf = (bech32: string) => Address.fromBech32Sync(Bech32(bech32))

  const railWith = (utxos: readonly {readonly address: string}[] = []): CardanoRail =>
    ({
      ...rail(),
      dataRef: {groupId: 'g1', chainId: 'cardano:preprod', accountIndex: 0},
      // ⚠️ Real UTxOs, not object literals behind the rail's `as unknown as` cast. The old
      // fixtures were the wallet shape, which the cast let through while every read of
      // `utxo.address` got a string where an `Address` was expected.
      spendableUtxos: Effect.succeed(utxos.map((u) => testUtxo({txHash: 0, address: u.address, lovelace: 1n}))),
    }) as unknown as CardanoRail

  /** Binds a fake address table for the duration of one assertion. */
  const withRows = async <A>(rows: readonly {human: string; isUsed: boolean}[], run: () => Promise<A>): Promise<A> => {
    setCardanoDataStore({
      listAddresses: (q: {readonly isUsed?: boolean}) =>
        Effect.succeed(rows.filter((r) => q.isUsed === undefined || r.isUsed === q.isUsed)),
    } as never)
    try {
      return await run()
    } finally {
      setCardanoDataStore(null as never)
    }
  }

  it('reports every used external address, not only the account`s own', async () => {
    await withRows(
      [
        {
          human:
            'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
          isUsed: true,
        },
        {human: 'addr_test1vzpwq95z3xyum8vqndgdd9mdnmafh3djcxnc6jemlgdmswcve6tkw', isUsed: true},
        {
          human:
            'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
          isUsed: false,
        },
      ],
      async () => {
        const used = await Effect.runPromise(createCardanoHandlerContext(railWith()).usedAddressHexes)
        expect(used).toEqual([
          hexOf(
            'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
          ),
          hexOf('addr_test1vzpwq95z3xyum8vqndgdd9mdnmafh3djcxnc6jemlgdmswcve6tkw'),
        ])
      },
    )
  })

  it('keeps used and unused apart — a dApp asking for a fresh address must get an unused one', async () => {
    await withRows(
      [
        {
          human:
            'addr_test1qp8wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqnle9hh',
          isUsed: true,
        },
        {
          human:
            'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
          isUsed: false,
        },
      ],
      async () => {
        const unused = await Effect.runPromise(createCardanoHandlerContext(railWith()).unusedAddressHexes)
        expect(unused).toEqual([
          hexOf(
            'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
          ),
        ])
      },
    )
  })

  it('falls back to the account address when the table holds nothing, never to an empty used list', async () => {
    await withRows([], async () => {
      const used = await Effect.runPromise(createCardanoHandlerContext(railWith()).usedAddressHexes)
      expect(used).toEqual([ACCOUNT_HEX])
    })
  })

  it('reports each UTxO at its own address, not at the account`s', async () => {
    // A dApp balancing against a coin held on a discovered address computed its inputs
    // and change for an address the wallet does not hold that coin at.
    const context = createCardanoHandlerContext(
      railWith([
        {
          address:
            'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w',
        },
      ]),
    )
    const utxos = await Effect.runPromise(context.utxos)
    expect(utxos.map((u) => u.addressHex)).toEqual([
      hexOf(
        'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w',
      ),
    ])
  })
})
