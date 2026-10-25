import {Assets as EvAssets, Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Wallet} from '@pnyx/cardano-core'
import {asMnemonic} from '@pnyx/crypto'
import type {CardanoTxPayload, SigningRequest, SigningSuccess} from '@pnyx/signing-service'
import {utxoId} from '@pnyx/wallet'
import {Effect, Layer} from 'effect'
import {afterEach, describe, expect, it} from 'vitest'
import {clearAllCeremonies} from '../credential-vault/ceremony-cache'
import {continuationForRequests, resumableRequests, signTxWithCeremony, signWithCeremony} from './ceremony-signing'
import type {CardanoRailConfig} from './config'
import type {CardanoRail} from './rail'
import {makeCardanoRail} from './rail'
import {type CredentialStoreDeps, cardanoSigningLayer} from './signing-adapters'
import {ceremonyFailureReason} from './submit-failure'
import {chainUtxo, mockChain} from './test-provider'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const CONFIG: CardanoRailConfig = {
  network: 'preprod',
  koiosUrl: 'https://koios.internal/api/v1',
  networkId: 0,
  protocolMagic: 1,
}

afterEach(() => clearAllCeremonies())

const setup = async (groupId: string) => {
  // Derive the real address for the canonical mnemonic so signing paths resolve.
  const address = await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      return yield* account.baseAddress(Address.Network.Testnet)
    }),
  )
  const utxos = [
    chainUtxo({address, txHash: '11', lovelace: 10_000_000n}),
    chainUtxo({address, txHash: '22', lovelace: 8_000_000n}),
  ]
  const rail = await Effect.runPromise(
    makeCardanoRail({config: CONFIG, addressBech32: address, accountIndex: 0}).pipe(
      Effect.provide(Layer.mergeAll(EvolutionDecodeLayer, mockChain({utxos: [...utxos]}))),
    ),
  )
  await Effect.runPromise(rail.sync)

  let retrieves = 0
  const deps: CredentialStoreDeps = {
    retrieveMnemonic: () => {
      retrieves++
      return Effect.succeed(asMnemonic(MNEMONIC))
    },
    resolveSource: () => Effect.succeed('software' as const),
    resolveHardwareMeta: () => Effect.succeed(null),
  }
  const layer = cardanoSigningLayer(rail, deps)

  const buildPayload = async (): Promise<CardanoTxPayload> => {
    const spendable = await Effect.runPromise(rail.spendableUtxos)
    const inputs = spendable.map((u) => ({
      txHash: TxHashHex(utxoId(u).split(':')[0] as TxHashHex),
      index: Number(u.index),
      assets: EvAssets.fromLovelace(u.assets.lovelace),
    }))
    const unsigned = Plan.buildUnsigned({
      inputs,
      outputs: [{addressHex: rail.account.addressHex, assets: EvAssets.fromLovelace(1_500_000n)}],
      changeAddressHex: rail.account.addressHex,
      params: {
        minFeeA: 44n,
        minFeeB: 155_381n,
        coinsPerUtxoByte: 4_310n,
        keyDeposit: 2_000_000n,
        poolDeposit: 500_000_000n,
        drepDeposit: 500_000_000n,
      },
      signerCount: 1,
      ttl: 99_000_000,
    })
    return {_tag: 'CardanoTx', bodyHex: unsigned.bodyHex, networkId: 0}
  }

  const request = (payload: CardanoTxPayload): SigningRequest => ({groupId, payload})
  return {rail, deps, layer, buildPayload, request, retrieveCount: () => retrieves}
}

const AUDIT = {purpose: 'send', origin: null} as const

describe('signWithCeremony', () => {
  it('signs and broadcasts an unsigned plan build end-to-end', async () => {
    const {layer, buildPayload, request} = await setup('ceremony-group-1')
    const payload = await buildPayload()
    const result = await signTxWithCeremony('ceremony-group-1', request(payload), layer, AUDIT)
    expect(result._tag).toBe('TxSubmitted')
    if (result._tag !== 'TxSubmitted') return
    expect(result.signedTxHex).toContain(payload.bodyHex)
  })

  it('authenticates once across sequential legs (ceremony cache fast-path)', async () => {
    const {layer, buildPayload, request, retrieveCount} = await setup('ceremony-group-2')
    const payload = await buildPayload()
    const results = await signWithCeremony(
      'ceremony-group-2',
      [request({...payload, signOnly: true}), request({...payload, signOnly: true})],
      layer,
      AUDIT,
    )
    expect(results).toHaveLength(2)
    expect(retrieveCount()).toBe(1)
  })

  it('reports progress with leg indices', async () => {
    const {layer, buildPayload, request} = await setup('ceremony-group-3')
    const payload = await buildPayload()
    const seen: Array<[string, number]> = []
    await signWithCeremony(
      'ceremony-group-3',
      [request({...payload, signOnly: true}), request({...payload, signOnly: true})],
      layer,
      AUDIT,
      (progress, index) => seen.push([progress.phase, index]),
    )
    expect(seen.some(([, index]) => index === 0)).toBe(true)
    expect(seen.some(([, index]) => index === 1)).toBe(true)
  })
})

// A rejected `Effect.runPromise` hands the caller a FiberFailure, not the typed error. That is
// how a real mainnet ceremony lost both the leg it had already landed and the node's rejection
// text: the leg-1 registration was on chain while the persisted record said nothing was signed,
// and the reason shown to the user was Effect's generic default.
describe('a failed leg reports the typed error, not a FiberFailure', () => {
  const NODE_REASON = 'submit rejected (400): ConwayMempoolFailure "All inputs are spent"'

  /** The real signing layer, over a rail whose submit fails from the nth call onward. */
  const layerFailingFrom = (rail: CardanoRail, deps: CredentialStoreDeps, failFromCall: number) => {
    let calls = 0
    const submit: CardanoRail['submit'] = (hex) => {
      calls += 1
      return calls >= failFromCall
        ? Effect.fail(new EvolutionProvider.ProviderError({message: NODE_REASON}))
        : rail.submit(hex)
    }
    return cardanoSigningLayer({...rail, submit}, deps)
  }

  it('keeps the legs that already landed, and the reason the node gave', async () => {
    const {rail, deps, buildPayload, request} = await setup('ceremony-fail-1')
    const payload = await buildPayload()
    // Leg 1 broadcasts; leg 2 is rejected.
    const layer = layerFailingFrom(rail, deps, 2)

    const error = await signWithCeremony('ceremony-fail-1', [request(payload), request(payload)], layer, AUDIT).then(
      () => null,
      (e: unknown) => e,
    )

    expect(error).not.toBeNull()
    // A FiberFailure would expose neither of these.
    expect(error).toHaveProperty('completed')
    const completed = (error as {completed: readonly SigningSuccess[]}).completed
    expect(completed).toHaveLength(1)
    expect(completed[0]?._tag).toBe('TxSubmitted')
    expect((error as {failedIndex: number}).failedIndex).toBe(1)
    expect(ceremonyFailureReason(error)).toContain('All inputs are spent')

    // `completed` is what the continuation's step accounting consumes, so this is the assertion
    // that keeps "Step 0/2 for a ceremony whose leg 1 is on chain" from coming back. The write
    // itself goes through `appendSignedStepPure` + the continuation store, both covered in
    // `continuation/store.test.ts`; it cannot be observed from here because
    // `platformContinuationStore()` binds fresh in-memory storage per call under vitest.
    expect(completed.map((r) => (r._tag === 'TxSubmitted' ? r.txHash : null)).filter(Boolean)).toHaveLength(1)
  })

  it('reports the reason when the very first leg is rejected', async () => {
    const {rail, deps, buildPayload, request} = await setup('ceremony-fail-2')
    const payload = await buildPayload()
    const layer = layerFailingFrom(rail, deps, 1)

    const error = await signWithCeremony('ceremony-fail-2', [request(payload)], layer, AUDIT).then(
      () => null,
      (e: unknown) => e,
    )

    expect(ceremonyFailureReason(error)).toContain('All inputs are spent')
    expect((error as {completed?: readonly SigningSuccess[]}).completed).toEqual([])
  })
})

describe('continuation payload (resume plumbing)', () => {
  const req = (bodyHex: string): SigningRequest => ({groupId: 'g', payload: {_tag: 'CardanoTx', bodyHex, networkId: 0}})

  it('stashes the requests in contextData so a resume can reconstruct legs', () => {
    const requests = [req('aa'), req('bb')]
    const record = continuationForRequests('g', 'c', requests)
    expect(record.contextData?.requests).toEqual(requests)
    expect(record.expectedStepCount).toBe(2)
  })

  it('merges caller-supplied contextData alongside the requests', () => {
    const record = continuationForRequests('g', 'c', [req('aa')], {context: 'swap', contextData: {intentId: 'x'}})
    expect(record.context).toBe('swap')
    expect(record.contextData).toEqual({intentId: 'x', requests: [req('aa')]})
  })

  it('resumableRequests returns only the not-yet-broadcast legs', () => {
    const requests = [req('aa'), req('bb'), req('cc')]
    const record = {...continuationForRequests('g', 'c', requests), currentStepIndex: 1}
    expect(resumableRequests(record)).toEqual([req('bb'), req('cc')])
  })

  it('resumableRequests is null when nothing remains or no payload was stashed', () => {
    const requests = [req('aa'), req('bb')]
    const done = {...continuationForRequests('g', 'c', requests), currentStepIndex: 2}
    expect(resumableRequests(done)).toBeNull()
    const bare = continuationForRequests('g', 'c', requests)
    expect(resumableRequests({...bare, contextData: {}})).toBeNull()
  })
})
