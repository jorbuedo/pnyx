import {describe, expect, it} from 'vitest'
import {partialSignRequest} from './orchestrate'
import type {TxEnvelope} from './types'

const envelope = (over: Partial<TxEnvelope> = {}): TxEnvelope =>
  ({
    version: 1,
    chainId: 'cardano:preprod',
    createdAt: '2026-07-29T00:00:00.000Z',
    createdBy: 'test',
    kind: 'multisig',
    bodyHex: 'a1b2c3',
    nativeScriptHexes: ['8201'],
    networkId: 0,
    signers: [],
    witnesses: [],
    ...over,
  }) as TxEnvelope

/**
 * Co-sign routes through `TxReviewScreen` with no bespoke confirm mode, and that
 * rests entirely on this request being an **ordinary `signOnly` request** — the
 * same shape a dApp `signTx` produces. If it ever stopped being one, the review
 * screen would either broadcast a partially-signed multisig transaction or fail to
 * return a witness set for the envelope merge. Hence these assertions.
 */
describe('partialSignRequest', () => {
  it('never broadcasts: signOnly and partial are both set', () => {
    const {payload} = partialSignRequest(envelope(), 'g1', ["m/1854'/1815'/0'/0/0"])
    expect(payload).toMatchObject({_tag: 'CardanoTx', signOnly: true, partial: true})
  })

  it('signs the envelope body verbatim', () => {
    const {payload} = partialSignRequest(envelope({bodyHex: 'deadbeef'}), 'g1', ['m/0'])
    expect(payload).toMatchObject({bodyHex: 'deadbeef'})
  })

  // Dropping these is the class of bug that made a real mainnet registration fail
  // with ScriptIntegrityHashMismatch — the body commits to witness-set contents.
  it('carries the native scripts the witness set will need', () => {
    const {payload} = partialSignRequest(envelope({nativeScriptHexes: ['8201', '8202']}), 'g1', ['m/0'])
    expect(payload).toMatchObject({nativeScripts: ['8201', '8202']})
  })

  it('carries auxiliary data when the envelope has any, and omits the key when it does not', () => {
    expect(partialSignRequest(envelope({auxHex: 'a0'}), 'g1', ['m/0']).payload).toMatchObject({auxHex: 'a0'})
    expect(partialSignRequest(envelope(), 'g1', ['m/0']).payload).not.toHaveProperty('auxHex')
  })

  it('resolves exactly this signer, so a co-signer never signs for another', () => {
    const path = "m/1854'/1815'/0'/0/0"
    const {payload} = partialSignRequest(envelope(), 'g1', [path])
    expect(payload).toMatchObject({precomputedSigningPaths: [path]})
  })

  it('asks for a witness per payment index the transaction spends', () => {
    // A co-signer's key differs at every index, so a transaction touching two of
    // them needs two witnesses from the same person. Passing one path signs half
    // the inputs and the transaction is rejected after every human step is done.
    const paths = ["m/1854'/1815'/0'/0/0", "m/1854'/1815'/0'/0/3"]
    const {payload} = partialSignRequest(envelope({nativeScriptHexes: ['8200', '8203']}), 'g1', paths)
    expect(payload).toMatchObject({precomputedSigningPaths: paths})
  })

  it('preserves the network identity from the envelope, not from app state', () => {
    const {payload} = partialSignRequest(envelope({networkId: 1, protocolMagic: 764824073}), 'g1', ['m/0'])
    expect(payload).toMatchObject({networkId: 1, protocolMagic: 764824073})
  })

  it('omits protocolMagic when the envelope carries none rather than guessing one', () => {
    expect(partialSignRequest(envelope(), 'g1', ['m/0']).payload).not.toHaveProperty('protocolMagic')
  })

  it('signs on behalf of the given group', () => {
    expect(partialSignRequest(envelope(), 'group-xyz', ['m/0']).groupId).toBe('group-xyz')
  })
})
