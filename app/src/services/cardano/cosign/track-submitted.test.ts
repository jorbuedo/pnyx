import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {AddressHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {consumedUtxoIdsOf} from './track-submitted'

const PARAMS: Plan.ProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  maxValueSize: 5000n,
  maxTxSize: 16_384n,
}

const TX_A = 'aa'.repeat(32)
const TX_B = 'bb'.repeat(32)
const SCRIPT_ADDR_HEX = `30${'10'.repeat(28)}${'99'.repeat(28)}`
const TO_ADDR_HEX = `00${'11'.repeat(28)}${'88'.repeat(28)}`

describe('consumedUtxoIdsOf', () => {
  let bodyHex: string

  beforeAll(async () => {
    bodyHex = Plan.buildUnsigned({
      inputs: [],
      mandatoryInputs: [
        {txHash: TxHashHex(TX_A), index: 0, assets: EvAssets.fromLovelace(10_000_000n)},
        {txHash: TxHashHex(TX_B), index: 3, assets: EvAssets.fromLovelace(10_000_000n)},
      ],
      outputs: [{addressHex: AddressHex(TO_ADDR_HEX), assets: EvAssets.fromLovelace(5_000_000n)}],
      changeAddressHex: AddressHex(SCRIPT_ADDR_HEX),
      params: PARAMS,
      signerCount: 2,
    }).bodyHex
  })

  const run = () => Effect.runPromise(Effect.provide(consumedUtxoIdsOf(bodyHex), EvolutionDecodeLayer))

  it('names every input the transaction spends, so none reads as available again', async () => {
    // Missing one is the whole hazard: the wallet re-selects it, and the next
    // send is rejected as a double spend with nothing saying why.
    expect([...(await run())].sort()).toEqual([`${TX_A}:0`, `${TX_B}:3`].sort())
  })

  it('keys on the output index, not just the transaction', async () => {
    expect(await run()).toContain(`${TX_B}:3`)
    expect(await run()).not.toContain(`${TX_B}:0`)
  })
})
