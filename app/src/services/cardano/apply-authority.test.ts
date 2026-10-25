import type {CardanoTxPayload, SigningRequest} from '@pnyx/signing-service'
import {describe, expect, it} from 'vitest'
import {KEY_AUTHORITY, type SpendAuthority} from './account'
import {applyAuthorityToRequest} from './signing-adapters'

const script = (over: Partial<Extract<SpendAuthority, {kind: 'script'}>> = {}): SpendAuthority => ({
  kind: 'script',
  indexes: [
    {
      keyIndex: 0,
      scriptHashHex: 'cc'.repeat(28),
      nativeScriptHex: '8201',
      signerKeyHashes: ['aa'.repeat(28)],
      requiredSigners: 2,
    },
  ],
  stake: {
    scriptHashHex: 'dd'.repeat(28),
    nativeScriptHex: '8202',
    signerKeyHashes: ['11'.repeat(28)],
    requiredSigners: 1,
  },
  validity: {invalidBefore: null, invalidHereafter: null},
  signingGroupId: 'group-home',
  ...over,
})

const txRequest = (over: Partial<CardanoTxPayload> = {}): SigningRequest => ({
  groupId: 'group-shared',
  payload: {_tag: 'CardanoTx', bodyHex: 'a1b2', networkId: 0, ...over},
})

const cardanoPayload = (request: SigningRequest): CardanoTxPayload => {
  if (request.payload._tag !== 'CardanoTx') throw new Error('expected a CardanoTx payload')
  return request.payload
}

describe('applyAuthorityToRequest — key wallets', () => {
  it('passes the request through untouched', () => {
    const request = txRequest()
    expect(applyAuthorityToRequest(KEY_AUTHORITY, request)).toBe(request)
  })
})

describe('applyAuthorityToRequest — script wallets', () => {
  it('forces a partial, sign-only pass', () => {
    // A co-signer holds one of N keys: a complete pass would fail the coverage
    // check, and assembling would broadcast a transaction short of its quorum.
    const payload = cardanoPayload(applyAuthorityToRequest(script(), txRequest()))
    expect(payload.partial).toBe(true)
    expect(payload.signOnly).toBe(true)
  })

  it('attaches the native scripts the ledger needs to validate the spend', () => {
    expect(cardanoPayload(applyAuthorityToRequest(script(), txRequest())).nativeScripts).toEqual(['8201'])
  })

  it('keeps scripts the caller already supplied', () => {
    const payload = cardanoPayload(applyAuthorityToRequest(script(), txRequest({nativeScripts: ['8200']})))
    expect(payload.nativeScripts).toEqual(['8200', '8201'])
  })

  it('carries a script per payment index the spend draws on', () => {
    // One transaction may spend two of the wallet's indexes, and the ledger
    // validates each script against the inputs it guards — dropping either fails
    // phase-1 for that half.
    const two = script({
      indexes: [
        {
          keyIndex: 0,
          scriptHashHex: 'c0'.repeat(28),
          nativeScriptHex: '8200',
          signerKeyHashes: ['a0'.repeat(28)],
          requiredSigners: 1,
        },
        {
          keyIndex: 3,
          scriptHashHex: 'c3'.repeat(28),
          nativeScriptHex: '8203',
          signerKeyHashes: ['a3'.repeat(28)],
          requiredSigners: 1,
        },
      ],
    })
    expect(cardanoPayload(applyAuthorityToRequest(two, txRequest())).nativeScripts).toEqual(['8200', '8203'])
  })

  it('redirects the request at the co-signer’s home group', () => {
    // The vault has nothing stored under the shared wallet's id.
    expect(applyAuthorityToRequest(script(), txRequest()).groupId).toBe('group-home')
  })

  it('leaves the group alone when the roster does not include us', () => {
    // Better that the ceremony fails honestly than that it reads another
    // wallet's seed to sign for a roster we are not in.
    const request = applyAuthorityToRequest(script({signingGroupId: null}), txRequest())
    expect(request.groupId).toBe('group-shared')
  })

  it('overrides a caller that asked for a complete signature', () => {
    // Whatever the flow asked for, a script wallet cannot complete alone.
    const payload = cardanoPayload(applyAuthorityToRequest(script(), txRequest({signOnly: false, partial: false})))
    expect(payload.signOnly).toBe(true)
    expect(payload.partial).toBe(true)
  })

  it('does not touch a data-signing request', () => {
    // CIP-106 disables signData for script wallets outright; there is nothing
    // to rewrite, and the refusal lives at the dApp entry point.
    const request: SigningRequest = {
      groupId: 'group-shared',
      payload: {
        _tag: 'CardanoData',
        addressHex: '00',
        payloadHex: 'ff',
        signingPath: "m/1852'/1815'/0'/0/0",
        networkId: 0,
      },
    }
    expect(applyAuthorityToRequest(script(), request)).toBe(request)
  })
})
