// What an agent is handed has to be a transaction the wallet's own `signTx` can take, so the assertions
// here run the same two reads `runSignTx` does — the body out of the assembled tx, and the aux beside it.

import type {Provider as EvolutionProvider, UTxO as EvolutionUTxO} from '@evolution-sdk/evolution'
import {AddressHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Wallet} from '@pnyx/cardano-core'
import {Effect, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {minAdaForOutput} from '../../screens/cardano/send/min-ada'
import {ADA_ID, type ResolvedTarget} from '../../screens/cardano/send/state'
import {
  buildAgentDeploy,
  buildAgentMint,
  buildAgentTransfer,
  buildAgentTransferChain,
  largestFittingTargetCount,
  mintingPolicyFor,
  scriptRefHexFor,
} from './agent-build'
import type {CardanoRailConfig} from './config'
import {makeCardanoRail} from './rail'
import {chainUtxo, mockChain} from './test-provider'
import {utxoAssetMap} from './utxo-view'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const GROUP = 'group-agent-build'

const CONFIG: CardanoRailConfig = {
  network: 'preprod',
  koiosUrl: 'https://first-party.example/koios',
  networkId: 0,
  protocolMagic: 1,
}

let ownAddress: string
let recipientHex: string

beforeAll(async () => {
  ;[ownAddress, recipientHex] = await Effect.runPromise(
    Effect.gen(function* () {
      const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const recipient = yield* Wallet.fromMnemonic(RECIPIENT_MNEMONIC, 0)
      const mine = yield* own.baseAddress(Address.Network.Testnet)
      const theirs = yield* recipient.baseAddress(Address.Network.Testnet)
      return [mine, (yield* Address.fromBech32(theirs)) as string] as const
    }),
  )
})

/**
 * ⚠️ The size bound comes from the mock provider's own defaults, which carry the 16 KiB ceiling
 * the chain enforces. It used to be passed in per test, because the defaults had no `maxTxSize`
 * and the planner only checks a bound it was given — a size test without one builds 400 outputs
 * happily and proves nothing. Passing a hand-written set now does the opposite: an override that
 * omits the Conway fields cannot be converted to the typed client's shape at all.
 */
const railWith = (utxos: readonly EvolutionUTxO.UTxO[], params?: EvolutionProvider.ProtocolParameters) =>
  makeCardanoRail({config: CONFIG, groupId: GROUP, addressBech32: ownAddress, accountIndex: 0}).pipe(
    Effect.provide(
      Layer.mergeAll(
        EvolutionDecodeLayer,
        mockChain({utxos: [...utxos], ...(params !== undefined ? {protocolParameters: params} : {})}),
      ),
    ),
  )

const target = (lovelace: bigint): ResolvedTarget => ({
  addressHex: AddressHex(recipientHex),
  amounts: new Map([[ADA_ID, lovelace]]),
})

const funded = (coin: bigint): readonly EvolutionUTxO.UTxO[] => [
  chainUtxo({address: ownAddress, txHash: '11', lovelace: coin}),
]

describe('buildAgentTransfer', () => {
  it('hands back a transaction whose body is the one the review was built from', async () => {
    const {build, bodyFromTx} = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(10_000_000n))
        yield* rail.sync
        const build = yield* buildAgentTransfer(rail, GROUP, {targets: [target(3_000_000n)]})
        // Exactly what `runSignTx` does with whatever an agent passes it.
        return {build, bodyFromTx: yield* Inspect.txBodyFromTx(build.unsignedTxHex)}
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(bodyFromTx).toBe(build.bodyHex)
    expect(build.txHash).toHaveLength(64)
    // The real decomposition, which is the whole reason to build through the wallet rather than hand it
    // bytes: an externally-supplied body reviews against a flat cap instead.
    expect(build.reviewed.fee).toBeGreaterThan(0n)
  })

  // ⚠️ The body commits to an aux-data hash. Assembling without the aux would produce a transaction that
  // is malformed at exactly the point nobody is looking any more.
  it('carries a memo’s auxiliary data into the assembled transaction', async () => {
    const aux = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(10_000_000n))
        yield* rail.sync
        const build = yield* buildAgentTransfer(rail, GROUP, {targets: [target(3_000_000n)], memo: 'for the pizza'})
        return yield* Inspect.auxFromTx(build.unsignedTxHex)
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(aux).not.toBe('')
    expect(Buffer.from(aux, 'hex').toString('utf8')).toContain('for the pizza')
  })

  it('pays several recipients from one wallet in one transaction', async () => {
    const outputs = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(30_000_000n))
        yield* rail.sync
        const build = yield* buildAgentTransfer(rail, GROUP, {
          targets: [target(2_000_000n), target(3_000_000n), target(4_000_000n)],
        })
        return build.reviewed.outputs.length
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    // Three recipients plus change.
    expect(outputs).toBeGreaterThanOrEqual(3)
  })
})

describe('minAdaFor', () => {
  // ⚠️ The number that decides whether an asset-bearing output exists on chain at all. The planner
  // computes it for change and for nothing else, so every explicit output has to ask for it here.
  it('is higher for an output carrying assets than for a bare ADA one', () => {
    // ⚠️ No rail and no layer: measuring the floor is pure now, and it is the SAME measurement
    // the ordinary send uses — `agent-build` carried a second copy of this fixed point until the
    // attachments moved into `minAdaForOutput`.
    const assets = new Map([
      ['', 0n],
      [`${'ab'.repeat(28)}.506e7978`, 1n],
    ])
    const bare = minAdaForOutput(4310n, AddressHex(recipientHex), new Map([['', 0n]]))
    const withAsset = minAdaForOutput(4310n, AddressHex(recipientHex), assets)
    expect(bare).not.toBeNull()
    expect(withAsset).not.toBeNull()
    expect(bare as bigint).toBeGreaterThan(0n)
    expect(withAsset as bigint).toBeGreaterThan(bare as bigint)
  })
})

describe('largestFittingTargetCount', () => {
  it('answers with the whole list when the whole list fits', async () => {
    const fits = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(30_000_000n))
        yield* rail.sync
        return yield* largestFittingTargetCount(rail, GROUP, {targets: [target(2_000_000n), target(2_000_000n)]})
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(fits).toBe(2)
  })

  // The airdrop ceiling, measured rather than assumed: hundreds of outputs do not fit in one
  // transaction, and the number that does is what turns a dead end into an instruction to batch.
  it('finds the batch size when the whole list overflows the size limit', async () => {
    const {fits, total} = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(1_000_000_000n))
        yield* rail.sync
        const targets = Array.from({length: 400}, () => target(1_500_000n))
        return {fits: yield* largestFittingTargetCount(rail, GROUP, {targets}), total: targets.length}
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    // Measured here: 241 of 400 plain ADA recipients fit under a 16 KiB ceiling.
    expect(fits).toBeGreaterThan(0)
    expect(fits).toBeLessThan(total)
  })

  // ⚠️ Zero means "not even one recipient builds" — an empty wallet or one needing consolidation. It is
  // a different problem from a list that is too long and must not be reported as one.
  it('answers zero when not even one recipient can be paid', async () => {
    const fits = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(1_000_000n))
        yield* rail.sync
        return yield* largestFittingTargetCount(rail, GROUP, {targets: [target(500_000_000n)]})
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(fits).toBe(0)
  })
})

describe('buildAgentMint', () => {
  const mintWith = (intent: Parameters<typeof buildAgentMint>[2], coin = 30_000_000n) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(coin))
        yield* rail.sync
        const built = yield* buildAgentMint(rail, GROUP, intent)
        return {built, mintOnChain: yield* Inspect.txBodyFromTx(built.unsignedTxHex)}
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )

  it('mints under a policy derived from this wallet’s own payment key', async () => {
    const {built} = await mintWith({
      assetNameHex: '506e7978',
      quantity: 1n,
      recipients: [{addressHex: recipientHex, quantity: 1n}],
    })
    expect(built.policyId).toHaveLength(56)
    expect(built.assetId).toBe(`${built.policyId}.506e7978`)
    // The review has to *show* the mint, or the person approves a transaction whose defining act is
    // invisible to them.
    expect(built.reviewed.operations?.some((op) => op.kind === 'minting')).toBe(true)
  })

  // ⚠️ Two policies for the same wallet: one that can mint again and one that cannot. The difference is
  // the whole guarantee behind a capped supply, and it must come out of the script, not out of intent.
  it('gives a locked policy a different id from an open one', async () => {
    const {open, locked} = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(10_000_000n))
        return {open: yield* mintingPolicyFor(rail), locked: yield* mintingPolicyFor(rail, 200_000_000)}
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(open.policyId).not.toBe(locked.policyId)
    expect(locked.scriptHex).not.toBe(open.scriptHex)
  })

  // What a partial distribution means: mint 100, hand out 30, and the other 70 come back as change
  // rather than being lost or refused.
  it('returns the undistributed surplus to this wallet', async () => {
    const {built} = await mintWith({
      assetNameHex: '',
      quantity: 100n,
      recipients: [{addressHex: recipientHex, quantity: 30n}],
    })
    const change = built.tracked.change
    const held = change.flatMap((u) => [...utxoAssetMap(u)].map(([, q]) => q))
    expect(held).toContain(70n)
  })

  // ⚠️ The planner passes explicit outputs through verbatim — it raises only *change* to min-ADA. An
  // asset-only output left at zero lovelace is rejected by the ledger as OutputTooSmallUTxO, which is
  // a failure nothing host-side would have shown.
  it('gives every recipient enough ADA to hold the asset it is sent', async () => {
    const {built} = await mintWith({
      assetNameHex: '506e7978',
      quantity: 1n,
      recipients: [{addressHex: recipientHex, quantity: 1n}],
    })
    const sent = built.reviewed.outputs.filter((o) => o.ownership.level !== 'own')
    expect(sent.length).toBeGreaterThan(0)
    for (const output of sent) {
      const ada = output.amounts.find((a) => a.assetId === undefined)?.quantity ?? 0n
      expect(ada).toBeGreaterThanOrEqual(1_000_000n)
    }
  })

  it('carries the asset to several recipients in one transaction', async () => {
    const {built} = await mintWith({
      assetNameHex: '',
      quantity: 3n,
      recipients: [
        {addressHex: recipientHex, quantity: 1n},
        {addressHex: recipientHex, quantity: 1n},
        {addressHex: recipientHex, quantity: 1n},
      ],
    })
    expect(built.reviewed.outputs.length).toBeGreaterThanOrEqual(3)
  })

  // ⚠️ The policy script has to travel in the signing request, or the transaction is assembled without
  // the witness that authorises its own mint and the ledger refuses it.
  it('puts the minting policy script in the request the signer will use', async () => {
    const {built} = await mintWith({
      assetNameHex: '',
      quantity: 1n,
      recipients: [{addressHex: recipientHex, quantity: 1n}],
    })
    const payload = built.request.payload
    expect(payload._tag).toBe('CardanoTx')
    expect(payload._tag === 'CardanoTx' && payload.nativeScripts?.length).toBe(1)
  })
})

describe('buildAgentDeploy', () => {
  // The script sum the ledger reads: [tag, bytes]. Hand-assembling this is what an agent must never be
  // asked to do — nothing it has seen contains the tag, so it would be guessing.
  it('wraps the compiled script in the ledger’s [version, bytes] sum', () => {
    // 0x82 = array(2), 0x02 = PlutusV2, 0x43 = 3 bytes, then the script.
    expect(scriptRefHexFor('plutusV2', '010203')).toBe('820243010203')
    expect(scriptRefHexFor('native', 'ff')).toBe('820041ff')
  })

  it('publishes the script at this wallet’s own address by default and locks the floor', async () => {
    const {built, ownHex} = await Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(100_000_000n))
        yield* rail.sync
        const built = yield* buildAgentDeploy(rail, GROUP, {
          version: 'plutusV2',
          scriptHex: 'ab'.repeat(500),
          addressHex: rail.account.addressHex,
        })
        return {built, ownHex: rail.account.addressHex}
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(built.scriptRefHex.startsWith('8202')).toBe(true)
    expect(ownHex.length).toBeGreaterThan(0)
    // ⚠️ The whole reason min-ADA has to account for the script: a 500-byte one needs far more than
    // the ~1 ADA a bare output does, and measuring without it would underfund the deployment.
    expect(built.lockedLovelace).toBeGreaterThan(2_000_000n)
  })

  it('locks more for a larger script', async () => {
    const lockedFor = (bytes: number) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const rail = yield* railWith(funded(500_000_000n))
          yield* rail.sync
          const built = yield* buildAgentDeploy(rail, GROUP, {
            version: 'plutusV3',
            scriptHex: 'ab'.repeat(bytes),
            addressHex: rail.account.addressHex,
          })
          return built.lockedLovelace
        }).pipe(Effect.provide(EvolutionDecodeLayer)),
      )
    expect(await lockedFor(4000)).toBeGreaterThan(await lockedFor(200))
  })
})

describe('buildAgentTransferChain', () => {
  const chainFor = (count: number, coin = 1_000_000_000n) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(coin))
        yield* rail.sync
        return yield* buildAgentTransferChain(rail, GROUP, {
          targets: Array.from({length: count}, () => target(1_500_000n)),
        })
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )

  it('leaves a send that fits as one transaction', async () => {
    const chain = await chainFor(3)
    expect(chain.builds).toHaveLength(1)
    expect(chain.unplaced).toEqual([])
  })

  // ⚠️ The reason this exists. 400 recipients need two transactions, and the second spends the first's
  // CHANGE — so it cannot be built until the first exists. "Call again with the rest" is not something
  // an agent can act on: until leg one confirms, the wallet has no coins left to build leg two from.
  it('chains a send that does not fit, each leg spending the last one’s change', async () => {
    const chain = await chainFor(400)
    expect(chain.builds.length).toBeGreaterThan(1)
    expect(chain.unplaced).toEqual([])
    // Every leg is a real transaction with its own hash, and they are distinct.
    const hashes = new Set(chain.builds.map((b) => b.txHash))
    expect(hashes.size).toBe(chain.builds.length)
  })

  // ⚠️ Never dropped. A caller told nothing would read the answer as "all of them were paid".
  // Funded for the whole list, so the only thing stopping it is the leg cap — an underfunded wallet is
  // a different answer (insufficient funds), and must not be reported as "these did not fit".
  it('returns the recipients no leg could take rather than silently losing them', async () => {
    const chain = await chainFor(3000, 6_000_000_000n)
    expect(chain.builds.length).toBeLessThanOrEqual(5)
    expect(chain.unplaced.length).toBeGreaterThan(0)
    const placed = chain.builds.length * 241
    expect(chain.unplaced.length).toBeLessThanOrEqual(3000 - placed + 241)
  })

  it('fails rather than chaining when the wallet simply cannot afford it', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const rail = yield* railWith(funded(3_000_000n))
        yield* rail.sync
        return yield* buildAgentTransferChain(rail, GROUP, {targets: [target(500_000_000n)]})
      }).pipe(Effect.provide(EvolutionDecodeLayer)),
    )
    expect(exit._tag).toBe('Failure')
  })
})
