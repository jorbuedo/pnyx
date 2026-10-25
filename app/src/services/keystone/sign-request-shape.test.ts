import {describe, expect, it} from 'vitest'

import {signRequestShapeFor} from './sign-request-shape'

describe('a transaction a device can parse', () => {
  it('is sent as a body, so the device can show what it signs', () => {
    expect(signRequestShapeFor({witnessSetPopulated: false, requiresExtraSignatures: false})).toEqual({kind: 'body'})
  })
})

describe('a transaction a device cannot parse', () => {
  // ⚠️ The condition is a populated witness set, not "is it multisig". A partially-signed CIP-1854
  // spend is the common case, but any pre-existing witness or script makes the body unparseable to
  // firmware — which is why 2212 is the only shape that works rather than the convenient one.
  it('goes as a hash when the witness set already carries something', () => {
    const shape = signRequestShapeFor({witnessSetPopulated: true, requiresExtraSignatures: false})
    expect(shape.kind).toBe('hash')
  })

  it('goes as a hash when the body names required extra signatures', () => {
    const shape = signRequestShapeFor({witnessSetPopulated: false, requiresExtraSignatures: true})
    expect(shape.kind).toBe('hash')
  })

  // ⚠️ Not decoration. Hash-signing is only acceptable because our own review screen showed the
  // transaction first, so the user has to be told the device will show them less than the phone did.
  // A shape with no reason is a screen with nothing to say.
  it('always says why the body was impossible', () => {
    for (const transaction of [
      {witnessSetPopulated: true, requiresExtraSignatures: false},
      {witnessSetPopulated: false, requiresExtraSignatures: true},
      {witnessSetPopulated: true, requiresExtraSignatures: true},
    ]) {
      const shape = signRequestShapeFor(transaction)
      expect(shape.kind === 'hash' && shape.reason.length > 0).toBe(true)
      // The user-facing half of the promise: it names what the device will show instead.
      expect(shape.kind === 'hash' && shape.reason).toContain('hash')
    }
  })

  // Both conditions at once reports the one a reader can act on rather than a merged message.
  it('reports the witness set first when both hold', () => {
    const shape = signRequestShapeFor({witnessSetPopulated: true, requiresExtraSignatures: true})
    expect(shape.kind === 'hash' && shape.reason).toContain('witnesses or scripts')
  })
})
