import {afterEach, describe, expect, it} from 'vitest'
import {agentConfigBlock, agentPairingUri, agentServerName, forgetPairing, listPairings} from './pairing-api'

// ⚠️ A client's config is a map keyed by server name. Two Pnyx identities paired with the same agent
// under one key means the second block overwrites the first, and the person ends up talking to a
// wallet they did not choose — with nothing anywhere saying so.
describe('agentServerName', () => {
  const A = 'pnyx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqabc123'
  const B = 'pnyx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxyz789'

  it('names the server after the identity it belongs to', () => {
    expect(agentServerName(A)).toBe('pnyx_abc123')
  })

  it('gives two identities two different names', () => {
    expect(agentServerName(A)).not.toBe(agentServerName(B))
  })

  it('falls back to a bare name when there is no identity to key on', () => {
    expect(agentServerName(undefined)).toBe('pnyx')
    expect(agentServerName('')).toBe('pnyx')
  })

  // The name lands in a JSON config key and in a URI parameter, so anything that would need escaping
  // in either is dropped rather than carried through.
  it('keeps the name to characters a config key can hold', () => {
    expect(agentServerName('pnyx1_a-b.c/d e!f')).toMatch(/^pnyx_[a-z0-9]+$/)
  })

  it('puts that name in the config block and the pairing uri', () => {
    expect(JSON.parse(agentConfigBlock('tok', A)).mcpServers).toHaveProperty('pnyx_abc123')
    expect(agentPairingUri('tok', A)).toContain('name=pnyx_abc123')
  })
})

// ⚠️ The 404 that is not a missing route. This rewrote *every* 404 into "this deployment has no agent
// pairing" — shown on a screen that had just listed seven of them, against a service whose pairing
// routes all worked and which was only missing the newest one.
describe('a 404 from the pairing service', () => {
  const respondWith = (body: unknown, status = 404) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: {'content-type': 'application/json'},
      })) as unknown as typeof fetch
  }
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('keeps what the service said when a handler actually answered', async () => {
    respondWith({error: 'no revoked pairing with that id'})
    await expect(forgetPairing('session', 'abc')).rejects.toThrow('no revoked pairing with that id')
  })

  // The router's own fallthrough is the only 404 that means "this deployment does not have that route".
  it('says the deployment is out of date when the router did not know the route', async () => {
    respondWith({error: 'not found'})
    await expect(forgetPairing('session', 'abc')).rejects.toThrow(/older than this app/)
  })

  // The list route is the one every deployment with pairing has, so its absence means something else.
  it('says pairing is not configured at all when even the list route is unknown', async () => {
    respondWith({error: 'not found'})
    await expect(listPairings('session')).rejects.toThrow(/no agent pairing/)
  })
})
