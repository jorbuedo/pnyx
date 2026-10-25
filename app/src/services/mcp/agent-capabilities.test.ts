// These values decide what an agent is granted, what it is shown, and what it is refused — three places
// that must agree. The tests are here rather than on a screen because that agreement is the behaviour.
import {describe, expect, it} from 'vitest'
import {
  type AgentCapabilities,
  anyGranted,
  capabilitiesForAgent,
  DEFAULT_AGENT_CAPABILITIES,
  grantedChains,
  hasScope,
  parseAgentCapabilities,
  parseAgentCapabilityBook,
  refusedForCapability,
  refusedForLocalTool,
  resolveScope,
  scopeKey,
  servingBlocker,
  sharedOnly,
  toolAllowed,
} from './agent-capabilities'

const caps = (over: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  ...DEFAULT_AGENT_CAPABILITIES,
  scopes: [{groupId: 'g1', accountIndex: 0}],
  ...over,
})

describe('the defaults', () => {
  // History reads the local cache for the granted accounts — the same rows the activity screen shows,
  // all of it public chain data — so it is on, with a toggle for anyone who wants it off.
  it('serves both chains and the wallet’s own history', () => {
    expect(DEFAULT_AGENT_CAPABILITIES).toEqual({cardano: true, midnight: true, history: true, scopes: []})
  })

  // ⚠️ No guessed wallet or account. A pinned index is invisible to testing and has cost this app six
  // production bugs; the screen seeds this from what the user selected, which this module cannot know.
  it('guesses no wallet or account', () => {
    expect(DEFAULT_AGENT_CAPABILITIES.scopes).toEqual([])
  })
})

describe('grantedChains', () => {
  it('lists only what is on, in a stable order', () => {
    expect(grantedChains(caps())).toEqual(['cardano', 'midnight'])
    expect(grantedChains(caps({midnight: false}))).toEqual(['cardano'])
    expect(grantedChains(caps({cardano: false}))).toEqual(['midnight'])
    expect(grantedChains(caps({cardano: false, midnight: false}))).toEqual([])
  })
})

describe('servingBlocker', () => {
  it('allows a servable set', () => {
    expect(servingBlocker(caps())).toBeUndefined()
  })

  // ⚠️ Refused *before* the socket opens. Granting nothing and connecting anyway leaves an agent talking
  // to a wallet that refuses every call, which reads as broken rather than as a setting.
  it('blocks with no chain and with no account', () => {
    expect(servingBlocker(caps({cardano: false, midnight: false}))).toBe('no-chain')
    expect(servingBlocker(caps({scopes: []}))).toBe('no-scope')
  })

  it('reports the missing chain first, since it is the broader refusal', () => {
    expect(servingBlocker(caps({cardano: false, midnight: false, scopes: []}))).toBe('no-chain')
  })
})

describe('toolAllowed', () => {
  it('follows the chain a tool is prefixed with', () => {
    expect(toolAllowed('cardano_getBalance', caps({midnight: false}))).toBe(true)
    expect(toolAllowed('midnight_getDustBalance', caps({midnight: false}))).toBe(false)
    expect(toolAllowed('cardano_getBalance', caps({cardano: false}))).toBe(false)
  })

  it('gates history on its own capability, on top of its chain', () => {
    expect(toolAllowed('midnight_getTxHistory', caps({history: false}))).toBe(false)
    expect(toolAllowed('midnight_getTxHistory', caps({history: true}))).toBe(true)
    // And the chain still has to be on: history is an extra permission, not a bypass. ⚠️ This asserted
    // `true` while its own comment said otherwise — so a wallet with Midnight off was *shown* the tool
    // and then refused it at call time, which is the exact defect the filter exists to prevent.
    expect(toolAllowed('midnight_getTxHistory', caps({history: true, midnight: false}))).toBe(false)
  })

  // ⚠️ The near-miss a prefix test would cause: this reads one transaction's UTxOs, not a history, and
  // catching it would withhold a chain read nobody restricted.
  it('does not treat every tool mentioning a transaction as history', () => {
    expect(toolAllowed('cardano_cip139_getUtxosByTransactionHash', caps({history: false}))).toBe(true)
  })

  it('refuses a name the catalogue would never produce', () => {
    expect(toolAllowed('drainWallet', caps())).toBe(false)
    expect(toolAllowed('', caps())).toBe(false)
  })
})

describe('refusedForCapability', () => {
  it('allows what is granted', () => {
    expect(refusedForCapability('cardano', 'getBalance', caps())).toBeUndefined()
    expect(refusedForCapability('midnight', 'getTxHistory', caps({history: true}))).toBeUndefined()
  })

  // The call-time half. A filtered `tools/list` is presentation — a client can name any tool without
  // listing first, so this is the control.
  it('refuses a call for a chain that is off, even though the list hid it', () => {
    expect(refusedForCapability('midnight', 'getDustBalance', caps({midnight: false}))).toContain('Midnight')
    expect(refusedForCapability('cardano', 'getBalance', caps({cardano: false}))).toContain('Cardano')
  })

  it('refuses history by method, since the tool name is gone by then', () => {
    expect(refusedForCapability('midnight', 'getTxHistory', caps({history: false}))).toContain('transaction history')
  })

  // An agent shows this to a person, so it has to name the setting to change. "Refused" alone invites a
  // retry loop against a wallet that will never say yes.
  it('names where to change it', () => {
    for (const message of [
      refusedForCapability('cardano', 'getBalance', caps({cardano: false})),
      refusedForCapability('midnight', 'getTxHistory', caps({history: false})),
    ]) {
      expect(message).toContain('AI agents')
      expect(message).toContain('Access')
    }
  })
})

describe('parseAgentCapabilities', () => {
  it('round-trips a stored value', () => {
    const stored = {
      cardano: false,
      midnight: true,
      history: true,
      scopes: [
        {groupId: 'g1', accountIndex: 0},
        {groupId: 'g2', accountIndex: 3},
      ],
    }
    expect(parseAgentCapabilities(stored)).toEqual(stored)
  })

  it('falls back to the defaults for anything unreadable', () => {
    expect(parseAgentCapabilities(null)).toEqual(DEFAULT_AGENT_CAPABILITIES)
    expect(parseAgentCapabilities('yes')).toEqual(DEFAULT_AGENT_CAPABILITIES)
    expect(parseAgentCapabilities({})).toEqual(DEFAULT_AGENT_CAPABILITIES)
    // A flag of the wrong type takes the default rather than becoming truthy.
    expect(parseAgentCapabilities({cardano: 'no'}).cardano).toBe(true)
  })

  // ⚠️ Stored scopes are user data that has to survive a downgrade, and a fractional or negative index
  // reaches key derivation as a crash rather than a refusal.
  it('keeps only whole, non-negative indexes under a real wallet, deduplicated and sorted', () => {
    const parsed = parseAgentCapabilities({
      scopes: [
        {groupId: 'g2', accountIndex: 1},
        {groupId: 'g1', accountIndex: 3},
        {groupId: 'g1', accountIndex: 0},
        {groupId: 'g1', accountIndex: 0},
        {groupId: 'g1', accountIndex: -1},
        {groupId: 'g1', accountIndex: 1.5},
        {groupId: '', accountIndex: 0},
        {accountIndex: 0},
        null,
        'nope',
      ],
    })
    expect(parsed.scopes).toEqual([
      {groupId: 'g1', accountIndex: 0},
      {groupId: 'g1', accountIndex: 3},
      {groupId: 'g2', accountIndex: 1},
    ])
  })

  it('reads an absent scope list as none rather than inventing one', () => {
    expect(parseAgentCapabilities({cardano: true}).scopes).toEqual([])
  })
})

describe('scopes', () => {
  const g1a0 = {groupId: 'g1', accountIndex: 0}
  const g2a0 = {groupId: 'g2', accountIndex: 0}

  // ⚠️ The whole point of the change: an account number alone is not a scope. Two wallets both have an
  // account 0, and granting one must not grant the other.
  it('tells the same account index in two wallets apart', () => {
    const granted = caps({scopes: [g1a0]})
    expect(hasScope(granted, g1a0)).toBe(true)
    expect(hasScope(granted, g2a0)).toBe(false)
    expect(scopeKey(g1a0)).not.toBe(scopeKey(g2a0))
  })

  it('is servable with a scope in any wallet', () => {
    expect(servingBlocker(caps({scopes: [g2a0]}))).toBeUndefined()
  })
})

describe('resolveScope', () => {
  const a = {groupId: 'g1', accountIndex: 0}
  const b = {groupId: 'g2', accountIndex: 3}

  // The common case stays free of ceremony: one granted scope needs no argument.
  it('uses the only granted scope when none is named', () => {
    expect(resolveScope(undefined, [a])).toEqual({kind: 'scope', scope: a})
  })

  // ⚠️ Guessing here would move funds from a wallet nobody named, so it refuses and lists the choices.
  it('refuses to guess when several are granted, and says which', () => {
    const out = resolveScope(undefined, [a, b])
    expect(out.kind).toBe('error')
    if (out.kind !== 'error') throw new Error('expected an error')
    expect(out.message).toContain(scopeKey(a))
    expect(out.message).toContain(scopeKey(b))
    expect(out.message).toContain('scope')
  })

  it('resolves a named scope', () => {
    expect(resolveScope(scopeKey(b), [a, b])).toEqual({kind: 'scope', scope: b})
  })

  // An agent naming a scope it was not granted must be told, not silently served another wallet.
  it('refuses a scope that is not granted, and lists what is', () => {
    const out = resolveScope('g9:0', [a])
    expect(out.kind).toBe('error')
    if (out.kind !== 'error') throw new Error('expected an error')
    expect(out.message).toContain('g9:0')
    expect(out.message).toContain(scopeKey(a))
  })

  it('says so plainly when nothing is granted', () => {
    for (const out of [resolveScope(undefined, []), resolveScope('g1:0', [])]) {
      expect(out.kind).toBe('error')
      if (out.kind !== 'error') throw new Error('expected an error')
      expect(out.message).toContain('no accounts')
    }
  })

  // ⚠️ The same account index in two wallets is two scopes; a key match must not cross wallets.
  it('does not match a scope key across wallets', () => {
    expect(resolveScope('g2:0', [{groupId: 'g1', accountIndex: 0}]).kind).toBe('error')
  })
})

// The builders and the history read never reach the connector, so `refusedForCapability` cannot see
// them. This is the door for those; `toolAllowed` is only the menu.
describe('refusedForLocalTool', () => {
  it('lets a granted local tool through', () => {
    expect(refusedForLocalTool('cardano_listHistory', caps({cardano: true, history: true}))).toBeUndefined()
  })

  it('refuses a Cardano builder when Cardano is off, naming the setting', () => {
    expect(refusedForLocalTool('cardano_buildTransfer', caps({cardano: false}))).toContain('Cardano access')
  })

  it('refuses the history read when history is off, even though its chain is on', () => {
    const refusal = refusedForLocalTool('cardano_listHistory', caps({cardano: true, history: false}))
    expect(refusal).toContain('transaction history')
  })

  // A name this catalogue never produces reaches the runner only if something has gone wrong upstream;
  // refusing by name beats answering it.
  it('refuses a tool it does not recognise', () => {
    expect(refusedForLocalTool('drain_everything', caps({}))).toContain('drain_everything')
  })
})

// ⚠️ Where an agent actually looks. The wallet names are already in the `initialize` instructions, and
// a local model driving these tools still answered "I don't have access to the internal mapping of
// wallet group IDs to wallet names" — while listing the two keys it had just been handed. It read the
// tool result in front of it, not the guidance from the start of the session.
describe('naming the wallets a scope refers to', () => {
  const two = [
    {groupId: 'group-079851260033977a0961e83d89f4b70c', accountIndex: 0},
    {groupId: 'group-7a1d3e33d2a6ead9bcda53dfb88cbf33', accountIndex: 0},
  ]
  const labels = new Map([
    ['group-079851260033977a0961e83d89f4b70c:0', 'Abandon 12 · Account 0'],
    ['group-7a1d3e33d2a6ead9bcda53dfb88cbf33:0', 'Daily wallet · Account 0'],
  ])

  it('names each wallet when a call has to choose between several', () => {
    const out = resolveScope(undefined, two, labels)
    expect(out.kind).toBe('error')
    const message = out.kind === 'error' ? out.message : ''
    expect(message).toContain('Abandon 12 · Account 0')
    expect(message).toContain('Daily wallet · Account 0')
    // The key is still there: it is what has to be sent back.
    expect(message).toContain('group-079851260033977a0961e83d89f4b70c:0')
  })

  it('names them when the scope it was given is not granted', () => {
    const out = resolveScope('group-nope:0', two, labels)
    expect(out.kind === 'error' && out.message).toContain('Daily wallet')
  })

  // A label nobody supplied must not become "key (key)" — the wrapping parentheses around the list
  // are the message's own, so the check is that no key is followed by a copy of itself.
  it('falls back to the bare key rather than repeating it', () => {
    const bare = resolveScope(undefined, two)
    const message = bare.kind === 'error' ? bare.message : ''
    expect(message).toContain('group-079851260033977a0961e83d89f4b70c:0,')
    expect(message).not.toMatch(/group-\w+:0 \(/)
    // And a label equal to the key is treated as no label at all.
    const echoed = resolveScope(
      undefined,
      two,
      new Map([['group-079851260033977a0961e83d89f4b70c:0', 'group-079851260033977a0961e83d89f4b70c:0']]),
    )
    expect(echoed.kind === 'error' && echoed.message).not.toMatch(/group-\w+:0 \(group/)
  })

  it('still resolves without ceremony when only one is granted', () => {
    expect(resolveScope(undefined, [two[0] as never], labels)).toEqual({kind: 'scope', scope: two[0]})
  })
})

describe('capabilitiesForAgent', () => {
  const shared: AgentCapabilities = {
    cardano: true,
    midnight: true,
    history: true,
    scopes: [{groupId: 'g1', accountIndex: 0}],
  }
  const strict: AgentCapabilities = {
    cardano: true,
    midnight: false,
    history: false,
    scopes: [{groupId: 'g1', accountIndex: 0}],
  }
  const book = {shared, perAgent: {'pair-strict': strict}}

  it('gives an agent its own override', () => {
    expect(capabilitiesForAgent(book, 'pair-strict')).toEqual(strict)
  })

  it('gives an agent with no override the shared set', () => {
    expect(capabilitiesForAgent(book, 'pair-unknown')).toEqual(shared)
  })

  it('gives an UNATTRIBUTED call the shared set, not the strictest override', () => {
    // `undefined` means the relay did not say who is calling — an older relay deployment, not a
    // suspicious agent. Refusing it would stop serving against a relay that predates attribution.
    expect(capabilitiesForAgent(book, undefined)).toEqual(shared)
  })

  it('never leaks one agent’s override to another', () => {
    const two = {shared, perAgent: {a: strict, b: shared}}
    expect(capabilitiesForAgent(two, 'a')).toEqual(strict)
    expect(capabilitiesForAgent(two, 'b')).toEqual(shared)
  })
})

describe('anyGranted', () => {
  const a: AgentCapabilities = {
    cardano: true,
    midnight: false,
    history: false,
    scopes: [{groupId: 'g1', accountIndex: 0}],
  }
  const b: AgentCapabilities = {
    cardano: false,
    midnight: true,
    history: true,
    scopes: [{groupId: 'g2', accountIndex: 1}],
  }

  it('unions the chains, so a socket opens for whatever any agent may reach', () => {
    const union = anyGranted({shared: a, perAgent: {b}})
    expect(union.cardano).toBe(true)
    expect(union.midnight).toBe(true)
    expect(union.history).toBe(true)
  })

  it('unions the scopes and deduplicates them', () => {
    const union = anyGranted({shared: a, perAgent: {b, c: a}})
    expect(union.scopes.map(scopeKey).sort()).toEqual(['g1:0', 'g2:1'])
  })

  it('is servable when one agent grants something even though another grants nothing', () => {
    const nothing: AgentCapabilities = {cardano: false, midnight: false, history: false, scopes: []}
    expect(servingBlocker(nothing)).toBeDefined()
    expect(servingBlocker(anyGranted({shared: nothing, perAgent: {a}}))).toBeUndefined()
  })

  it('⚠️ is the union and must never be used to gate a call', () => {
    // Stated as a test because using it that way would hand every agent the most permissive entry.
    const union = anyGranted({shared: a, perAgent: {b}})
    expect(union.midnight).toBe(true)
    expect(capabilitiesForAgent({shared: a, perAgent: {b}}, undefined).midnight).toBe(false)
  })
})

describe('sharedOnly', () => {
  it('overrides nothing, so every agent resolves to the same set', () => {
    const book = sharedOnly(DEFAULT_AGENT_CAPABILITIES)
    expect(capabilitiesForAgent(book, 'anyone')).toEqual(DEFAULT_AGENT_CAPABILITIES)
    expect(capabilitiesForAgent(book, undefined)).toEqual(DEFAULT_AGENT_CAPABILITIES)
    expect(anyGranted(book)).toEqual(DEFAULT_AGENT_CAPABILITIES)
  })
})

describe('parseAgentCapabilityBook', () => {
  it('reads the OLD stored shape as the shared set', () => {
    // ⚠️ The migration that matters: before overrides this key held one bare capabilities object.
    // Reading it as an empty book would turn `midnight` back ON for someone who turned it off.
    const old = {
      cardano: true,
      midnight: false,
      history: false,
      scopes: [{groupId: 'g1', accountIndex: 2}],
    }
    const book = parseAgentCapabilityBook(old)
    expect(book.shared).toEqual(old)
    expect(book.perAgent).toEqual({})
    expect(capabilitiesForAgent(book, 'anyone').midnight).toBe(false)
  })

  it('reads the new shape with its overrides', () => {
    const book = parseAgentCapabilityBook({
      shared: {cardano: true, midnight: true, history: true, scopes: []},
      perAgent: {p1: {cardano: true, midnight: false, history: false, scopes: []}},
    })
    expect(book.shared.midnight).toBe(true)
    expect(book.perAgent.p1?.midnight).toBe(false)
  })

  it('drops an unusable override rather than defaulting it', () => {
    // A default here would be MORE permissive than whatever was chosen.
    const book = parseAgentCapabilityBook({
      shared: {cardano: true, midnight: true, history: true, scopes: []},
      perAgent: {p1: 'nonsense', '': {cardano: false, midnight: false, history: false, scopes: []}},
    })
    expect(book.perAgent).toEqual({})
  })

  it('falls back to the defaults for a value that is not an object at all', () => {
    for (const bad of [null, 'x', 3, undefined]) {
      expect(parseAgentCapabilityBook(bad)).toEqual(sharedOnly(DEFAULT_AGENT_CAPABILITIES))
    }
  })
})
