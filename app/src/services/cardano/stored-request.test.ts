import {describe, expect, it} from 'vitest'
import {parseStoredSigningRequest, parseStoredSigningRequests} from './stored-request'

const txRequest = (over: Record<string, unknown> = {}) => ({
  groupId: 'g1',
  payload: {_tag: 'CardanoTx', bodyHex: 'a1b2', networkId: 1, ...over},
})

describe('parseStoredSigningRequest', () => {
  it('accepts a minimal CardanoTx request', () => {
    expect(parseStoredSigningRequest(txRequest())).not.toBeNull()
  })

  it('accepts the optional witness-set companions', () => {
    const parsed = parseStoredSigningRequest(
      txRequest({
        witnessExtra: [
          [7, 'aa'],
          [5, 'bb'],
        ],
        nativeScripts: ['cc'],
        auxHex: 'dd',
        signOnly: true,
      }),
    )
    expect(parsed).not.toBeNull()
  })

  it('accepts a CardanoData request', () => {
    expect(
      parseStoredSigningRequest({
        groupId: 'g1',
        payload: {
          _tag: 'CardanoData',
          addressHex: 'aa',
          payloadHex: 'bb',
          signingPath: "m/1852'/1815'/0'/0/0",
          networkId: 1,
        },
      }),
    ).not.toBeNull()
  })

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
    ['a missing groupId', {payload: {_tag: 'CardanoTx', bodyHex: 'a1', networkId: 1}}],
    ['an empty groupId', {groupId: '', payload: {_tag: 'CardanoTx', bodyHex: 'a1', networkId: 1}}],
    ['a missing payload', {groupId: 'g1'}],
    ['an unknown _tag', {groupId: 'g1', payload: {_tag: 'Ethereum', bodyHex: 'a1', networkId: 1}}],
  ])('rejects %s', (_label, value) => {
    expect(parseStoredSigningRequest(value)).toBeNull()
  })

  it.each([
    ['a missing bodyHex', {bodyHex: undefined}],
    ['an odd-length bodyHex', {bodyHex: 'abc'}],
    ['a non-hex bodyHex', {bodyHex: 'zzzz'}],
    ['an empty bodyHex', {bodyHex: ''}],
    ['a missing networkId', {networkId: undefined}],
    ['a non-numeric networkId', {networkId: '1'}],
    ['a NaN networkId', {networkId: Number.NaN}],
  ])('rejects a CardanoTx with %s', (_label, over) => {
    expect(parseStoredSigningRequest(txRequest(over))).toBeNull()
  })

  // A dropped/garbled witness set is what made a real mainnet registration fail
  // with ScriptIntegrityHashMismatch, so these must not slip through as valid.
  it.each([
    ['a non-pair entry', {witnessExtra: [[7]]}],
    ['a non-numeric key', {witnessExtra: [['7', 'aa']]}],
    ['non-hex CBOR', {witnessExtra: [[7, 'zz']]}],
    ['a non-array value', {witnessExtra: 'aa'}],
  ])('rejects witnessExtra with %s', (_label, over) => {
    expect(parseStoredSigningRequest(txRequest(over))).toBeNull()
  })

  // Not stored by any producer, so accepting them would widen the boundary past
  // what we actually write.
  it('rejects payload shapes no producer persists', () => {
    expect(parseStoredSigningRequest(txRequest({cip36Registration: {}}))).toBeNull()
    expect(
      parseStoredSigningRequest({
        groupId: 'g1',
        payload: {
          _tag: 'CardanoData',
          addressHex: 'aa',
          payloadHex: 'bb',
          signingPath: 'm/0',
          networkId: 1,
          hardwareAddressParams: {type: 'base'},
        },
      }),
    ).toBeNull()
  })
})

describe('parseStoredSigningRequests', () => {
  it('accepts an all-valid array', () => {
    expect(parseStoredSigningRequests([txRequest(), txRequest()])).toHaveLength(2)
  })

  it.each([
    ['a non-array', {}],
    ['an empty array', []],
  ])('rejects %s', (_label, value) => {
    expect(parseStoredSigningRequests(value)).toBeNull()
  })

  // All-or-nothing: dropping a bad leg from a chain leaves a shorter ceremony
  // that still looks complete, whose remaining legs may depend on the dropped
  // one's outputs.
  it('rejects the whole array when any single leg is invalid', () => {
    expect(parseStoredSigningRequests([txRequest(), txRequest({bodyHex: 'zz'})])).toBeNull()
    expect(parseStoredSigningRequests([txRequest({networkId: undefined}), txRequest()])).toBeNull()
  })
})
