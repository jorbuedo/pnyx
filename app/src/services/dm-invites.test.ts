import {encodePnyxId, identityCommitmentOf} from '@pnyx/contract-client/identity'
import {sha256} from '@pnyx/crypto'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

/**
 * Two devices with one in-memory store each, switched by `h.activeDevice`. That separation is what
 * makes a genuine two-party round trip possible: if sender and recipient shared local state the test
 * would prove nothing about the Welcome path.
 *
 * Built through `vi.hoisted` because the mock factories are hoisted above ordinary declarations, so
 * anything they close over has to be created at hoist time too.
 */
const h = vi.hoisted(() => {
  const stores = {alice: new Map<string, string>(), bob: new Map<string, string>()}
  const state = {activeDevice: 'alice' as 'alice' | 'bob'}
  const active = (): Map<string, string> => stores[state.activeDevice]
  /** Stand-in for the delivery service: KeyPackage pool and Welcome queue. */
  const server = {
    packages: new Map<string, Uint8Array[]>(),
    welcomes: new Map<string, {convId: string; sender: string; welcome: Uint8Array; ratchetTree: Uint8Array}[]>(),
  }
  return {stores, state, active, server}
})

vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => h.active().get(key) ?? null,
    set: async (key: string, value: string) => {
      h.active().set(key, String(value))
    },
    remove: async (key: string) => {
      h.active().delete(key)
    },
    getSync: (key: string) => h.active().get(key) ?? null,
  },
}))

/**
 * An in-memory stand-in for the delivery service, installed over `fetch` rather than by mocking
 * `./dm-api`. That keeps the real client in the test — base64 on the wire, the 409-to-undefined
 * mapping, error shapes — so this covers the transport as well as the protocol.
 */
const toB64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const fromB64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
/** What both sides call a package's id — the service hashes the same bytes the client does. */
const hexDigest = (bytes: Uint8Array): string => {
  let hex = ''
  for (const byte of sha256(bytes)) hex += byte.toString(16).padStart(2, '0')
  return hex
}
vi.stubGlobal('fetch', async (url: string, init?: RequestInit): Promise<Response> => {
  const {server} = h
  const path = new URL(url).pathname
  const method = init?.method ?? 'GET'
  // The token is the caller's Pnyx id, which is also how the stub keys pools and queues.
  const token = (init?.headers as Record<string, string> | undefined)?.authorization?.slice(7) ?? ''
  const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>)
  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})

  if (path === '/dm/key-packages' && method === 'POST') {
    const list = server.packages.get(token) ?? []
    for (const encoded of body.packages as string[]) list.push(fromB64(encoded))
    server.packages.set(token, list)
    return json({added: (body.packages as string[]).length, available: list.length}, 201)
  }
  if (path === '/dm/key-packages' && method === 'GET') {
    return json({available: (server.packages.get(token) ?? []).length})
  }
  // Retiring is by content-hash id, exactly as the real route matches a client's local index.
  if (path === '/dm/key-packages/retire' && method === 'POST') {
    const ids = new Set(body.ids as string[])
    const list = server.packages.get(token) ?? []
    const kept = list.filter((bytes) => !ids.has(hexDigest(bytes)))
    server.packages.set(token, kept)
    return json({retired: list.length - kept.length, available: kept.length})
  }
  const claim = /^\/dm\/key-packages\/(.+)\/claim$/.exec(path)
  if (claim && method === 'POST') {
    const peer = decodeURIComponent(claim[1] as string)
    const next = (server.packages.get(peer) ?? []).shift()
    if (next === undefined) return json({error: 'no key packages available for that identity'}, 409)
    return json({keyPackage: toB64(next)})
  }
  const welcome = /^\/dm\/([0-9a-f]{64})\/welcome$/.exec(path)
  if (welcome && method === 'POST') {
    const recipient = body.recipient as string
    const list = server.welcomes.get(recipient) ?? []
    list.push({
      convId: welcome[1] as string,
      sender: token,
      welcome: fromB64(body.welcome as string),
      ratchetTree: fromB64(body.ratchetTree as string),
    })
    server.welcomes.set(recipient, list)
    return json({delivered: true}, 201)
  }
  // ⚠️ Non-destructive, matching the route: a Welcome is redelivered until it is acked.
  if (path === '/dm/welcomes' && method === 'GET') {
    const list = server.welcomes.get(token) ?? []
    return json({
      welcomes: list.map((w, i) => ({
        id: `w-${i}`,
        convId: w.convId,
        sender: w.sender,
        welcome: toB64(w.welcome),
        ratchetTree: toB64(w.ratchetTree),
        createdAt: new Date(1785000000000 + i).toISOString(),
      })),
    })
  }
  if (path === '/dm/welcomes/ack' && method === 'POST') {
    const ids = new Set(body.ids as string[])
    const list = server.welcomes.get(token) ?? []
    const kept = list.filter((_w, i) => !ids.has(`w-${i}`))
    server.welcomes.set(token, kept)
    return json({acked: list.length - kept.length})
  }
  return json({error: `unexpected ${method} ${path}`}, 404)
})

const {acceptPendingInvites} = await import('./dm-invites')
const {ensureKeyPackagePool} = await import('./dm-enrol')
const {startDmConversation} = await import('./dm-start')
const {deriveMlsIdentity, dmCiphersuite, decodeDmState, encodeDmState, openDmMessage, sealDmMessage} = await import(
  './dm-mls'
)
const {deriveDmStoreKey, listPrivateHalfIds, loadGroupState, saveGroupState} = await import('./dm-session')

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)

const ALICE_SK = new Uint8Array(32).fill(0x71)
const BOB_SK = new Uint8Array(32).fill(0x72)
const ALICE_ROOT = new Uint8Array(32).fill(11)
const BOB_ROOT = new Uint8Array(32).fill(12)
// Peers are addressed by their Pnyx identity, not an mn_addr (docs/PNYX_IDENTITY_PLAN.md).
const pnyxId = (sk: Uint8Array): string => encodePnyxId(identityCommitmentOf(sk))

// The stub keys the pool and welcome queues by "token"; using each side's id as its token keeps
// claim-by-peer-id and deliver-to-recipient consistent without a second mapping.
// The identity registry, in-process: a row's anchor is that identity's MLS signature key, which
// is exactly what the circuit stores on chain.
vi.mock('./identity-row', () => ({
  resolveIdentityRow: async (pnyxId: string) => {
    const root = ROOTS.get(pnyxId)
    if (!root) return {kind: 'unpublished'}
    const identity = await Effect.runPromise(Effect.orDie(deriveMlsIdentity(root)))
    return {
      kind: 'row',
      row: {anchor: identity.publicKey, authPub: new Uint8Array(32), name: new Uint8Array(32)},
    }
  },
}))

const ALICE = {token: pnyxId(ALICE_SK), selfIdentity: pnyxId(ALICE_SK), forumRoot: ALICE_ROOT, network: 'mainnet'}
const BOB = {token: pnyxId(BOB_SK), selfIdentity: pnyxId(BOB_SK), forumRoot: BOB_ROOT, network: 'mainnet'}
const ROOTS = new Map<string, Uint8Array>([
  [ALICE.selfIdentity, ALICE_ROOT],
  [BOB.selfIdentity, BOB_ROOT],
])

const asDevice = async <T>(device: 'alice' | 'bob', body: () => Promise<T>): Promise<T> => {
  const previous = h.state.activeDevice
  h.state.activeDevice = device
  try {
    return await body()
  } finally {
    h.state.activeDevice = previous
  }
}

beforeEach(async () => {
  h.stores.alice.clear()
  h.stores.bob.clear()
  h.server.packages.clear()
  h.server.welcomes.clear()
})

describe('two-party conversation, end to end', () => {
  it('Bob joins from a Welcome and both sides exchange messages', async () => {
    // Bob comes online and publishes his pool.
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    expect((h.server.packages.get(BOB.token) ?? []).length).toBeGreaterThan(0)

    // Alice starts the conversation.
    const started = await asDevice('alice', () =>
      startDmConversation({
        token: ALICE.token,
        selfIdentity: ALICE.selfIdentity,
        peerIdentity: BOB.selfIdentity,
        forumRoot: ALICE_ROOT,
        network: 'mainnet',
      }),
    )
    // Assert on the whole result, not just `ok`, so a failure names its kind instead of "expected
    // true to be false".
    expect(started.ok ? 'ok' : started.failure).toBe('ok')
    if (!started.ok) return
    const convId = started.convId

    // Bob accepts. This is the step that did not exist: without it he never joins.
    const joined = await asDevice('bob', () => acceptPendingInvites(BOB))
    expect(joined).toEqual([convId])

    // Alice → Bob.
    const cs = await run(dmCiphersuite())
    const aliceKey = await run(deriveDmStoreKey(ALICE_ROOT))
    const bobKey = await run(deriveDmStoreKey(BOB_ROOT))

    const sealed = await asDevice('alice', async () => {
      const stored = await run(loadGroupState(aliceKey, convId))
      const state = await run(decodeDmState(stored as Uint8Array))
      const out = await run(sealDmMessage(state, new TextEncoder().encode('hello bob'), cs))
      await run(saveGroupState(aliceKey, convId, encodeDmState(out.state)))
      return out.message
    })

    const received = await asDevice('bob', async () => {
      const stored = await run(loadGroupState(bobKey, convId))
      const state = await run(decodeDmState(stored as Uint8Array))
      const opened = await run(openDmMessage(state, sealed, cs))
      await run(saveGroupState(bobKey, convId, encodeDmState(opened.state)))
      return new TextDecoder().decode(opened.plaintext)
    })
    expect(received).toBe('hello bob')

    // Bob → Alice, proving the group works in both directions after a Welcome join.
    const back = await asDevice('bob', async () => {
      const stored = await run(loadGroupState(bobKey, convId))
      const state = await run(decodeDmState(stored as Uint8Array))
      const out = await run(sealDmMessage(state, new TextEncoder().encode('hi alice'), cs))
      await run(saveGroupState(bobKey, convId, encodeDmState(out.state)))
      return out.message
    })

    const replyText = await asDevice('alice', async () => {
      const stored = await run(loadGroupState(aliceKey, convId))
      const state = await run(decodeDmState(stored as Uint8Array))
      const opened = await run(openDmMessage(state, back, cs))
      return new TextDecoder().decode(opened.plaintext)
    })
    expect(replyText).toBe('hi alice')
  })

  it('consumes exactly one KeyPackage and releases its private half after joining', async () => {
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    const before = await asDevice('bob', () => run(listPrivateHalfIds()))
    const poolBefore = (h.server.packages.get(BOB.token) ?? []).length

    await asDevice('alice', () =>
      startDmConversation({
        token: ALICE.token,
        selfIdentity: ALICE.selfIdentity,
        peerIdentity: BOB.selfIdentity,
        forumRoot: ALICE_ROOT,
        network: 'mainnet',
      }),
    )
    await asDevice('bob', () => acceptPendingInvites(BOB))

    expect((h.server.packages.get(BOB.token) ?? []).length).toBe(poolBefore - 1)
    const after = await asDevice('bob', () => run(listPrivateHalfIds()))
    // Exactly one released — a single-use init key must not stay usable.
    expect(after.length).toBe(before.length - 1)
  })

  it('drops a Welcome it has no matching package for instead of retrying forever', async () => {
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    await asDevice('alice', () =>
      startDmConversation({
        token: ALICE.token,
        selfIdentity: ALICE.selfIdentity,
        peerIdentity: BOB.selfIdentity,
        forumRoot: ALICE_ROOT,
        network: 'mainnet',
      }),
    )
    // Bob reinstalls: the private halves are gone, so nothing can open the Welcome.
    h.stores.bob.clear()
    const joined = await asDevice('bob', () => acceptPendingInvites(BOB))
    expect(joined).toEqual([])
    // And it is consumed, not left to be retried against a package that will never come back.
    expect(h.server.welcomes.get(BOB.token)).toEqual([])
  })

  it('forgets a key package record it can never open, instead of failing on it every pass', async () => {
    // The field case: `STORE_KEY_INFO` dropped its network suffix on 2026-08-29, so records written
    // before that are sealed under a key the app will never derive again. They were retried — and
    // logged — on every drain, for ever.
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    const before = await asDevice('bob', () => run(listPrivateHalfIds()))
    // ⚠️ Not `before[0]`: that is the package Alice's claim takes, so every assertion about it
    // leaving the pool would pass whether or not anything retired it.
    const orphaned = before[3]
    expect(orphaned).toBeDefined()
    // Same shape, wrong key: valid base64, long enough to hold a nonce, and undecryptable.
    h.stores.bob.set(`@pnyx/dm/kp/${orphaned}`, btoa('x'.repeat(64)))

    await asDevice('alice', () =>
      startDmConversation({
        token: ALICE.token,
        selfIdentity: ALICE.selfIdentity,
        peerIdentity: BOB.selfIdentity,
        forumRoot: ALICE_ROOT,
        network: 'mainnet',
      }),
    )
    await asDevice('bob', () => acceptPendingInvites(BOB))

    const after = await asDevice('bob', () => run(listPrivateHalfIds()))
    expect(after).not.toContain(orphaned)
    // The record itself is gone too, not just its index entry.
    expect(h.stores.bob.get(`@pnyx/dm/kp/${orphaned}`)).toBeUndefined()
    // ...and so is the half a peer could still have claimed. Left published, it is an invite that
    // dies on *their* side with nothing to retry.
    expect((h.server.packages.get(BOB.token) ?? []).map(hexDigest)).not.toContain(orphaned)
  })

  it('withdraws only what it actually let go of', async () => {
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    const held = await asDevice('bob', () => run(listPrivateHalfIds()))
    const published = (h.server.packages.get(BOB.token) ?? []).map(hexDigest)
    expect(published).toEqual(expect.arrayContaining([...held]))

    // A drain with nothing to prune must not withdraw a package we can still open.
    await asDevice('bob', () => acceptPendingInvites(BOB))
    expect((h.server.packages.get(BOB.token) ?? []).map(hexDigest)).toEqual(published)
  })

  it('keeps a record whose read merely failed, since that can succeed next time', async () => {
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    const before = await asDevice('bob', () => run(listPrivateHalfIds()))
    const id = before[0]
    expect(id).toBeDefined()
    // An index entry with no record at all: `loadPrivateHalf` returns undefined rather than failing,
    // so nothing is pruned and nothing is claimed about it.
    h.stores.bob.delete(`@pnyx/dm/kp/${id}`)

    await asDevice('bob', () => acceptPendingInvites(BOB))

    expect(await asDevice('bob', () => run(listPrivateHalfIds()))).toContain(id)
  })

  // The whole point of the take no longer being destructive: a pass that dies part-way costs a
  // retry, not the invitation.
  it('leaves a Welcome on the server until it is acked', async () => {
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    await asDevice('alice', () =>
      startDmConversation({
        token: ALICE.token,
        selfIdentity: ALICE.selfIdentity,
        peerIdentity: BOB.selfIdentity,
        forumRoot: ALICE_ROOT,
        network: 'mainnet',
      }),
    )
    expect(h.server.welcomes.get(BOB.token)).toHaveLength(1)
    // Bob never runs, so nothing is acked — and the invite is still there for the next attempt.
    expect(h.server.welcomes.get(BOB.token)).toHaveLength(1)

    const joined = await asDevice('bob', () => acceptPendingInvites(BOB))
    expect(joined).toHaveLength(1)
    expect(h.server.welcomes.get(BOB.token)).toEqual([])
  })

  /**
   * ⚠️ The hazard redelivery introduces. A Welcome seen twice must not be joined twice: that would
   * build a fresh group at the same conversation id and orphan every message received since —
   * turning the retry that protects an invite into a way to lose a live conversation.
   */
  it('acks a redelivered Welcome instead of re-joining it', async () => {
    await asDevice('bob', () => ensureKeyPackagePool(BOB))
    await asDevice('alice', () =>
      startDmConversation({
        token: ALICE.token,
        selfIdentity: ALICE.selfIdentity,
        peerIdentity: BOB.selfIdentity,
        forumRoot: ALICE_ROOT,
        network: 'mainnet',
      }),
    )
    const delivered = [...(h.server.welcomes.get(BOB.token) ?? [])]
    const convId = delivered[0]?.convId as string

    // ⚠️ Snapshot the private half *before* the join consumes it. Without this the redelivered
    // Welcome fails to match any package and is dropped for an unrelated reason — which is how a
    // first version of this test passed with the guard deleted.
    const kpIndex = h.stores.bob.get('@pnyx/dm/kp-index')
    const kpRecords = [...h.stores.bob.entries()].filter(([key]) => key.startsWith('@pnyx/dm/kp/'))

    await asDevice('bob', () => acceptPendingInvites(BOB))
    const bobKey = await asDevice('bob', () => run(deriveDmStoreKey(BOB_ROOT)))
    const afterFirst = await asDevice('bob', () => run(loadGroupState(bobKey, convId)))
    expect(afterFirst).toBeDefined()

    // The crash window the guard exists for: group state is saved *before* the private half is
    // released, so dying between the two leaves a device that has joined and can still match the
    // Welcome it already used.
    if (kpIndex !== undefined) h.stores.bob.set('@pnyx/dm/kp-index', kpIndex)
    for (const [key, value] of kpRecords) h.stores.bob.set(key, value)
    // The ack was lost, so the server hands it back.
    h.server.welcomes.set(BOB.token, delivered)
    const again = await asDevice('bob', () => acceptPendingInvites(BOB))

    // Not re-joined — and the ratchet is byte-identical, not merely present.
    expect(again).toEqual([])
    expect(await asDevice('bob', () => run(loadGroupState(bobKey, convId)))).toEqual(afterFirst)
    // ...and it stops being redelivered.
    expect(h.server.welcomes.get(BOB.token)).toEqual([])
  })

  it('returns nothing and stays quiet when there are no invites', async () => {
    expect(await asDevice('bob', () => acceptPendingInvites(BOB))).toEqual([])
  })
})
