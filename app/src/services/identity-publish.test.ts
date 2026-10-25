import {afterEach, describe, expect, it, vi} from 'vitest'
import {IdentityPublishError, publishIdentityRow} from './identity-publish'

vi.mock('./pnyx-session', () => ({serviceUrl: () => 'http://svc'}))
vi.mock('./pnyx-artifacts', () => ({ensureCircuitArtifacts: async () => ({})}))

const buildMock = vi.fn()
vi.mock('@pnyx/midnight-native', () => ({
  buildPublishRowProvenTx: (...args: unknown[]) => buildMock(...args),
}))

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

afterEach(() => {
  vi.restoreAllMocks()
  buildMock.mockReset()
})

const mockFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch)
}

describe('publishIdentityRow', () => {
  const inputs = {
    artifacts: {zkirPath: 'z', proverKeyPath: 'p', verifierKeyPath: 'v', paramsPath: 'k'},
    contractState: new Uint8Array([1, 2, 3]),
    contractAddress: bytes32(9),
    anchor: bytes32(0x70),
    authPub: bytes32(0x71),
    name: new Uint8Array(32),
    identitySk: bytes32(0x2a),
    networkId: 'undeployed',
    expiresAtSecs: Math.floor(Date.UTC(2026, 7, 2, 12) / 1000) + 3600,
  }

  it('proves on-device and relays the bytes', async () => {
    buildMock.mockResolvedValue(new Uint8Array([0xaa, 0xbb]))
    let body: string | undefined
    mockFetch(async (url, init) => {
      expect(url).toBe('http://svc/register')
      body = init?.body as string
      return new Response('{}', {status: 202})
    })
    await publishIdentityRow(inputs)
    expect(buildMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(body ?? '{}').tx).toBe(Buffer.from([0xaa, 0xbb]).toString('base64'))
  })

  // The native field is a TTL *timestamp*, not a duration. Passing the duration its name suggests
  // stamps Timestamp(3600) — 1970 — onto the intent, and the node rejects it as already expired,
  // which reaches the app as a bare 502 from the relay. Cost a device round trip to find.
  it('passes the expiry through as an absolute timestamp', async () => {
    buildMock.mockResolvedValue(new Uint8Array([1]))
    mockFetch(async () => new Response('{}', {status: 202}))
    await publishIdentityRow(inputs)
    const passed = buildMock.mock.calls[0]?.[0] as {ttlSecs: number}
    expect(passed.ttlSecs).toBe(inputs.expiresAtSecs)
    // A plausible unix second, not a duration: any 1970-shaped value is the bug.
    expect(passed.ttlSecs).toBeGreaterThan(Date.UTC(2020, 0, 1) / 1000)
  })

  // The secret must never leave the device: it is an input to the proof, never to the request.
  it('never sends the identity secret', async () => {
    buildMock.mockResolvedValue(new Uint8Array([1]))
    let body = ''
    mockFetch(async (_url, init) => {
      body = (init?.body as string) ?? ''
      return new Response('{}', {status: 202})
    })
    await publishIdentityRow(inputs)
    expect(body).not.toContain(hex(inputs.identitySk))
  })

  it('distinguishes a proving failure from a relay failure', async () => {
    buildMock.mockRejectedValue(new Error('no artifacts'))
    mockFetch(async () => new Response('{}', {status: 202}))
    await expect(publishIdentityRow(inputs)).rejects.toMatchObject({stage: 'proof'})

    buildMock.mockResolvedValue(new Uint8Array([1]))
    mockFetch(async () => new Response('{}', {status: 502}))
    await expect(publishIdentityRow(inputs)).rejects.toBeInstanceOf(IdentityPublishError)
    await expect(publishIdentityRow(inputs)).rejects.toMatchObject({stage: 'relay'})
  })
})
