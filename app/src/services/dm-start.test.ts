import {encodePnyxId} from '@pnyx/contract-client/identity'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

// Local state is mocked at the platform boundary; everything else — MLS, the row lookup contract,
// the verification step — is the real implementation, because those are what the test is about.
const backing = new Map<string, string>()
vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      backing.set(key, String(value))
    },
    remove: async (key: string) => {
      backing.delete(key)
    },
    getSync: (key: string) => backing.get(key) ?? null,
  },
}))

const api = {
  claimKeyPackage: vi.fn(),
  deliverWelcome: vi.fn(),
}
const resolveMock = vi.fn()
vi.mock('./identity-row', () => ({resolveIdentityRow: (...a: unknown[]) => resolveMock(...a)}))

vi.mock('./dm-api', async () => {
  const actual = await vi.importActual<typeof import('./dm-api')>('./dm-api')
  return {...actual, dmApi: api}
})

const {startDmConversation} = await import('./dm-start')
const {conversationId} = await import('./dm-crypto')
const {deriveMlsIdentity, dmCiphersuite, encodeMlsKeyPackage, makeDmKeyPackage} = await import('./dm-mls')

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)

const SELF_ID = encodePnyxId(new Uint8Array(32).fill(0x51))
const PEER_ID = encodePnyxId(new Uint8Array(32).fill(0x52))
const IMPOSTOR_ID = encodePnyxId(new Uint8Array(32).fill(0x53))
const SELF_ROOT = new Uint8Array(32).fill(1)
const PEER_ROOT = new Uint8Array(32).fill(2)

const input = () => ({
  token: 'tok',
  selfIdentity: SELF_ID,
  peerIdentity: PEER_ID,
  forumRoot: SELF_ROOT,
  network: 'mainnet',
})

/** A real KeyPackage for the peer, anchored on `root` and credentialled to `pnyxId`. */
const peerKeyPackage = async (root: Uint8Array, pnyxId: string): Promise<Uint8Array> => {
  const cs = await run(dmCiphersuite())
  const identity = await run(deriveMlsIdentity(root))
  const kp = await run(makeDmKeyPackage(identity, pnyxId, cs))
  return encodeMlsKeyPackage(kp.publicPackage)
}

/** A published row for the peer: the anchor is their MLS signature key, as the circuit stored it. */
const peerRow = async (root: Uint8Array) => {
  const identity = await run(deriveMlsIdentity(root))
  return {anchor: identity.publicKey, authPub: new Uint8Array(32).fill(1), name: new Uint8Array(32)}
}

beforeEach(() => {
  backing.clear()
  resolveMock.mockReset()
  api.claimKeyPackage.mockReset()
  api.deliverWelcome.mockReset()
})

describe('startDmConversation', () => {
  it('creates the group, persists state, and delivers the Welcome', async () => {
    resolveMock.mockResolvedValue({kind: 'row', row: await peerRow(PEER_ROOT)})
    api.claimKeyPackage.mockResolvedValue(await peerKeyPackage(PEER_ROOT, PEER_ID))
    // Returns the delivery result now, not void: the service hands back a permit when it mints one.
    api.deliverWelcome.mockResolvedValue({})

    const result = await startDmConversation(input())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.convId).toBe(conversationId(SELF_ID, PEER_ID))
    // State must exist before the Welcome goes out, or the peer joins a group we cannot decrypt.
    expect(backing.has(`@pnyx/dm/state/${result.convId}`)).toBe(true)
    expect(api.deliverWelcome).toHaveBeenCalledTimes(1)
  })

  it('adopts a conversation this device already holds instead of building a second one', async () => {
    // ⚠️ The regression. A conversation id is derived, not allocated, so starting one with the same
    // peer twice names the same conversation. The second attempt used to claim another of the
    // peer's single-use KeyPackages and deliver a Welcome whose id collides with the pending one —
    // which the service answered with a 500 the user read as "can't reach". Backing out of a new
    // conversation before sending is exactly how you get here, because nothing on screen shows a
    // conversation with no messages in it.
    resolveMock.mockResolvedValue({kind: 'row', row: await peerRow(PEER_ROOT)})
    api.claimKeyPackage.mockResolvedValue(await peerKeyPackage(PEER_ROOT, PEER_ID))
    api.deliverWelcome.mockResolvedValue({})

    const first = await startDmConversation(input())
    expect(first.ok).toBe(true)
    api.claimKeyPackage.mockClear()
    api.deliverWelcome.mockClear()

    const second = await startDmConversation(input())
    expect(second).toEqual({ok: true, convId: conversationId(SELF_ID, PEER_ID)})
    // The two that cost something: a KeyPackage is single-use, and a duplicate Welcome is the 500.
    expect(api.claimKeyPackage).not.toHaveBeenCalled()
    expect(api.deliverWelcome).not.toHaveBeenCalled()
  })

  it('rebuilds when group state exists but the Welcome never landed', async () => {
    // ⚠️ The other half of adoption. State is written before the Welcome and the index row after it,
    // so state-without-a-row means the previous attempt died in between: we hold a group the peer
    // was never invited into. Adopting that would strand the conversation permanently, with no
    // symptom until someone sends a message nobody can read.
    resolveMock.mockResolvedValue({kind: 'row', row: await peerRow(PEER_ROOT)})
    api.claimKeyPackage.mockResolvedValue(await peerKeyPackage(PEER_ROOT, PEER_ID))
    api.deliverWelcome.mockRejectedValueOnce(new Error('the service fell over'))

    const failed = await startDmConversation(input())
    expect(failed.ok).toBe(false)

    api.claimKeyPackage.mockResolvedValue(await peerKeyPackage(PEER_ROOT, PEER_ID))
    api.deliverWelcome.mockResolvedValue({})
    // Cleared, or the failed first attempt's own call satisfies the assertion below and the test
    // passes whether or not the retry rebuilt anything.
    api.claimKeyPackage.mockClear()
    api.deliverWelcome.mockClear()
    const retry = await startDmConversation(input())

    expect(retry).toEqual({ok: true, convId: conversationId(SELF_ID, PEER_ID)})
    // Rebuilt, not adopted: the peer has to be invited into a group that actually reaches them.
    expect(api.deliverWelcome).toHaveBeenCalledTimes(1)
    expect(api.claimKeyPackage).toHaveBeenCalledTimes(1)
  })

  it('reports chain-unavailable on 503 rather than blaming the peer', async () => {
    resolveMock.mockResolvedValue({kind: 'unavailable'})
    const result = await startDmConversation(input())
    expect(result).toEqual({ok: false, failure: {kind: 'chain-unavailable'}})
    // No package consumed when we could never have verified it.
    expect(api.claimKeyPackage).not.toHaveBeenCalled()
  })

  it('reports peer-not-published when no row resolves', async () => {
    resolveMock.mockResolvedValue({kind: 'unpublished'})
    const result = await startDmConversation(input())
    expect(result).toEqual({ok: false, failure: {kind: 'peer-not-published'}})
    expect(api.claimKeyPackage).not.toHaveBeenCalled()
  })

  // The `mn_addr`-keyed keybook this replaced needed an "ignore an entry signed by somebody else"
  // test, because anyone could write an entry naming any address. That case cannot arise now: a row
  // is keyed by a commitment only its own secret can open, so there is nothing to impersonate and
  // nothing to filter. What survives is the KeyPackage check below — which is what the anchor was
  // ever for.
  it('does not consume a package when the peer has no row', async () => {
    resolveMock.mockResolvedValue({kind: 'unpublished'})
    const result = await startDmConversation(input())
    expect(result).toEqual({ok: false, failure: {kind: 'peer-not-published'}})
    expect(api.claimKeyPackage).not.toHaveBeenCalled()
  })

  it('reports peer-no-key-packages when the pool is empty', async () => {
    resolveMock.mockResolvedValue({kind: 'row', row: await peerRow(PEER_ROOT)})
    api.claimKeyPackage.mockResolvedValue(undefined)
    const result = await startDmConversation(input())
    expect(result).toEqual({ok: false, failure: {kind: 'peer-no-key-packages'}})
    expect(api.deliverWelcome).not.toHaveBeenCalled()
  })

  it('rejects a KeyPackage that does not match the anchor, and starts nothing', async () => {
    // The attack the anchor exists to stop: the delivery service substitutes a package it controls,
    // which would put it inside the conversation. The anchor is the peer's; the package is not.
    resolveMock.mockResolvedValue({kind: 'row', row: await peerRow(PEER_ROOT)})
    api.claimKeyPackage.mockResolvedValue(await peerKeyPackage(new Uint8Array(32).fill(9), PEER_ID))

    const result = await startDmConversation(input())
    expect(result).toEqual({ok: false, failure: {kind: 'key-package-rejected'}})
    expect(api.deliverWelcome).not.toHaveBeenCalled()
    expect([...backing.keys()].filter((k) => k.startsWith('@pnyx/dm/state/'))).toHaveLength(0)
  })

  it('rejects a package whose credential names a different identity', async () => {
    resolveMock.mockResolvedValue({kind: 'row', row: await peerRow(PEER_ROOT)})
    api.claimKeyPackage.mockResolvedValue(await peerKeyPackage(PEER_ROOT, IMPOSTOR_ID))
    const result = await startDmConversation(input())
    expect(result).toEqual({ok: false, failure: {kind: 'key-package-rejected'}})
  })

  it('surfaces an unexpected failure as failed rather than swallowing it', async () => {
    resolveMock.mockRejectedValue(new Error('boom'))
    const result = await startDmConversation(input())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('failed')
  })
})

describe('a note to self', () => {
  const selfInput = () => ({...input(), peerIdentity: SELF_ID})

  /**
   * ⚠️ **There is no self-conversation any more.** It used to be a real MLS group of one. Once a
   * note to self stopped posting and stopped fetching, that group encrypted nothing, and the only
   * thing the signed-in variant still cost was a *second* notes thread — so notes written signed out
   * became invisible on sign-in. Callers route to the local scratchpad instead.
   */
  it('refuses to build a group for one member, and says why', async () => {
    const result = await startDmConversation(selfInput())
    expect(result).toEqual({ok: false, failure: {kind: 'self-conversation'}})
  })

  it('builds nothing at all — no group, and none of the peer steps', async () => {
    const before = [...backing.keys()]
    await startDmConversation(selfInput())
    expect([...backing.keys()]).toEqual(before)
    expect(resolveMock).not.toHaveBeenCalled()
    expect(api.claimKeyPackage).not.toHaveBeenCalled()
    expect(api.deliverWelcome).not.toHaveBeenCalled()
  })
})
