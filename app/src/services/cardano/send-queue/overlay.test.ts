import type {UTxO} from '@evolution-sdk/evolution'
import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {describe, expect, it} from 'vitest'
import type {SendReview} from '../send-flow'
import {testUtxo} from '../test-utxo'
import type {SendQueueRequest} from './model'
import {isChainable, legFromSendReview} from './overlay'

const utxo = (txFill: number, index: number): UTxO.UTxO => testUtxo({txHash: txFill, index, lovelace: 4_000_000n})

const request: SendQueueRequest = {
  payload: {_tag: 'CardanoTx', bodyHex: 'beef', networkId: 0},
  groupId: 'g1',
}

const review: Pick<SendReview, 'txHash' | 'request' | 'tracked' | 'changePlan'> = {
  txHash: 'aa'.repeat(32),
  request,
  tracked: {consumedUtxoIds: ['input:0', 'input:1'], change: [utxo(0xaa, 2)]},
  changePlan: {changeOutputs: [{txHash: 'aa'.repeat(32), index: 2, assets: EvAssets.fromLovelace(4_000_000n)}]},
}

describe('legFromSendReview', () => {
  it('freezes a built send into a leg, deriving change ids from the tracked change', () => {
    const leg = legFromSendReview(review, 'leg-1', 1_700_000_000_000)

    expect(leg).toEqual({
      legId: 'leg-1',
      txHash: 'aa'.repeat(32),
      request,
      consumedUtxoIds: ['input:0', 'input:1'],
      changeUtxoIds: [`${'aa'.repeat(32)}:2`],
      changeOutputs: [{index: 2, valueHex: '1a003d0900'}],
      queuedAt: 1_700_000_000_000,
    })
  })

  it('carries no change ids when the build produced no change', () => {
    const noChange = {...review, tracked: {consumedUtxoIds: ['input:0'], change: []}, changePlan: {changeOutputs: []}}

    expect(legFromSendReview(noChange, 'leg-1', 1).changeUtxoIds).toEqual([])
  })

  it('records the change id at the outpoint the build reported', () => {
    // A later leg chains by matching this id, so it must equal utxoId() of the
    // change UTxO the tracker will expose. The index comes from the builder's
    // reported outpoint, never from an assumption about output ordering.
    const leg = legFromSendReview(review, 'leg-1', 1)

    expect(leg.changeUtxoIds[0]).toBe(`${'aa'.repeat(32)}:2`)
    expect(isChainable(leg)).toBe(true)
  })

  it('keeps every change output when the build had to split change', () => {
    // The balancer splits change across outputs when one cannot hold the assets.
    // A leg that persisted only the first would offer a later leg a fraction of
    // the change it actually has, and the rest would look unspent until the
    // transaction confirmed.
    const split = {
      ...review,
      tracked: {consumedUtxoIds: ['input:0'], change: [utxo(0xaa, 2), utxo(0xaa, 3)]},
      changePlan: {
        changeOutputs: [
          {txHash: 'aa'.repeat(32), index: 2, assets: EvAssets.fromLovelace(4_000_000n)},
          {txHash: 'aa'.repeat(32), index: 3, assets: EvAssets.fromLovelace(2_000_000n)},
        ],
      },
    }
    const leg = legFromSendReview(split, 'leg-1', 1)

    expect(leg.changeOutputs).toEqual([
      {index: 2, valueHex: '1a003d0900'},
      {index: 3, valueHex: '1a001e8480'},
    ])
    expect(leg.changeUtxoIds).toEqual([`${'aa'.repeat(32)}:2`, `${'aa'.repeat(32)}:3`])
    expect(isChainable(leg)).toBe(true)
  })

  it('is not chainable when the build emitted no change', () => {
    const noChange = {...review, tracked: {consumedUtxoIds: ['input:0'], change: []}, changePlan: {changeOutputs: []}}

    expect(isChainable(legFromSendReview(noChange, 'leg-1', 1))).toBe(false)
  })
})
