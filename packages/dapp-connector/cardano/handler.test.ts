import {Account as EvAccount, Connector as EvConnector} from '@evolution-sdk/cip30'
import {
  Address as EvAddress,
  Assets as EvAssets,
  Bip32PrivateKey as EvBip32PrivateKey,
  DatumOption as EvDatumOption,
  NonnegativeInterval as EvNonnegativeInterval,
  Provider as EvolutionProvider,
  ProtocolVersion as EvProtocolVersion,
  TransactionHash as EvTransactionHash,
  UnitInterval as EvUnitInterval,
  UTxO as EvUTxO,
} from '@evolution-sdk/evolution'
import * as MockDefaults from '@evolution-sdk/evolution/sdk/provider/Mock'
import {MockProvider} from '@evolution-sdk/evolution/sdk/provider/Mock'
import * as ReviewDecode from '@evolution-sdk/review/Decode'
import {Address, Keys, Wallet} from '@pnyx/cardano-core'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {createResolver} from '../resolver.js'
import type {DappMessage, WalletResponse} from '../types.js'
import {WireError} from '../types.js'
import {type CardanoHandlerContext, type CardanoUtxo, createCardanoHandler} from './handler.js'
import {makeCardanoQueryContext} from './query-context.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ORIGIN = 'https://dapp.example'
const POLICY = 'bb'.repeat(28)
const NAME = '746f6b656e'

type Fixture = {
  readonly addrHex: string
  readonly addrBech: string
  readonly rewardHex: string
  readonly utxos: readonly CardanoUtxo[]
}

let fx: Fixture

beforeAll(async () => {
  fx = await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const addrBech = yield* account.baseAddress(Address.Network.Testnet)
      const addrHex = Address.fromBech32Sync(addrBech)
      const rewardHex = Address.fromBech32Sync(yield* account.rewardAddress(Address.Network.Testnet))
      const utxos: CardanoUtxo[] = [
        {txHashHex: '11'.repeat(32), index: 0, addressHex: addrHex, coin: 5_000_000n, assets: []},
        {
          txHashHex: '22'.repeat(32),
          index: 1,
          addressHex: addrHex,
          coin: 2_000_000n,
          assets: [{policyHex: POLICY, nameHex: NAME, quantity: 3n}],
        },
      ]
      return {addrHex, addrBech, rewardHex, utxos}
    }),
  )
})

const makeContext = (overrides?: Partial<CardanoHandlerContext>): CardanoHandlerContext => ({
  networkId: Effect.succeed(0),
  networkMagic: Effect.succeed(1),
  utxos: Effect.succeed(fx.utxos),
  collateralUtxos: Effect.succeed([fx.utxos[0] as CardanoUtxo]),
  changeAddressHex: Effect.succeed(fx.addrHex),
  usedAddressHexes: Effect.succeed([fx.addrHex]),
  unusedAddressHexes: Effect.succeed([]),
  rewardAddressHexes: Effect.succeed([fx.rewardHex]),
  submitTx: (signedTxHex) => Effect.succeed(`submitted:${signedTxHex.slice(0, 8)}`),
  pubDRepKeyHex: Effect.succeed('dd'.repeat(32)),
  registeredPubStakeKeyHexes: Effect.succeed(['ee'.repeat(32)]),
  unregisteredPubStakeKeyHexes: Effect.succeed([]),
  ...overrides,
})

const message = (method: string, params?: unknown): DappMessage => ({
  id: `m-${method}`,
  chainType: 'cardano',
  method,
  origin: ORIGIN,
  ...(params !== undefined ? {params} : {}),
})

const resolveWith = (
  msg: DappMessage,
  opts?: {connected?: boolean; context?: CardanoHandlerContext},
): Promise<WalletResponse> => {
  const handler = createCardanoHandler(opts?.context ?? makeContext(), () => Effect.succeed(opts?.connected ?? true))
  const resolver = createResolver({handlers: new Map([['cardano', handler]])})
  return Effect.runPromise(resolver.resolve(msg))
}

const sentinelOf = (msg: DappMessage, opts?: {connected?: boolean}) => {
  const handler = createCardanoHandler(makeContext(), () => Effect.succeed(opts?.connected ?? true))
  const resolver = createResolver({handlers: new Map([['cardano', handler]])})
  return Effect.runPromise(Effect.flip(resolver.resolve(msg)))
}

/**
 * The fork's CIP-30 connector over the same UTxOs, as the byte-for-byte reference these two
 * tests compare the handler against.
 *
 * ⚠️ The reference is the PUBLISHED connector now, not a local one. It takes its provider as an
 * argument and speaks Evolution's `ProviderEffect`, so the mock provider is presented in that
 * shape — the same adapter production uses, which is what makes this a comparison and not a
 * parallel implementation of the encoding under test.
 */
const referenceConnector = async () => {
  // The same fixture UTxOs, as the chain's own rows.
  const chainUtxos = fx.utxos.map(
    (u) =>
      new EvUTxO.UTxO({
        transactionId: EvTransactionHash.fromHex(u.txHashHex),
        index: BigInt(u.index),
        address: EvAddress.fromBech32(fx.addrBech),
        assets: u.assets.reduce(
          (acc, a) => EvAssets.addByHex(acc, a.policyHex, a.nameHex, a.quantity),
          EvAssets.fromLovelace(u.coin),
        ),
      }),
  )
  const entropy = await Effect.runPromise(Keys.mnemonicToEntropy(MNEMONIC))
  const account = EvAccount.fromRoot(
    EvBip32PrivateKey.fromBip39Entropy(
      Uint8Array.from(entropy.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []),
      '',
    ),
    0,
  )
  return EvConnector.make(account, new MockProvider({utxos: chainUtxos}).effect, 0)
}

describe('createCardanoHandler — wire encodings', () => {
  it('getUtxos matches the reference connector byte-for-byte', async () => {
    const reference = await referenceConnector()
    const expected = await Effect.runPromise(reference.getUtxos())
    const response = await resolveWith(message('getUtxos'))
    expect(response.result).toEqual(expected)
  })

  it('getBalance matches the reference connector byte-for-byte', async () => {
    const reference = await referenceConnector()
    const expected = await Effect.runPromise(reference.getBalance())
    const response = await resolveWith(message('getBalance'))
    expect(response.result).toEqual(expected)
  })

  it('address methods return the raw hex wire form', async () => {
    expect((await resolveWith(message('getChangeAddress'))).result).toBe(fx.addrHex)
    expect((await resolveWith(message('getUsedAddresses'))).result).toEqual([fx.addrHex])
    expect((await resolveWith(message('getRewardAddresses'))).result).toEqual([fx.rewardHex])
    expect((await resolveWith(message('getUnusedAddresses'))).result).toEqual([])
  })

  it('getNetworkId / cip142_getNetworkMagic / getExtensions', async () => {
    expect((await resolveWith(message('getNetworkId'))).result).toBe(0)
    expect((await resolveWith(message('cip142_getNetworkMagic'))).result).toBe(1)
    expect((await resolveWith(message('getExtensions'))).result).toEqual([{cip: 95}, {cip: 142}])
  })

  it('CIP-95 getters pass through', async () => {
    expect((await resolveWith(message('cip95_getPubDRepKey'))).result).toBe('dd'.repeat(32))
    expect((await resolveWith(message('cip95_getRegisteredPubStakeKeys'))).result).toEqual(['ee'.repeat(32)])
    expect((await resolveWith(message('cip95_getUnregisteredPubStakeKeys'))).result).toEqual([])
  })

  it('submitTx forwards to the context', async () => {
    const response = await resolveWith(message('submitTx', {tx: 'deadbeef'}))
    expect(response.result).toBe('submitted:deadbeef')
  })
})

describe('createCardanoHandler — getUtxos amount + paginate', () => {
  it('filters with a decimal lovelace amount', async () => {
    const response = await resolveWith(message('getUtxos', {amount: '4000000'}))
    expect(Array.isArray(response.result)).toBe(true)
    expect((response.result as string[]).length).toBe(1)
  })

  it('returns null when the amount cannot be covered', async () => {
    const response = await resolveWith(message('getUtxos', {amount: '99000000'}))
    expect(response.result).toBeNull()
  })

  it('rejects a malformed amount as InvalidRequest (-1)', async () => {
    const response = await resolveWith(message('getUtxos', {amount: 'zz'}))
    expect(response.error?.code).toBe(-1)
  })

  it('paginates and reports maxSize when out of range', async () => {
    const paged = await resolveWith(message('getUtxos', {paginate: {page: 0, limit: 1}}))
    expect((paged.result as string[]).length).toBe(1)
    const outOfRange = await resolveWith(message('getUtxos', {paginate: {page: 5, limit: 1}}))
    expect(outOfRange.error?.code).toBe(-1)
    expect(outOfRange.error?.data).toEqual({maxSize: 2})
  })
})

describe('createCardanoHandler — collateral', () => {
  it('returns collateral UTxOs', async () => {
    const response = await resolveWith(message('getCollateral'))
    expect((response.result as string[]).length).toBe(1)
  })

  it('fails InternalError (-2) when collateral cannot cover the requested amount', async () => {
    const response = await resolveWith(message('getCollateral', {amount: '99000000'}))
    expect(response.error?.code).toBe(-2)
  })
})

describe('createCardanoHandler — sentinels + connection gating', () => {
  it('enable fails ConnectionRequired when not connected, true when connected', async () => {
    const sentinel = await sentinelOf(message('enable'), {connected: false})
    expect(sentinel._tag).toBe('ConnectionRequired')
    const response = await resolveWith(message('enable'), {connected: true})
    expect(response.result).toBe(true)
  })

  it('isEnabled reflects the session without a sentinel', async () => {
    expect((await resolveWith(message('isEnabled'), {connected: false})).result).toBe(false)
    expect((await resolveWith(message('isEnabled'), {connected: true})).result).toBe(true)
  })

  it('signTx fails SignTxRequired with tx + partialSign', async () => {
    const sentinel = await sentinelOf(message('signTx', {tx: 'abcd', partialSign: true}))
    expect(sentinel._tag).toBe('SignTxRequired')
    if (sentinel._tag !== 'SignTxRequired') return
    expect(sentinel.txHex).toBe('abcd')
    expect(sentinel.partialSign).toBe(true)
    expect(sentinel.origin).toBe(ORIGIN)
  })

  it('signData / cip95_signData fail SignDataRequired', async () => {
    for (const method of ['signData', 'cip95_signData']) {
      const sentinel = await sentinelOf(message(method, {addr: '00ab', payload: 'ff'}))
      expect(sentinel._tag).toBe('SignDataRequired')
      if (sentinel._tag !== 'SignDataRequired') return
      expect(sentinel.addressHex).toBe('00ab')
      expect(sentinel.payloadHex).toBe('ff')
    }
  })

  it('data methods refuse (-3) when not connected', async () => {
    const response = await resolveWith(message('getBalance'), {connected: false})
    expect(response.error?.code).toBe(-3)
  })

  it('signTx without a tx is InvalidRequest, not a sentinel', async () => {
    const response = await resolveWith(message('signTx', {}))
    expect(response.error?.code).toBe(-1)
  })
})

describe('createResolver — routing', () => {
  it('unknown method → InvalidRequest', async () => {
    const response = await resolveWith(message('walletconnect_magic'))
    expect(response.error?.code).toBe(-1)
  })

  it('context wire errors surface with their code', async () => {
    const response = await resolveWith(message('getNetworkId'), {
      context: makeContext({networkId: Effect.fail(new WireError({code: -2, message: 'backend down'}))}),
    })
    expect(response.error).toEqual({code: -2, message: 'backend down'})
  })

  it('defects fold into InternalError and hit onDefect', async () => {
    const handler = createCardanoHandler(
      makeContext({
        networkId: Effect.die(new Error('boom')),
      }),
      () => Effect.succeed(true),
    )
    const defects: unknown[] = []
    const resolver = createResolver({
      handlers: new Map([['cardano', handler]]),
      onDefect: (defect) => defects.push(defect),
    })
    const response = await Effect.runPromise(resolver.resolve(message('getNetworkId')))
    expect(response.error?.code).toBe(-2)
    expect(defects).toHaveLength(1)
  })
})

// ── CIP-139 Universal Query Layer ───────────────────────────────────────────────
// These drive the REAL library query layer over a stub Provider, so the assertions
// cover the whole path a dApp sees: JSON-RPC params → handler → the Cardano tiers →
// CIP-116 JSON. A hand-rolled fake context would have proved only the plumbing.
describe('createCardanoHandler — CIP-139', () => {
  const DATUM = 'd8799f0142cafeff' // constr 0 [1, h'cafe'], indefinite-length
  const TXH = 'ab'.repeat(32)

  /** No assertion reads this account; the member has to EXIST, which is the point. */
  const STAKE_BECH = 'stake_test1uqevw2xnsc0pvn9t9r9c7qryfqfeerchgrlm3ea2nefr9hqp8n5xl'

  /** The credential the two credential queries ask about, as an enterprise address. */
  const CRED_HEX = 'aa'.repeat(28)
  const CRED_ADDRESS = EvAddress.toBech32(EvAddress.fromHex(`60${CRED_HEX}`))

  /**
   * The chain these tests drive the real CIP-139 query layer over.
   *
   * ⚠️ **Evolution's `MockProvider`, which is a LEDGER.** Every row below answers a specific
   * assertion, and the answers are derived from the one ledger rather than written per member:
   * the stub this replaced declared `utxosAt`, `utxosByAsset`, `utxosByPaymentCredential`,
   * `accountUtxos` and `utxosOfTx` as five independent functions, so they could disagree about
   * what the chain holds and nothing would notice.
   *
   * ⚠️ The parameter and governance tiers are SEEDED, because those are facts a ledger does not
   * imply — and seeding is what makes each member exist, which is the property the "does not
   * serve the operations at all when unwired" test turns on.
   */
  const chain = (utxos: ReadonlyArray<EvUTxO.UTxO>) =>
    Layer.succeed(
      EvolutionProvider.ProviderEffect,
      new MockProvider({
        utxos: [...utxos],
        tip: {slot: 92_000_000, blockHash: 'ab'.repeat(32), epoch: 304},
        // ⚠️ `getAccountUtxos` and all FOUR vote roles are in `cip139`'s own
        // `QUERY_LAYER_MEMBERS`, which the extension will not advertise without — so these
        // seeds are load-bearing even where no assertion reads their content. The surface to
        // enumerate is the CONSUMER's required list, not the calls the tests happen to make.
        accountUtxos: {[STAKE_BECH]: []},
        chainParameters: CHAIN_PARAMS,
        protocolParametersByEpoch: {300: {...MockDefaults.defaultProtocolParameters, minFeeA: 40}},
        dreps: [{drepId: 'drep1x', active: true, amount: 5n}],
        committee: [{coldId: 'cc_cold1a', hotId: 'cc_hot1a', status: 'authorized'}],
        pools: [{poolId: 'pool1x', status: 'registered', activeStake: 10n, liveStake: 11n}],
        proposals: [{proposalId: 'gov_action1x', expiration: 372}],
        votes: {
          byDRep: {drep1x: [{proposalId: 'gov_action1x', voteTxHash: TXH, vote: 'Yes'}]},
          byPool: {pool1x: [{proposalId: 'gov_action1x', voteTxHash: TXH, vote: 'No'}]},
          byCommittee: {cc_hot1a: [{proposalId: 'gov_action1x', voteTxHash: TXH, vote: 'Abstain'}]},
          byProposal: {gov_action1x: [{proposalId: 'gov_action1x', voteTxHash: TXH, vote: 'Yes'}]},
        },
      }).effect,
    )

  /**
   * The CIP-139 parameter document's own shape, as a value.
   *
   * ⚠️ Not built by calling a provider's cli-params mapper: that made the fixture depend on the
   * very mapping the handler is supposed to be independent of. The thresholds are exact
   * rationals because a rational read as a double loses the meaning it had.
   */
  const ratio = (numerator: bigint, denominator: bigint) => new EvUnitInterval.UnitInterval({numerator, denominator})

  const CHAIN_PARAMS: EvolutionProvider.ChainParameters = {
    poolVotingThresholds: Array.from({length: 5}, () => ratio(51n, 100n)),
    drepVotingThresholds: (
      [
        [67n, 100n],
        [67n, 100n],
        [3n, 5n],
        [3n, 4n],
        [3n, 5n],
        [67n, 100n],
        [67n, 100n],
        [67n, 100n],
        [3n, 4n],
        [67n, 100n],
      ] as const
    ).map(([n, d]) => ratio(n, d)),
    committeeMinSize: 3,
    committeeMaxTermLength: 146,
    govActionLifetime: 6,
    govActionDeposit: 1_000_000_000n,
    drepActivity: 20,
    maxBlockBodySize: 90_112,
    maxBlockHeaderSize: 1_100,
    poolRetireMaxEpoch: 18,
    stakePoolTargetNum: 500,
    poolPledgeInfluence: EvNonnegativeInterval.fromDecimal(0.3),
    monetaryExpansion: ratio(3n, 1000n),
    treasuryCut: ratio(1n, 5n),
    minPoolCost: 170_000_000n,
    maxTxExMem: 16_500_000n,
    maxTxExSteps: 10_000_000_000n,
    maxBlockExMem: 72_000_000n,
    maxBlockExSteps: 20_000_000_000n,
    protocolVersion: new EvProtocolVersion.ProtocolVersion({major: 11n, minor: 0n}),
    executionPrices: {
      mem: EvNonnegativeInterval.fromDecimal('0.0577'),
      step: EvNonnegativeInterval.fromDecimal('0.0000721'),
    },
    minFeeRefScriptCostPerByte: EvNonnegativeInterval.fromDecimal('15'),
  }

  /** The rows every assertion below reads, each one answering a specific query. */
  const LEDGER = (): ReadonlyArray<EvUTxO.UTxO> => [
    // `cip139_getUtxosByAddress` + the inline-datum assertions.
    new EvUTxO.UTxO({
      transactionId: EvTransactionHash.fromHex(TXH),
      index: 0n,
      address: EvAddress.fromBech32(fx.addrBech),
      assets: EvAssets.fromLovelace(2_000_000n),
      // ⚠️ Through the real DECODER: CIP-139 emits `datum_hex` only when the provider preserved
      // the original bytes, and constructing `InlineDatum` directly records none — so the
      // `datum_hex` assertion would have had nothing to compare and passed on `undefined`.
      datumOption: EvDatumOption.fromCBORHex(`8201d81848${DATUM}`),
    }),
    // `cip139_getUtxosByAsset` AND both credential shapes, from one row: an enterprise address
    // whose payment credential is the hash those queries ask about, holding the asset.
    new EvUTxO.UTxO({
      transactionId: EvTransactionHash.fromHex(TXH),
      index: 5n,
      address: EvAddress.fromBech32(CRED_ADDRESS),
      assets: EvAssets.addByHex(EvAssets.fromLovelace(5n), POLICY, '4e49474854', 1n),
    }),
  ]

  const withQuery = (utxos: ReadonlyArray<EvUTxO.UTxO> = LEDGER()) =>
    makeContext({query: makeCardanoQueryContext(Layer.merge(chain(utxos), ReviewDecode.layer))})

  it('advertises {cip:139} only when the host wired the chain reads', async () => {
    const without = await resolveWith(message('getExtensions'))
    expect(without.result).toEqual([{cip: 95}, {cip: 142}])
    const with139 = await resolveWith(message('getExtensions'), {context: withQuery()})
    expect(with139.result).toEqual([{cip: 95}, {cip: 142}, {cip: 139}])
  })

  it('does not serve the operations at all when unwired', async () => {
    const response = await resolveWith(message('cip139_getUtxosByAddress', fx.addrBech))
    expect(response.error?.code).toBe(-1) // unknown method, not a silent empty result
  })

  it('serves a UTxO as CIP-116 JSON, inline datum both ways', async () => {
    const response = await resolveWith(message('cip139_getUtxosByAddress', fx.addrBech), {context: withQuery()})
    const utxos = response.result as {input: {index: number}; output: Record<string, unknown>}[]
    expect(utxos).toHaveLength(1)
    expect(utxos[0]?.input).toEqual({transaction_id: TXH, index: 0})
    expect(utxos[0]?.output.address).toBe(fx.addrBech)
    expect(utxos[0]?.output.amount).toEqual({coin: '2000000'})
    // the CIP-116 tree...
    expect(utxos[0]?.output.plutus_data).toEqual({
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
    // ...and the original bytes, which the tree cannot reproduce byte-for-byte
    expect(utxos[0]?.output.datum_hex).toBe(DATUM)
  })

  it('decodes each request shape the CIP defines', async () => {
    const ctx = withQuery()
    const asset = await resolveWith(
      message('cip139_getUtxosByAsset', {asset_name: '4e49474854', minting_policy_hash: POLICY}),
      {context: ctx},
    )
    expect((asset.result as unknown[]).length).toBe(1)
    // a CIP-116 Credential object {tag, value}
    const cred = await resolveWith(
      message('cip139_getUtxosByPaymentCredential', {tag: 'pubkey_hash', value: 'aa'.repeat(28)}),
      {context: ctx},
    )
    expect((cred.result as unknown[]).length).toBe(1)
    // ...and a bare hex hash, which is what a hand-rolled caller reaches for
    const credBare = await resolveWith(message('cip139_getUtxosByPaymentCredential', 'aa'.repeat(28)), {context: ctx})
    expect((credBare.result as unknown[]).length).toBe(1)
    const epoch = await resolveWith(message('cip139_getProtocolParametersByEpoch', 300), {context: ctx})
    expect((epoch.result as {minfee_a: string}).minfee_a).toBe('40')
  })

  it('rejects malformed params with InvalidRequest rather than guessing', async () => {
    const ctx = withQuery()
    for (const [method, params] of [
      ['cip139_getUtxosByAddress', 42],
      ['cip139_getUtxosByAsset', {asset_name: 'ab'}],
      ['cip139_getProtocolParametersByEpoch', 'latest'],
      ['cip139_getProtocolParametersByEpoch', -1],
      ['experimental_resolveOutpoints', [{txHash: TXH}]],
    ] as const) {
      const response = await resolveWith(message(method, params), {context: ctx})
      expect(response.error?.code, `${method} ${JSON.stringify(params)}`).toBe(-1)
    }
  })

  it('translates the three enums the CIP and Koios spell differently', async () => {
    const ctx = withQuery()
    const cc = await resolveWith(message('cip139_getAllCommitteeMembers'), {context: ctx})
    expect((cc.result as {status: string}[])[0]?.status).toBe('authorised') // not `authorized`
    const pools = await resolveWith(message('cip139_getAllPools'), {context: ctx})
    expect((pools.result as {status: string}[])[0]?.status).toBe('active') // not `registered`
    const votes = await resolveWith(message('cip139_getVotesByDrepId', 'drep1x'), {context: ctx})
    expect((votes.result as {vote: string}[])[0]?.vote).toBe('yes') // not `Yes`
  })

  it('serves protocol parameters with exact rationals and ordered thresholds', async () => {
    const response = await resolveWith(message('cip139_getProtocolParametersByLatest'), {context: withQuery()})
    const params = response.result as {
      execution_costs: {mem_price: {numerator: string; denominator: string}}
      pool_voting_thresholds: unknown[]
      drep_voting_thresholds: unknown[]
    }
    expect(params.execution_costs.mem_price).toEqual({numerator: '577', denominator: '10000'})
    expect(params.pool_voting_thresholds).toHaveLength(5)
    expect(params.drep_voting_thresholds).toHaveLength(10)
  })

  it('serves the two gap fillers under `experimental`, not as CIP-139 surface', async () => {
    // ⚠️ Its own ledger, holding `TXH#1` and NOT `TXH#0`, because the assertion below is about
    // which outpoints come back: a ledger that holds both would answer both.
    const ctx = withQuery([
      new EvUTxO.UTxO({
        transactionId: EvTransactionHash.fromHex(TXH),
        index: 1n,
        address: EvAddress.fromBech32(fx.addrBech),
        assets: EvAssets.fromLovelace(1_000_000n),
      }),
    ])
    // CIP-139 has no chain-tip operation at all, and without the current slot a dApp
    // cannot set a validity interval.
    const tip = await resolveWith(message('experimental_tip'), {context: ctx})
    expect(tip.result).toEqual({slot: 92_000_000, epoch: 304, blockHash: 'ab'.repeat(32)})
    const resolved = await resolveWith(
      message('experimental_resolveOutpoints', [
        {txHash: TXH, index: 0},
        {txHash: TXH, index: 1},
      ]),
      {context: ctx},
    )
    // ⚠️ A SPENT outpoint is ABSENT rather than returned with a flag CIP-116 has no field for:
    // the consumer is a transaction builder, which a consumed output only ever breaks.
    // ⚠️ Here `TXH#0` is absent because the ledger never held it, which is NOT the same reason —
    // `resolveOutRefs` is the member that tells spent from unknown, and this operation reads
    // the filtered one. What is asserted is the filter's effect, not its cause.
    const outs = resolved.result as {input: {index: number}}[]
    expect(outs.map((o) => o.input.index)).toEqual([1])
  })

  it('a backend failure becomes InternalError with the reason kept', async () => {
    // The reason names the endpoint and missing member — the difference between a
    // debuggable report and "something went wrong".
    // ⚠️ The member is removed from an OTHERWISE COMPLETE provider, not omitted from a partial
    // one: `cip139` refuses to advertise the extension at all when a required member is
    // missing, so a provider built without `getPools` would never reach the operation and this
    // would assert nothing.
    const broken = Layer.succeed(EvolutionProvider.ProviderEffect, {
      ...new MockProvider({}).effect,
      ...(await Effect.runPromise(
        Effect.flatMap(EvolutionProvider.ProviderEffect, Effect.succeed).pipe(Effect.provide(chain(LEDGER()))),
      )),
      getPools: undefined,
    } as unknown as EvolutionProvider.ProviderEffect)
    const ctx = makeContext({query: makeCardanoQueryContext(Layer.merge(broken, ReviewDecode.layer))})
    const response = await resolveWith(message('cip139_getAllPools'), {context: ctx})
    expect(response.error?.code).toBe(-2)
    expect(response.error?.message).toContain('ProviderEffect.getPools')
  })

  it('every operation refuses an unconnected origin', async () => {
    const response = await resolveWith(message('cip139_getAllPools'), {connected: false, context: withQuery()})
    expect(response.error?.code).toBe(-3) // Refused
  })
})
