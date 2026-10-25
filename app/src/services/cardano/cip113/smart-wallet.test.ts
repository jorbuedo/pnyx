import {Cip113, Deployment as Cip113Deployment} from '@evolution-sdk/cip113'
import {Assets} from '@evolution-sdk/evolution'
import {Bech32, PlutusDataHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {ownSmartWalletBech32, readProgrammableHoldings, smartWalletLocation} from './smart-wallet'

/**
 * The 12-word `abandon … about` wallet's CIP-1852 account-0 stake credential, `m/1852'/1815'/0'/2/0`.
 *
 * ⚠️ Say which abandon wallet. There are at least four valid all-`abandon` mnemonics (12/`about`,
 * 15/`address`, 18/`agent`, 24/`art`) and they derive entirely different keys with no error.
 */
const OUR_STAKE = 'e557890352095f1cf6fd2b7d1a28e3c3cb029f48cf34ff890a28d176'

/**
 * The address that account's programmable tokens sit at under the live preview deployment.
 *
 * Pinned as a literal because it is the one thing the whole feature turns on: derive it wrongly and
 * the wallet watches an address that is empty for a reason that has nothing to do with the user.
 * Cross-checked against an independent derivation before being written down, and it must be
 * re-derived rather than adjusted if it ever fails.
 *
 * RE-DERIVED 2026-10-07 for CF's preview bootstrap of 2026-10-02 (`cf-preview-2026-10-02`). The PLB
 * moved, so every smart-wallet address moved with it — this test failing on a redeploy is the
 * intended behaviour, not a nuisance. Derived with a bech32 implementation outside this codebase,
 * which reproduced the previous instance's pinned literal (`…qqt65k3`, under PLB `fed8a46e…`) before
 * being trusted for this one: header 0x10 (script payment + key stake), payment credential
 * `35622813…` = the record's PLB, stake credential = `OUR_STAKE`.
 */
const EXPECTED_SMART_WALLET =
  'addr_test1zq6ky2qnmqd694hqdrra2tm0mt2652jasjep9mp79pckc9h927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqdnu3y3'

const DEPLOYMENT = Cip113Deployment.CF_PREVIEW_2026_10_02
/** Preview's CIP-142 magic — the chain `DEPLOYMENT` was bootstrapped on. */
const PREVIEW_MAGIC = 2

beforeAll(async () => {})

describe('smartWalletLocation', () => {
  it('pairs the deployment PLB with the account stake credential', () => {
    const location = smartWalletLocation(DEPLOYMENT, OUR_STAKE)
    expect(location.addressBech32).toBe(EXPECTED_SMART_WALLET)
    expect(location.owner).toEqual({kind: 'key', hashHex: OUR_STAKE})
  })

  it('produces a script payment credential over a key stake credential', () => {
    // The shape is the whole point: address enumeration cannot find this, and the watch-only
    // key-credential gate deliberately excludes it until the balance partition lands.
    const location = smartWalletLocation(DEPLOYMENT, OUR_STAKE)
    const info = Address.inspect(Address.fromBech32Sync(Bech32(location.addressBech32)))
    expect(info.paymentIsScript).toBe(true)
    expect(info.paymentCredHex).toBe(DEPLOYMENT.plbScriptHashHex)
    expect(info.stakeIsScript).not.toBe(true)
    expect(info.stakeCredHex).toBe(OUR_STAKE)
  })

  it('follows the deployment rather than a remembered hash', () => {
    // A redeploy moves the PLB, and preview has already done it once. If this ever stops changing
    // with the record, something has hardcoded the address and every holder sees an empty wallet.
    const moved = {...DEPLOYMENT, plbScriptHashHex: 'ab'.repeat(28)}
    expect(smartWalletLocation(moved, OUR_STAKE).addressBech32).not.toBe(EXPECTED_SMART_WALLET)
  })

  it('gives different accounts different smart wallets', () => {
    const other = smartWalletLocation(DEPLOYMENT, 'cd'.repeat(28))
    expect(other.addressBech32).not.toBe(EXPECTED_SMART_WALLET)
  })
})

describe('readProgrammableHoldings', () => {
  const holding = (index: number) => ({
    txHash: TxHashHex('aa'.repeat(32)),
    index,
    assets: Assets.fromLovelace(2_000_000n),
    owner: {kind: 'key' as const, hashHex: OUR_STAKE},
  })

  const withQuery = (query: Partial<Cip113.Query>) =>
    Layer.succeed(Cip113.QueryTag, {
      registryNodes: Effect.succeed([]),
      protocolParams: Effect.die('not used'),
      smartWalletUtxos: () => Effect.succeed([]),
      ...query,
    } as Cip113.Query)

  it('returns the account holdings in the app shape', async () => {
    const result = await Effect.runPromise(
      readProgrammableHoldings(smartWalletLocation(DEPLOYMENT, OUR_STAKE)).pipe(
        Effect.provide(withQuery({smartWalletUtxos: () => Effect.succeed([holding(0), holding(1)])})),
      ),
    )
    expect(result).toEqual([
      {txHash: TxHashHex('aa'.repeat(32)), index: 0, assets: Assets.fromLovelace(2_000_000n)},
      {txHash: TxHashHex('aa'.repeat(32)), index: 1, assets: Assets.fromLovelace(2_000_000n)},
    ])
  })

  it('asks the query for this account, not for the address', async () => {
    // The seam is keyed on the stake credential; passing the bech32 would silently return nothing.
    let asked: Cip113.Credential | null = null
    await Effect.runPromise(
      readProgrammableHoldings(smartWalletLocation(DEPLOYMENT, OUR_STAKE)).pipe(
        Effect.provide(
          withQuery({
            smartWalletUtxos: (owner) => {
              asked = owner
              return Effect.succeed([])
            },
          }),
        ),
      ),
    )
    expect(asked).toEqual({kind: 'key', hashHex: OUR_STAKE})
  })

  it('propagates a query failure instead of reporting an empty wallet', async () => {
    // "No tokens" and "we could not ask" must not render alike — the second one would tell a
    // holder their tokens are gone during an outage.
    const exit = await Effect.runPromiseExit(
      readProgrammableHoldings(smartWalletLocation(DEPLOYMENT, OUR_STAKE)).pipe(
        Effect.provide(
          withQuery({smartWalletUtxos: () => Effect.fail(new Cip113.QueryError({reason: 'indexer down'}))}),
        ),
      ),
    )
    expect(exit._tag).toBe('Failure')
  })

  it('carries a datum through when there is one', async () => {
    const result = await Effect.runPromise(
      readProgrammableHoldings(smartWalletLocation(DEPLOYMENT, OUR_STAKE)).pipe(
        Effect.provide(
          withQuery({smartWalletUtxos: () => Effect.succeed([{...holding(0), datumHex: PlutusDataHex('d87980')}])}),
        ),
      ),
    )
    expect(result[0]).toMatchObject({datumHex: 'd87980'})
  })
})

describe('ownSmartWalletBech32', () => {
  it('resolves the account own smart wallet on a chain that has a deployment', () => {
    expect(ownSmartWalletBech32({protocolMagic: PREVIEW_MAGIC, stakeKeyHashHex: OUR_STAKE})).toBe(EXPECTED_SMART_WALLET)
  })

  // Three different absences, all of which must read as "no address" rather than as an error: no
  // deployment shipped for the chain, and no stake credential to build one over.
  it('is null on a chain with no shipped deployment', () => {
    // Mainnet was this example until CF bootstrapped it on 2026-10-06. An invented magic keeps the
    // absence path covered; `resolves on mainnet` below covers the chain that now has a record.
    expect(ownSmartWalletBech32({protocolMagic: 999_999, stakeKeyHashHex: OUR_STAKE})).toBeNull()
  })

  it('resolves on mainnet, over the mainnet PLB and with a mainnet address header', () => {
    const addr = ownSmartWalletBech32({
      protocolMagic: Cip113Deployment.MAINNET_MAGIC,
      stakeKeyHashHex: OUR_STAKE,
    })
    expect(addr).not.toBeNull()
    // Asserting the prefix and the credential rather than a literal: the literal belongs to the one
    // address this file pins, and a second pinned string is a second thing to re-derive per redeploy.
    expect(addr?.startsWith('addr1')).toBe(true)
    const info = Address.inspect(Address.fromBech32Sync(Bech32(addr as string)))
    expect(info.paymentCredHex).toBe(Cip113Deployment.CF_MAINNET_2026_10_06.plbScriptHashHex)
    expect(info.stakeCredHex).toBe(OUR_STAKE)
  })

  // Preview and preprod are both `Network.Testnet`. Selecting on the address header would return
  // preview's address here, and the holder would watch a wallet on the wrong chain.
  it('gives preprod a different address from preview', () => {
    const preprod = ownSmartWalletBech32({protocolMagic: 1, stakeKeyHashHex: OUR_STAKE})
    expect(preprod).not.toBeNull()
    expect(preprod).not.toBe(EXPECTED_SMART_WALLET)
  })

  it('is null for an account with no stake credential', () => {
    expect(ownSmartWalletBech32({protocolMagic: PREVIEW_MAGIC, stakeKeyHashHex: null})).toBeNull()
  })

  // The address this returns is added to the history producer's own-address set, which is what makes
  // a mint into our own smart wallet show up as ours. Agreeing with `smartWalletLocation` is
  // therefore not a tautology worth skipping: two callers deriving different addresses is exactly
  // how the portfolio and the activity list came to disagree.
  it('agrees with smartWalletLocation', () => {
    expect(ownSmartWalletBech32({protocolMagic: PREVIEW_MAGIC, stakeKeyHashHex: OUR_STAKE})).toBe(
      smartWalletLocation(DEPLOYMENT, OUR_STAKE).addressBech32,
    )
  })
})
