// The URL shape, which is the part that fails silently: an `https` base left unswapped produces a
// socket the platform refuses, and an unencoded ticket is a 401 that reads like a revoked session.
import {describe, expect, it} from 'vitest'
import {buildMcpSocketUrl, mcpSocketUrl} from './socket-url'

describe('buildMcpSocketUrl', () => {
  it('swaps http for ws and https for wss', () => {
    expect(buildMcpSocketUrl('https://pnyx.example', 't')).toBe('wss://pnyx.example/mcp/socket?ticket=t')
    expect(buildMcpSocketUrl('http://localhost:3300', 't')).toBe('ws://localhost:3300/mcp/socket?ticket=t')
  })

  it('encodes the ticket, which is a JWT and carries dots and dashes', () => {
    const ticket = 'a.b+c/d=e'
    expect(buildMcpSocketUrl('https://pnyx.example', ticket)).toBe(
      `wss://pnyx.example/mcp/socket?ticket=${encodeURIComponent(ticket)}`,
    )
  })
})

// A 401 is the one refusal retrying can never fix: the session token lives an hour and nothing renews
// it, so before this told the two apart the host backed off for ever and the screen said `Connecting…`
// while every agent was told the wallet is not connected.
describe('mcpSocketUrl tells an expired session from a transient refusal', () => {
  const withFetch = async (reply: () => Promise<unknown>) => {
    const original = globalThis.fetch
    globalThis.fetch = reply as unknown as typeof globalThis.fetch
    try {
      return await mcpSocketUrl('a-session-token')
    } finally {
      globalThis.fetch = original
    }
  }

  it('reports an expired session on 401', async () => {
    const result = await withFetch(async () => ({ok: false, status: 401}))
    expect(result).toEqual({kind: 'expired'})
  })

  it('reports retry on any other refusal, which another attempt may not hit', async () => {
    expect(await withFetch(async () => ({ok: false, status: 503}))).toEqual({kind: 'retry'})
    expect(await withFetch(async () => ({ok: false, status: 500}))).toEqual({kind: 'retry'})
  })

  it('reports retry when the service cannot be reached at all', async () => {
    expect(
      await withFetch(async () => {
        throw new Error('network down')
      }),
    ).toEqual({kind: 'retry'})
  })

  it('reports retry, not expiry, when a 200 carries no ticket', async () => {
    expect(await withFetch(async () => ({ok: true, status: 200, json: async () => ({})}))).toEqual({kind: 'retry'})
  })
})
