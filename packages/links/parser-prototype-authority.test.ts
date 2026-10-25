// An authority is attacker-controlled (a QR code, any link), and the parser table is an object
// literal — so a hostname that names an `Object.prototype` member used to resolve to a truthy
// non-parser, pass the `!parser` guard, and throw on call. The throw was a *defect*, so it escaped
// the typed failure channel: `Effect.either` did not catch it and callers using `Effect.runSync`
// rethrew, crashing the scan screen.
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {parse} from './parser.js'

const PROTOTYPE_MEMBERS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']

describe('authority lookup does not resolve through Object.prototype', () => {
  for (const host of PROTOTYPE_MEMBERS) {
    it(`web+cardano://${host}/ fails as InvalidUriError, not a defect`, async () => {
      const result = await Effect.runPromise(Effect.either(parse(`web+cardano://${host}/x`)))
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('InvalidUriError')
        expect(result.left.reason).toContain('Unknown authority')
      }
    })
  }

  it('a real authority still parses through its own handler', async () => {
    // `pay` with no address is a *typed* refusal from the pay parser — proof the table still works
    // rather than every authority now being rejected as unknown.
    const result = await Effect.runPromise(Effect.either(parse('web+cardano://pay/x')))
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.reason).toContain('address')
  })
})
