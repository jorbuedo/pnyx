import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect, Exit} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  CIP146_LABEL,
  type DecodedRegistration,
  encodeRegistration,
  participantNames,
  registrationAuxData,
  registrationFor,
  registrationScripts,
  SCRIPT_TYPE,
  scriptOfType,
} from './registration'
import {flatTemplate, tagAt} from './template'
import type {SharedWallet} from './types'

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const wallet = (): SharedWallet => {
  const coSigners = [
    {tag: tagAt(0), name: 'Alice', accountXpubHex: XpubHex('aa'.repeat(64)), isSelf: true},
    {tag: tagAt(1), name: 'Bob', accountXpubHex: XpubHex('bb'.repeat(64))},
  ]
  const t = flatTemplate(
    {kind: 'all'},
    coSigners.map((c) => c.tag),
  )
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners,
    paymentTemplate: t,
    delegationTemplate: t,
    network: Address.Network.Testnet,
    accountIndex: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
  }
}

describe('registrationFor', () => {
  it('declares payment then delegation, and names both scripts', () => {
    // The two templates are usually structurally identical, so a reader cannot
    // tell them apart by shape — `types` is what carries the distinction.
    const r = registrationFor(wallet())
    expect(r.types).toEqual([SCRIPT_TYPE.payment, SCRIPT_TYPE.delegation])
    expect(r.name).toBe('Treasury')
  })

  it('labels every participant by tag', () => {
    expect(registrationFor(wallet()).participants).toEqual({
      [tagAt(0)]: {name: 'Alice'},
      [tagAt(1)]: {name: 'Bob'},
    })
  })
})

describe('encodeRegistration', () => {
  it('produces a metadatum', async () => {
    const hex = await run(encodeRegistration(registrationFor(wallet())))
    expect(hex.length).toBeGreaterThan(0)
  })

  it('omits optional fields rather than emitting them empty', async () => {
    // An empty string reads as "the creator said nothing", not "chose not to say".
    const withName = await run(encodeRegistration({types: [SCRIPT_TYPE.payment], name: 'x'}))
    const without = await run(encodeRegistration({types: [SCRIPT_TYPE.payment]}))
    expect(withName).not.toBe(without)
  })

  it('is deterministic for the same input', async () => {
    const r = registrationFor(wallet())
    expect(await run(encodeRegistration(r))).toBe(await run(encodeRegistration(r)))
  })
})

// Well-formed one-key native scripts: `[0, keyhash]` and `[1, [[0, keyhash]]]`. The earlier
// fixtures here were `8200` and `8201` — two bytes each, declaring an element they did not carry.
// They decoded only because the pure-TS reader invented a zero for the missing one.
const KEY_SCRIPT_A = `8200581c${'a1'.repeat(28)}`
const KEY_SCRIPT_B = `8201818200581c${'b1'.repeat(28)}`

describe('registrationAuxData', () => {
  it('builds aux data carrying the scripts it describes', async () => {
    const scripts = registrationScripts({paymentScriptHex: KEY_SCRIPT_A, stakingScriptHex: KEY_SCRIPT_B})
    const aux = await run(registrationAuxData(registrationFor(wallet()), scripts))
    expect(aux.length).toBeGreaterThan(0)
  })

  it('refuses a types array that does not match the script count', async () => {
    // Positional correspondence is the contract; a mismatch would label the
    // delegation script as payment.
    const exit = await Effect.runPromiseExit(
      registrationAuxData(registrationFor(wallet()), [KEY_SCRIPT_A]) as Effect.Effect<string>,
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('scriptOfType', () => {
  const decoded: DecodedRegistration = {
    registration: {types: [SCRIPT_TYPE.payment, SCRIPT_TYPE.delegation]},
    scriptHexes: ['8200', '8201'],
  }

  it('resolves a script by its declared role, not its position alone', () => {
    expect(scriptOfType(decoded, SCRIPT_TYPE.payment)).toBe('8200')
    expect(scriptOfType(decoded, SCRIPT_TYPE.delegation)).toBe('8201')
  })

  it('follows a reversed types array', () => {
    const reversed: DecodedRegistration = {
      registration: {types: [SCRIPT_TYPE.delegation, SCRIPT_TYPE.payment]},
      scriptHexes: ['8200', '8201'],
    }
    expect(scriptOfType(reversed, SCRIPT_TYPE.payment)).toBe('8201')
  })

  it('returns null for a role the registration does not declare', () => {
    expect(scriptOfType({registration: {types: []}, scriptHexes: []}, SCRIPT_TYPE.payment)).toBeNull()
  })
})

describe('participantNames', () => {
  it('takes names from the registration', () => {
    const decoded: DecodedRegistration = {
      registration: {types: [], participants: {[tagAt(0)]: {name: 'Alice'}, [tagAt(1)]: {name: 'Bob'}}},
      scriptHexes: [],
    }
    expect(participantNames(decoded, [tagAt(0), tagAt(1)])).toEqual([
      {tag: tagAt(0), name: 'Alice'},
      {tag: tagAt(1), name: 'Bob'},
    ])
  })

  it('falls back to the tag when a registration names nobody', () => {
    // The tag is what the script actually references, so it is the truthful
    // label — not a placeholder like "Unknown".
    const decoded: DecodedRegistration = {registration: {types: []}, scriptHexes: []}
    expect(participantNames(decoded, [tagAt(0)])).toEqual([{tag: tagAt(0), name: tagAt(0)}])
  })
})

describe('CIP146_LABEL', () => {
  it('is 1854, the same number as the derivation purpose', () => {
    expect(CIP146_LABEL).toBe(1854n)
  })
})
