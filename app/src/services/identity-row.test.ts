import {CardKind} from '@pnyx/contract-client/card'
import {encodePnyxId} from '@pnyx/contract-client/identity'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resetIdentityRowCache, resolveIdentityRow} from './identity-row'

// The indexer URL is read once at module scope in production (Expo only inlines literal
// `process.env` member expressions), so it has to be set before that module is imported — which
// `vi.hoisted` is, and `beforeEach`/`stubEnv` is not.
//
// The identity chain's *override* variable, so the test keeps a hermetic endpoint. It is the only
// endpoint env var left: the identity indexer normally follows `EXPO_PUBLIC_PNYX_NETWORK`, and every
// funds endpoint is derived from the network selector — see `midnight/networks.ts`.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_PNYX_INDEXER_URL = 'https://indexer.test/graphql'
})

// The native decoder cannot run under vitest (it is a Rust library reached through expo-modules),
// so the boundary is mocked here and the decode itself is tested in Rust against real preprod chain
// bytes (`packages/midnight-native/rust/src/identity.rs`). What this file covers is the
// orchestration: where the state comes from, the cache, and which lookup kind each failure yields.
const decodeMock = vi.fn()
vi.mock('@pnyx/midnight-native', () => ({identityRowFromState: (...a: unknown[]) => decodeMock(...a)}))
vi.mock('../logger', () => ({logger: {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}}}))

const ADDRESS = 'a'.repeat(64)
/**
 * The address is derived from `C` by the native module, which cannot run here — so the derivation is
 * the mocked boundary. What this file covers is unchanged: where the state comes from, the cache, and
 * which lookup kind each failure yields.
 */
const addressMock = vi.fn(async (): Promise<Uint8Array> => new Uint8Array(32).fill(0xaa))
vi.mock('./identity-contract', () => ({identityContractAddressFor: () => addressMock()}))
vi.mock('./pnyx-session', () => ({serviceUrl: () => 'http://svc'}))

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill)
const pnyxId = encodePnyxId(bytes32(0x2a))
/**
 * ⚠️ `card` is not optional on the native read, so a fixture without it was describing a shape that
 * cannot occur — and it stopped compiling into a passing test the moment the resolver started decoding
 * the card. An empty array is "nothing written", which is the ordinary case.
 */
const row = {anchor: bytes32(0x70), authPub: bytes32(0x71), name: new Uint8Array(32), card: []}

/** One row of a card, as the native read hands it over: the full 320-byte value field. */
const cardRow = (kind: number, text: string, slot = 0) => {
  const value = new Uint8Array(320)
  const bytes = new TextEncoder().encode(text)
  value[0] = bytes.length >> 8
  value[1] = bytes.length & 0xff
  value.set(bytes, 2)
  return {slot, kind, value}
}

/** The indexer is the only place state comes from; every call is recorded so we can assert that. */
let calls: string[] = []
const stubIndexer = (options: {height?: number; state?: string; fail?: boolean} = {}) => {
  const {height = 7, state = 'deadbeef', fail = false} = options
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (fail) throw new Error('offline')
      const query = String((JSON.parse(String(init?.body ?? '{}')) as {query?: string}).query ?? '')
      const action = query.includes('state')
        ? {state, transaction: {block: {height}}}
        : {address: ADDRESS, transaction: {hash: 'h', block: {height}}}
      return new Response(JSON.stringify({data: {contractAction: action}}), {status: 200})
    }) as unknown as typeof fetch,
  )
}

beforeEach(() => {
  calls = []
  resetIdentityRowCache()
  decodeMock.mockReset()
  addressMock.mockReset()
  addressMock.mockImplementation(async () => new Uint8Array(32).fill(0xaa))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveIdentityRow', () => {
  it('decodes the contact card the native read returns', async () => {
    stubIndexer()
    // Kind 9 is `Email` in the codec's frozen numbering.
    decodeMock.mockResolvedValue({...row, card: [cardRow(CardKind.Email, 'a@b.test')]})

    const result = await resolveIdentityRow(pnyxId)

    expect(result.kind).toBe('row')
    if (result.kind === 'row') {
      expect(result.row.card.entries).toEqual([{kind: CardKind.Email, value: 'a@b.test'}])
      expect(result.row.card.defects).toEqual([])
    }
  })

  // ⚠️ A row this client cannot draw is reported, never dropped silently: "the card failed to parse"
  // and "the card is empty" are different facts and only one of them is normal.
  it('surfaces a row that did not decode as a defect rather than dropping it', async () => {
    stubIndexer()
    // Kind 63 is inside the mask and unassigned, so the codec cannot know what it is.
    decodeMock.mockResolvedValue({...row, card: [cardRow(62, 'something')]})

    const result = await resolveIdentityRow(pnyxId)

    expect(result.kind).toBe('row')
    if (result.kind === 'row') {
      expect(result.row.card.entries).toEqual([])
      expect(result.row.card.defects.map((d) => d.reason)).toEqual(['unknown-kind'])
    }
  })

  it('reads the row from the indexer and decodes it natively', async () => {
    stubIndexer()
    decodeMock.mockResolvedValue(row)

    const result = await resolveIdentityRow(pnyxId)

    expect(result.kind).toBe('row')
    if (result.kind === 'row') expect(result.row.anchor).toEqual(bytes32(0x70))
    // The decoder gets the fetched state and the *decoded* 32-byte C, not the bech32m string.
    expect(decodeMock).toHaveBeenCalledWith(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), bytes32(0x2a))
  })

  // The whole point of the change: our own service must no longer learn who is looked up. It may
  // still be asked for the contract address (deployment config) — that is mocked out here, so any
  // request reaching this fetch must be the indexer.
  it('never asks the content service which identity is being resolved', async () => {
    stubIndexer()
    decodeMock.mockResolvedValue(row)

    await resolveIdentityRow(pnyxId)

    expect(calls.length).toBeGreaterThan(0)
    for (const url of calls) expect(url).toBe('https://indexer.test/graphql')
    expect(calls.some((url) => url.includes('/identities/'))).toBe(false)
  })

  // The distinction the UI depends on: "they have not enabled messaging" is actionable and final,
  // "we could not check" is neither, and collapsing them blames the wrong person.
  it('separates unpublished from unavailable', async () => {
    stubIndexer()
    decodeMock.mockResolvedValue(undefined)
    expect((await resolveIdentityRow(pnyxId)).kind).toBe('unpublished')

    resetIdentityRowCache()
    stubIndexer({fail: true})
    expect((await resolveIdentityRow(pnyxId)).kind).toBe('unavailable')

    resetIdentityRowCache()
    stubIndexer()
    decodeMock.mockRejectedValue(new Error('corrupt state'))
    expect((await resolveIdentityRow(pnyxId)).kind).toBe('unavailable')
  })

  it('is unavailable when the address cannot be derived, rather than guessing one', async () => {
    stubIndexer()
    // The keys the derivation hashes are a download; without them there is no address, and reading
    // *some* contract would answer about the wrong identity.
    addressMock.mockRejectedValue(new Error('verifier keys unavailable'))
    expect((await resolveIdentityRow(pnyxId)).kind).toBe('unavailable')
    expect(calls).toEqual([])
  })

  // Resolving a chat list must not download the whole ledger once per peer.
  it('reuses cached state while the contract has not moved', async () => {
    stubIndexer({height: 7})
    decodeMock.mockResolvedValue(row)

    await resolveIdentityRow(pnyxId)
    const afterFirst = calls.length
    await resolveIdentityRow(pnyxId)

    // The second lookup pays only the cheap marker query, not the state blob.
    expect(calls.length).toBe(afterFirst + 1)
    expect(decodeMock).toHaveBeenCalledTimes(2)
  })

  it('refetches when the contract has moved', async () => {
    stubIndexer({height: 7, state: 'deadbeef'})
    decodeMock.mockResolvedValue(row)
    await resolveIdentityRow(pnyxId)

    stubIndexer({height: 8, state: 'feedface'})
    await resolveIdentityRow(pnyxId)

    expect(decodeMock).toHaveBeenLastCalledWith(new Uint8Array([0xfe, 0xed, 0xfa, 0xce]), bytes32(0x2a))
  })

  // A malformed id is the *caller's* error and must not become a lookup that reports the other
  // party as unpublished.
  it('throws on a malformed identity rather than reporting it unpublished', async () => {
    stubIndexer()
    await expect(resolveIdentityRow('pnyx_id1notvalid')).rejects.toThrow()
  })
})
