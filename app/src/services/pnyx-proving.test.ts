/**
 * Device-rail circle creation: the address it reports, and the ordering of the pair.
 *
 * `submitDeviceCircle` is two dependent transactions — the circle's **deploy** (a circle is a
 * contract, so there is no circuit and no proof), then the creator's own join once it has confirmed.
 * Both halves must be on this rail: a server-proved join would insert a `PERSONA_SECRET`-derived
 * member leaf, and the creator's own later proposals and votes would fail to find their `memberPath`.
 * That makes the ordering load-bearing rather than incidental, so it is pinned here.
 *
 * What changed with the contract split: the id is no longer learned from the service (there is no
 * `circleCount` to claim) but **derived from the content-plane id**, and the address is derived from
 * that — so the properties worth pinning are that the reported address is the derived one and that the
 * join proves against the same contract.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

const {
  buildCircleDeployTx,
  circleDeployAddress,
  buildJoinProvenTx,
  ensureCircuitArtifacts,
  ensureCircleVerifierKeys,
  getRandomBytes,
  requireContractStateAt,
} = vi.hoisted(() => ({
  // Typed parameters so `.mock.calls[n][0]` is a tuple element rather than an index into `[]`.
  buildCircleDeployTx: vi.fn(async (_inputs: {circleId: Uint8Array; isOpen: boolean}) => new Uint8Array([1, 2, 3])),
  circleDeployAddress: vi.fn(async (_inputs: {circleId: Uint8Array}) => new Uint8Array(32).fill(0xbe)),
  buildJoinProvenTx: vi.fn(
    async (_paths: unknown, _inputs: {circleId: Uint8Array; contractAddress: Uint8Array}) => new Uint8Array([4, 5, 6]),
  ),
  ensureCircuitArtifacts: vi.fn(async () => ({
    zkirPath: '/zkir',
    proverKeyPath: '/prover',
    verifierKeyPath: '/verifier',
    paramsPath: '/params',
  })),
  getRandomBytes: vi.fn(() => new Uint8Array(32).fill(7)),
  requireContractStateAt: vi.fn(async (_address: string) => new Uint8Array([0xca, 0xfe])),
  ensureCircleVerifierKeys: vi.fn(async () => '/keys'),
}))

vi.mock('@pnyx/midnight-native', () => ({
  buildCircleDeployTx,
  circleDeployAddress,
  buildJoinProvenTx,
  buildCastVoteProvenTx: vi.fn(),
  buildCreateProposalProvenTx: vi.fn(),
  buildRevealVoteProvenTx: vi.fn(),
}))
vi.mock('./pnyx-artifacts', () => ({ensureCircuitArtifacts, ensureCircleVerifierKeys}))
// State comes from an indexer now, not `GET /chain/state` — the read itself is covered by
// identity-row.test.ts; what matters here is that the join reads the CIRCLE's own contract.
vi.mock('./pnyx-contract-state', () => ({requireContractStateAt}))
vi.mock('./pnyx-session', () => ({serviceUrl: () => 'http://svc'}))
vi.mock('expo-crypto', () => ({getRandomBytes}))
vi.mock('@pnyx/contract-client/persona', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pnyx/contract-client/persona')>()),
  personaSkFromForumRoot: () => new Uint8Array(32).fill(3),
}))
vi.mock('@pnyx/contract-client/identity', () => ({
  identitySkFromForumRoot: () => new Uint8Array(32).fill(9),
}))

import {identityJoinNullifier} from '@pnyx/contract-client/circle-derivations'
import {identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {moderatorAuthKeyPair} from '@pnyx/contract-client/persona'
import {submitDeviceCircle} from './pnyx-proving'

/** Responses keyed by path fragment; `circle` is the evolving /circles/:id chain ref. */
let circleChain: {status?: string; chainId?: string; error?: string} | undefined
let submitted: {tx: string; ref: Record<string, unknown>}[]

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const asJson = (body: unknown, status = 200) =>
    ({ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body)}) as unknown as Response
  if (url.endsWith('/auth/config')) {
    // No `chain.identityContractAddress`, on purpose: nothing on this rail targets the identity
    // contract, and requiring it here once made creating a circle fail on a deployment that simply
    // had no identity deploy yet.
    return asJson({chain: {enabled: true}, network: 'undeployed'})
  }
  if (url.endsWith('/chain/submit')) {
    submitted.push(JSON.parse(String(init?.body)))
    return {ok: true, status: 202, json: async () => ({accepted: true}), text: async () => ''} as unknown as Response
  }
  if (url.includes('/circles/')) return asJson({circle: {chain: circleChain}})
  throw new Error(`unexpected fetch: ${url}`)
})

const params = {
  token: 'jwt',
  forumRoot: new Uint8Array(32).fill(1),
  contentCircleId: 'content-circle-1',
  isOpen: true,
}

/** The address the mocked derivation returns, as the ref records it. */
const DERIVED_ADDRESS = 'be'.repeat(32)

beforeEach(() => {
  vi.clearAllMocks()
  submitted = []
  circleChain = {status: 'confirmed'}
  buildCircleDeployTx.mockResolvedValue(new Uint8Array([1, 2, 3]))
  circleDeployAddress.mockResolvedValue(new Uint8Array(32).fill(0xbe))
  buildJoinProvenTx.mockResolvedValue(new Uint8Array([4, 5, 6]))
  vi.stubGlobal('fetch', fetchMock)
})

describe('submitDeviceCircle', () => {
  // The address is derived from the constructor's arguments, so the client knows it before the deploy
  // is even submitted. Reporting anything else would label the circle with a contract it did not
  // create — the exact substitution the derived nonce exists to make impossible.
  it('reports the address its own derivation produced', async () => {
    await submitDeviceCircle(params)

    expect(submitted[0]?.ref).toEqual({
      kind: 'circle',
      circleId: 'content-circle-1',
      chainId: DERIVED_ADDRESS,
      // The founder leaf rides along so the circle's on-chain moderation authority is recorded from
      // the deploy rather than inferred from a content-plane label. It is the same value the deploy
      // was built with, which is what makes the address a commitment to it.
      founderLeaf: (submitted[0]?.ref as {founderLeaf: string}).founderLeaf,
    })
    // Asserted against the builder's own input rather than a literal: a founder leaf that did not
    // match what was deployed would name a moderator the contract never seated.
    const built = (buildCircleDeployTx.mock.calls[0]?.[0] as unknown as {founder: Uint8Array}).founder
    const hex = Array.from(built, (b) => b.toString(16).padStart(2, '0')).join('')
    expect((submitted[0]?.ref as {founderLeaf: string}).founderLeaf).toBe(hex)
  })

  // The founder is the circle's only initial moderator and is not a member, so they cannot promote
  // themselves — the constructor has to seat their auth key or the one moderator a new circle has is
  // one the content plane can never authenticate. Asserted against the real derivation rather than a
  // literal, because the key stored on-chain must be the one this persona actually holds.
  it('seats the founder auth key the same persona derives', async () => {
    await submitDeviceCircle(params)

    const deployArgs = buildCircleDeployTx.mock.calls[0]?.[0] as unknown as {founderAuth: Uint8Array}
    expect(deployArgs.founderAuth).toEqual(moderatorAuthKeyPair(new Uint8Array(32).fill(3)).publicKey)
    expect(deployArgs.founderAuth).toHaveLength(32)
    // It also feeds the address, so the address derivation must be handed the same bytes.
    expect((circleDeployAddress.mock.calls[0]?.[0] as unknown as {founderAuth: Uint8Array}).founderAuth).toEqual(
      deployArgs.founderAuth,
    )
  })

  // The id must be a function of the content id alone, or two devices would derive different circles
  // for the same community — and the second could never find the first's contract.
  it('derives the on-chain id from the content id, not from the service', async () => {
    await submitDeviceCircle(params)
    const first = buildCircleDeployTx.mock.calls[0]?.[0]?.circleId

    submitted = []
    vi.clearAllMocks()
    circleDeployAddress.mockResolvedValue(new Uint8Array(32).fill(0xbe))
    await submitDeviceCircle(params)

    expect(buildCircleDeployTx.mock.calls[0]?.[0]?.circleId).toEqual(first)
    expect(first).toHaveLength(32)
  })

  // One transaction, not two: the constructor seats the founder in `members` and spends their identity
  // nullifier, so the deploy *is* their join. A second one would be refused as "identity already
  // joined" — and on a gated circle the old sequence needed a self-invite in between.
  it('creates a circle in a single settlement, with no join of its own', async () => {
    await submitDeviceCircle(params)

    expect(submitted.map((s) => s.ref.kind)).toEqual(['circle'])
    expect(buildJoinProvenTx).not.toHaveBeenCalled()
  })

  // Seated beside the member leaf. Passing the wrong bytes would derive a different address, so this
  // pins the derivation the contract's `identityJoinNullifier` has to agree with.
  it("seats the founder's own join nullifier, derived from their identity and this circle", async () => {
    await submitDeviceCircle(params)

    const circleId = buildCircleDeployTx.mock.calls[0]?.[0]?.circleId as Uint8Array
    const expected = identityJoinNullifier(circleId, identitySkFromForumRoot(params.forumRoot))
    expect(buildCircleDeployTx.mock.calls[0]?.[0]).toMatchObject({founderJoined: expected})
    expect(circleDeployAddress.mock.calls[0]?.[0]).toMatchObject({founderJoined: expected})
  })

  it('reports a deploy that failed on-chain rather than reporting a circle', async () => {
    circleChain = {status: 'failed', error: 'out of dust'}

    await expect(submitDeviceCircle(params)).rejects.toThrow(/circle deploy failed on-chain/)

    expect(submitted.map((s) => s.ref.kind)).toEqual(['circle'])
  })

  // `isOpen` is part of the address, so passing it through wrongly would deploy — and derive — a
  // different contract than the caller asked for.
  it('carries isOpen into both the deploy and the address derivation', async () => {
    await submitDeviceCircle({...params, isOpen: false})

    expect(buildCircleDeployTx.mock.calls[0]?.[0]).toMatchObject({isOpen: false})
    expect(circleDeployAddress.mock.calls[0]?.[0]).toMatchObject({isOpen: false})
  })
})

/*
 * What a sponsored transfer learns from `/chain/submit`.
 *
 * A transfer has no ChainRef row, so this response is its only channel: before the sponsor started
 * waiting, a transfer refused by the node reached the device as a bare 202 and sat as "Pending" for
 * an hour (preprod, 2026-09-30). The tx id must be read when present, and its absence must stay
 * legal — an older sponsor host answers 202 with no body at all.
 */
describe('submitSponsoredTransfer', () => {
  const ok = (body: string) => ({status: 202, text: () => Promise.resolve(body)}) as unknown as Response

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the tx id the sponsor reports', async () => {
    const {submitSponsoredTransfer} = await import('./pnyx-proving')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(JSON.stringify({accepted: true, txId: 'tx-landed'}))))
    await expect(submitSponsoredTransfer('t', new Uint8Array([1]), 'preprod')).resolves.toEqual({txId: 'tx-landed'})
  })

  it('accepts a 202 with no body, which is what an older sponsor answers', async () => {
    const {submitSponsoredTransfer} = await import('./pnyx-proving')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('')))
    await expect(submitSponsoredTransfer('t', new Uint8Array([1]), 'preprod')).resolves.toEqual({})
  })

  it('treats an empty tx id as absent rather than as a handle', async () => {
    const {submitSponsoredTransfer} = await import('./pnyx-proving')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(JSON.stringify({accepted: true, txId: ''}))))
    await expect(submitSponsoredTransfer('t', new Uint8Array([1]), 'preprod')).resolves.toEqual({})
  })

  // 502 is what the origin answers when the sponsor refused; it must reach the caller as a throw so
  // the send reports a failure instead of writing a pending row.
  it('throws when the origin passes a sponsor refusal through', async () => {
    const {submitSponsoredTransfer} = await import('./pnyx-proving')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 502,
        text: () => Promise.resolve(JSON.stringify({error: 'Custom error: 104'})),
      } as unknown as Response),
    )
    await expect(submitSponsoredTransfer('t', new Uint8Array([1]), 'preprod')).rejects.toThrow('Custom error: 104')
  })
})
