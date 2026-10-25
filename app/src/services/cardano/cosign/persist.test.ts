import {createMemoryStorage} from '@pnyx/storage'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {persistCosign, stableCosignId} from './persist'
import {getCosign} from './registry'
import type {EnvelopeSigner, TxEnvelope} from './types'

const signer = (id: string, signed: boolean): EnvelopeSigner => ({id, name: id, keyHashHex: `${id}hash`, signed})

const envelope = (signers: readonly EnvelopeSigner[]): TxEnvelope => ({
  version: 1,
  chainId: 'cardano:preprod',
  createdAt: '2026-07-12T00:00:00.000Z',
  createdBy: 'me',
  kind: 'multisig',
  bodyHex: 'a100',
  nativeScriptHexes: [],
  networkId: 0,
  accountIndex: 0,
  keyIndexes: [0],
  signers,
  witnesses: [],
})

describe('persistCosign', () => {
  it('derives a stable id from the tx body', () => {
    const a = envelope([signer('x', false)])
    const b = envelope([signer('y', true)]) // same bodyHex, different signers
    expect(stableCosignId(a)).toBe(stableCosignId(b))
  })

  it('saves an under-quorum envelope', async () => {
    const storage = createMemoryStorage()
    const under = envelope([signer('a', true), signer('b', false)])
    const id = stableCosignId(under)

    await Effect.runPromise(persistCosign(storage, 'g1', under))
    expect(await Effect.runPromise(getCosign(storage, id))).toEqual({id, groupId: 'g1', envelope: under})
  })

  it('keeps a quorum-met envelope, because the submit is a later step', async () => {
    // It used to drop this one. Origination signs, files the envelope and hands
    // off to the co-sign screen to submit — so for a wallet whose own signature
    // completes the quorum, a signed transaction arrived at a screen that could
    // not find it. Removal is explicit, once it is actually broadcast.
    const storage = createMemoryStorage()
    const met = envelope([signer('a', true), signer('b', true)])
    const id = stableCosignId(met)

    await Effect.runPromise(persistCosign(storage, 'g1', met))
    expect(await Effect.runPromise(getCosign(storage, id))).toEqual({id, groupId: 'g1', envelope: met})
  })

  it('is idempotent — re-persisting the same body overwrites in place', async () => {
    const storage = createMemoryStorage()
    const env = envelope([signer('a', false), signer('b', false)])
    await Effect.runPromise(persistCosign(storage, 'g1', env))
    await Effect.runPromise(persistCosign(storage, 'g1', env))
    const keys = (await Effect.runPromise(storage.keys())).filter((k) => k.startsWith('cardano.cosign.'))
    expect(keys).toHaveLength(1)
  })
})
