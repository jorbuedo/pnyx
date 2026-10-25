// The catalogue is the whole new surface, so these are the checks that keep it from quietly becoming
// something else.
//
// The load-bearing one is `every tool names a method the connector implements`: the design constraint is
// that MCP adds no capability, and the way that breaks is a plausible-looking entry pointing at a method
// that does not exist — which fails at call time, in front of an agent, not here.
import {createCardanoHandler, createMidnightHandler} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  type ConnectorToolBinding,
  DELIBERATELY_ABSENT,
  effectiveScope,
  findTool,
  isConnectorTool,
  paramsFor,
  SCOPE_ARGUMENT,
  scopeFrom,
  TOOLS,
  toolDescriptors,
} from './catalogue.js'

/** The tools that forward to the connector — the only ones the handler checks below apply to. */
const FORWARDED: readonly ConnectorToolBinding[] = TOOLS.filter(isConnectorTool)

/**
 * A stand-in for a handler context that is callable at any depth and answers with a dying Effect.
 *
 * The handlers read *some* context members eagerly while constructing their method map (the Cardano one
 * calls `query.getProtocolParametersByLatest`) and close over others lazily, so a stub has to be usable
 * as a nested object, as a function, and as an Effect. Nothing is ever invoked for real — this test only
 * reads `methods.keys()`, and building the map is the point: it is the *real* surface, where a
 * source-text scan would only be a plausible imitation of it.
 */
const dead: never = new Proxy(function stub() {} as never, {
  get: () => dead,
  apply: () => Effect.die('the catalogue test never runs a handler method'),
}) as never

/** The real handlers, built only so their method maps can be read. */
const methodNames = (): {cardano: ReadonlySet<string>; midnight: ReadonlySet<string>} => ({
  cardano: new Set(createCardanoHandler(dead, () => Effect.succeed(false)).methods.keys()),
  midnight: new Set(createMidnightHandler(dead, () => Effect.succeed(false)).methods.keys()),
})

describe('the tool catalogue', () => {
  it('names only methods the connector actually implements', () => {
    const {cardano, midnight} = methodNames()
    for (const tool of FORWARDED) {
      const available = tool.chainType === 'cardano' ? cardano : midnight
      expect(
        available.has(tool.method),
        `${tool.descriptor.name} forwards to ${tool.chainType}/${tool.method}, which the handler does not implement`,
      ).toBe(true)
    }
  })

  it('prefixes every tool with its chain, because method names collide across chains', () => {
    const {cardano, midnight} = methodNames()
    // `signData` is the live example: both chains implement it with different semantics, so an
    // unprefixed catalogue would have to silently pick one.
    expect(cardano.has('signData') && midnight.has('signData')).toBe(true)
    for (const tool of TOOLS) {
      expect(tool.descriptor.name.startsWith(`${tool.chainType}_`), tool.descriptor.name).toBe(true)
    }
  })

  it('has a unique name per tool', () => {
    const names = TOOLS.map((t) => t.descriptor.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // Every tool takes it, so an agent granted several wallets can always say which one it means.
  it('offers the scope argument on every tool', () => {
    for (const {descriptor} of TOOLS) {
      expect(Object.keys(descriptor.inputSchema.properties), descriptor.name).toContain(SCOPE_ARGUMENT)
      // Optional, because omitting it is allowed when exactly one scope is granted.
      expect(descriptor.inputSchema.required ?? [], descriptor.name).not.toContain(SCOPE_ARGUMENT)
    }
  })

  it('describes every tool well enough for an agent to choose it', () => {
    for (const {descriptor} of TOOLS) {
      // A description is the call site, not documentation — an agent picks a tool from it alone.
      expect(descriptor.description.length, descriptor.name).toBeGreaterThan(40)
      expect(descriptor.inputSchema.type).toBe('object')
      // An open schema lets an agent invent arguments that are then silently dropped.
      expect(descriptor.inputSchema.additionalProperties, descriptor.name).toBe(false)
    }
  })

  // ⚠️ **The completeness check, and the reason the exclusion list exists.** Without it the catalogue is
  // a partial list nobody can audit: a connector method that is simply *missing* looks exactly like one
  // deliberately withheld, and a new method lands unnoticed. Every method must be in one list or the
  // other, so adding one to the connector fails here until somebody decides which.
  it('accounts for every connector method, in the catalogue or in the exclusion list', () => {
    const {cardano, midnight} = methodNames()
    const bound = new Set(FORWARDED.map((t) => `${t.chainType}/${t.method}`))
    const excluded = new Set(Object.keys(DELIBERATELY_ABSENT))
    const unaccounted: string[] = []
    for (const [chain, names] of [
      ['cardano', cardano],
      ['midnight', midnight],
    ] as const) {
      for (const name of names) {
        const key = `${chain}/${name}`
        if (!bound.has(key) && !excluded.has(key)) unaccounted.push(key)
      }
    }
    expect(
      unaccounted,
      `these connector methods are neither exposed nor listed as deliberately absent: ${unaccounted.join(', ')}`,
    ).toEqual([])
  })

  // The other direction: a stale exclusion is a reason kept for a method that no longer exists, which
  // makes the list read as authoritative when part of it is fiction.
  it('excludes only methods the connector still implements', () => {
    const {cardano, midnight} = methodNames()
    for (const key of Object.keys(DELIBERATELY_ABSENT)) {
      const [chain, method] = key.split('/')
      const available = chain === 'cardano' ? cardano : midnight
      expect(available.has(method as string), `${key} is excluded but no longer exists`).toBe(true)
    }
  })

  it('never both exposes and excludes the same method', () => {
    for (const tool of FORWARDED) {
      expect(DELIBERATELY_ABSENT[`${tool.chainType}/${tool.method}`], tool.descriptor.name).toBeUndefined()
    }
  })

  it('gives every exclusion a reason worth reading', () => {
    for (const [key, reason] of Object.entries(DELIBERATELY_ABSENT)) {
      expect(reason.length, key).toBeGreaterThan(20)
    }
  })

  it('resolves a tool by name and nothing else', () => {
    const balance = findTool('cardano_getBalance')
    expect(balance !== undefined && isConnectorTool(balance) && balance.method).toBe('getBalance')
    expect(findTool('getBalance')).toBeUndefined()
    expect(findTool('cardano_getbalance')).toBeUndefined()
  })

  // ⚠️ The kinds must stay distinguishable, because the completeness check above only walks the
  // forwarded ones. A local tool that named a connector method would look accounted for while nothing
  // checked it exists — and a connector method quietly withheld would look like a builder.
  it('keeps the local tools out of the connector surface entirely', () => {
    const {cardano, midnight} = methodNames()
    const localTools = TOOLS.filter((t) => !isConnectorTool(t))
    expect(localTools.length, 'the local kind exists but nothing uses it').toBeGreaterThan(0)
    for (const tool of localTools) {
      // The bare name a connector method would have, had this been one.
      const bare = tool.descriptor.name.slice(`${tool.chainType}_`.length)
      const available = tool.chainType === 'cardano' ? cardano : midnight
      expect(available.has(bare), `${tool.descriptor.name} collides with a connector method`).toBe(false)
    }
  })

  it('lists exactly the descriptors it binds', () => {
    expect(toolDescriptors().map((d) => d.name)).toEqual(TOOLS.map((t) => t.descriptor.name))
  })
})

describe('paramsFor', () => {
  const tool = (name: string): ConnectorToolBinding => {
    const found = findTool(name)
    if (found === undefined || !isConnectorTool(found)) throw new Error(`no forwarded tool named ${name}`)
    return found
  }

  // ⚠️ The one that would have broken every nullary Midnight read. MCP clients send `arguments: {}` for
  // a no-argument tool, and Midnight's `noParams` guard accepts `undefined`, `null` or `[]` and
  // **rejects `{}`**. Milestone 1 never saw it because `cardano_getBalance` ignores its params.
  it('sends no params at all for a tool that declares no arguments', () => {
    expect(paramsFor(tool('midnight_getDustBalance'), {})).toBeUndefined()
    expect(paramsFor(tool('midnight_getDustBalance'), undefined)).toBeUndefined()
    // Even if an agent invents arguments the schema forbids, a nullary method must not receive them.
    expect(paramsFor(tool('midnight_getDustBalance'), {unexpected: 1})).toBeUndefined()
  })

  // Midnight destructures `params[0]`, `params[1]`; MCP carries an object. Without the mapping a
  // perfectly-formed call reaches a handler that sees no arguments.
  it('maps named arguments into the array a positional handler destructures', () => {
    expect(paramsFor(tool('midnight_getTxHistory'), {pageNumber: 2, pageSize: 25})).toEqual([2, 25])
    // Order comes from the declaration, not from the object's key order.
    expect(paramsFor(tool('midnight_getTxHistory'), {pageSize: 25, pageNumber: 2})).toEqual([2, 25])
  })

  it('passes the arguments through for a handler that reads an object', () => {
    expect(paramsFor(tool('cardano_cip139_getPoolById'), {value: 'pool1abc'})).toEqual({value: 'pool1abc'})
  })

  // ⚠️ `scope` addresses the *wallet*, not the method. A connector method receiving an argument it does
  // not know either ignores it or refuses the call — Midnight's guards do the latter, so forwarding it
  // would break every nullary Midnight read the moment an agent named a scope.
  it('strips the scope argument before the params reach the connector', () => {
    expect(paramsFor(tool('cardano_cip139_getPoolById'), {value: 'pool1abc', scope: 'g1:0'})).toEqual({
      value: 'pool1abc',
    })
    expect(paramsFor(tool('midnight_getDustBalance'), {scope: 'g1:0'})).toBeUndefined()
    expect(paramsFor(tool('midnight_getTxHistory'), {pageNumber: 1, pageSize: 2, scope: 'g1:0'})).toEqual([1, 2])
  })

  it('reads the scope a call named', () => {
    expect(scopeFrom({scope: 'g1:0'})).toBe('g1:0')
    expect(scopeFrom({})).toBeUndefined()
    expect(scopeFrom(undefined)).toBeUndefined()
    // An empty string is not a scope; treating it as one would look up a key nothing can match.
    expect(scopeFrom({scope: ''})).toBeUndefined()
    expect(scopeFrom({scope: 7})).toBeUndefined()
  })

  // Every *required* argument must have a slot in the array, or an agent that satisfies the schema still
  // sends a hole and the handler refuses it — which reads to the agent as its own mistake. The reverse is
  // fine and common: a positional slot may be optional (`options` on the Midnight builders).
  it('carries every required argument in the positional array', () => {
    for (const t of FORWARDED) {
      if (t.positional === undefined) continue
      for (const key of t.descriptor.inputSchema.required ?? []) {
        expect(t.positional, `${t.descriptor.name}.${key} is required but has no positional slot`).toContain(key)
      }
    }
  })

  // Every declared argument name must appear in the schema's properties, or an agent cannot know to send
  // it and the positional array gets a hole.
  it('declares every positional argument as a property', () => {
    for (const t of FORWARDED) {
      for (const key of t.positional ?? []) {
        expect(Object.keys(t.descriptor.inputSchema.properties), `${t.descriptor.name}.${key}`).toContain(key)
      }
    }
  })
})

describe('effectiveScope', () => {
  // ⚠️ A co-funded Midnight send names every contributing wallet in `sources` and gives each its
  // remainder back, so no wallet owns the change and there is no answer to "which one is this
  // addressed to?". An agent that named all of them was still refused for not naming a scope.
  it('takes the scope from the first source for a Midnight co-funded send', () => {
    const scope = effectiveScope('midnight_buildCoFundedSend', {
      sources: [
        {scope: 'group-a:0', pledge: '1'},
        {scope: 'group-b:0', pledge: '2'},
      ],
    })
    expect(scope).toBe('group-a:0')
  })

  it('still honours a scope the caller named', () => {
    const scope = effectiveScope('midnight_buildCoFundedSend', {
      scope: 'group-z:0',
      sources: [{scope: 'group-a:0', pledge: '1'}],
    })
    expect(scope).toBe('group-z:0')
  })

  // Cardano's `scope` is the COMPOSER — it owns the change — so substituting a contributor would
  // silently pick whose wallet the leftovers land in.
  it('does not substitute for the Cardano co-funded send', () => {
    const scope = effectiveScope('cardano_buildCoFundedSend', {sources: [{scope: 'group-a:0'}]})
    expect(scope).toBeUndefined()
  })

  it('leaves every other tool alone', () => {
    expect(effectiveScope('cardano_readBalance', {sources: [{scope: 'group-a:0'}]})).toBeUndefined()
    expect(effectiveScope('cardano_readBalance', {scope: 'group-a:0'})).toBe('group-a:0')
  })

  it('answers undefined when sources are missing or malformed', () => {
    expect(effectiveScope('midnight_buildCoFundedSend', {})).toBeUndefined()
    expect(effectiveScope('midnight_buildCoFundedSend', {sources: []})).toBeUndefined()
    expect(effectiveScope('midnight_buildCoFundedSend', {sources: [{pledge: '1'}]})).toBeUndefined()
    expect(effectiveScope('midnight_buildCoFundedSend', null)).toBeUndefined()
  })
})
