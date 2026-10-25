// The rules that decide whether a deploy is *sent*. Each one exists because getting it wrong is
// silent: a skipped deploy leaves an identity permanently unpublishable, and a deploy whose address
// disagrees with the derivation publishes into a contract nobody can find.
import {beforeEach, describe, expect, it, vi} from 'vitest'

const DERIVED = new Uint8Array(32).fill(0xaa)
const derive = vi.fn(async () => DERIVED)
const build = vi.fn(async () => ({address: DERIVED, tx: new Uint8Array([1, 2, 3])}))
vi.mock('@pnyx/midnight-native', () => ({
  identityAddress: () => derive(),
  buildIdentityDeployTx: () => build(),
}))

const marker = vi.fn<() => Promise<{height: number; txHash: string} | null>>(async () => null)
vi.mock('./midnight/contract-state', () => ({fetchContractMarker: () => marker()}))
vi.mock('./pnyx-artifacts', () => ({ensureVerifierKeys: async () => '/keys'}))

const relay = vi.fn(async (_tx: Uint8Array) => undefined)
vi.mock('./sponsored-relay', () => ({relaySponsoredTx: (tx: Uint8Array) => relay(tx)}))
vi.mock('../logger', () => ({logger: {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}}}))

const {ensureIdentityShell, identityContractAddressFor} = await import('./identity-contract')

const C = new Uint8Array(32).fill(0x2a)
const shell = () => ensureIdentityShell({c: C, networkId: 'preprod', expiresAtSecs: 1})

beforeEach(() => {
  derive.mockClear()
  // `mockReset`, not `mockClear`: an implementation set by one case would otherwise decide the next.
  build.mockReset().mockResolvedValue({address: DERIVED, tx: new Uint8Array([1, 2, 3])})
  relay.mockReset().mockResolvedValue(undefined)
  marker.mockReset().mockResolvedValue(null)
})

describe('ensureIdentityShell', () => {
  it('deploys nothing when the contract is already there', async () => {
    marker.mockResolvedValue({height: 12, txHash: 'h'})
    await expect(shell()).resolves.toMatchObject({kind: 'deployed'})
    expect(relay).not.toHaveBeenCalled()
  })

  it('relays a deploy when nothing is at the derived address', async () => {
    await expect(shell()).resolves.toMatchObject({kind: 'submitted'})
    expect(relay).toHaveBeenCalledOnce()
  })

  it('refuses to relay a deploy that would create a different contract than we derived', async () => {
    // The builder and the derivation read the same keys, so a disagreement means the two have drifted
    // — and publishing a row into a contract at an address nobody else derives is worse than failing.
    build.mockResolvedValue({address: new Uint8Array(32).fill(0xbb), tx: new Uint8Array([9])})
    const result = await shell()
    expect(result.kind).toBe('unknown')
    expect(relay).not.toHaveBeenCalled()
  })

  it('reports the relay refusal instead of claiming the deploy is in flight', async () => {
    relay.mockRejectedValue(new Error('sponsorship refused: not our template'))
    const result = await shell()
    expect(result).toMatchObject({kind: 'unknown'})
    expect(result.kind === 'unknown' && result.reason).toContain('sponsorship refused')
  })

  it('derives once per identity and then answers from memory', async () => {
    // Its own `C`: the cache is module-level and the cases above have already primed the shared one.
    const fresh = new Uint8Array(32).fill(0x5c)
    await identityContractAddressFor(fresh)
    await identityContractAddressFor(fresh)
    // The keys are a download and the hash is pure, so a second call must cost nothing.
    expect(derive).toHaveBeenCalledOnce()
  })
})
