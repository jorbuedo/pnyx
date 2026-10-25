import {describe, expect, it} from 'vitest'
import {ADA_HANDLE_POLICY} from '../cardano/config'
import {ftPlaceholderIconUri, knownTokenIconUri, nftPlaceholderIconUri} from './known-token-icons'

const HANDLE_POLICY = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a'
// CIP-68 label 222 + "liveleg5bi80" — the shape a real handle arrives in.
const A_HANDLE = `${HANDLE_POLICY}.000de1406c6976656c65673562693830`

describe('knownTokenIconUri', () => {
  it('serves the mark for a handle', () => {
    expect(knownTokenIconUri(A_HANDLE)).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  // Every asset under the policy is a handle; there is no per-asset artwork to distinguish.
  it('serves it for any asset under the policy, whatever the name', () => {
    expect(knownTokenIconUri(`${HANDLE_POLICY}.deadbeef`)).toBe(knownTokenIconUri(A_HANDLE))
  })

  it('is case-insensitive on the policy', () => {
    expect(knownTokenIconUri(`${HANDLE_POLICY.toUpperCase()}.000de140`)).not.toBeNull()
  })

  it('falls through for an unrelated token, so the CDN path still runs', () => {
    expect(knownTokenIconUri('27acf1ed0a8d9ade69ca32989aee25b2f40e77188b12e082447b491e.4845')).toBeNull()
  })

  // ADA is `''` / `'.'`; an empty policy must not match a set membership test.
  it('is null for ADA and for junk', () => {
    expect(knownTokenIconUri('')).toBeNull()
    expect(knownTokenIconUri('.')).toBeNull()
  })

  // The second policy, confirmed on chain by its `handle_type` datum rather than by resemblance.
  it('serves the mark for the second known handle policy', () => {
    expect(knownTokenIconUri('6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e.000de140')).not.toBeNull()
  })

  // ⚠️ The one thing that would silently un-brand every handle: this reads the policy from
  // `ADA_HANDLE_POLICY`, so an edit there must keep serving the mark rather than only changing
  // handle *resolution*.
  it('is driven by the shipped policy config, not a second copy of the id', () => {
    expect(ADA_HANDLE_POLICY.mainnet).toBe(HANDLE_POLICY)
  })
})

describe('nftPlaceholderIconUri', () => {
  it('is a shipped data URI, so a list needs no request for it', () => {
    expect(nftPlaceholderIconUri()).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  // ⚠️ A handle IS an NFT. If the placeholder won, every handle would lose its mark — the caller
  // asks for the known icon first, and this pins that they are distinct answers.
  it('is not the handle mark', () => {
    expect(nftPlaceholderIconUri()).not.toBe(
      knownTokenIconUri('f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a.000de140'),
    )
  })
})

describe('ftPlaceholderIconUri', () => {
  it('is a shipped data URI', () => {
    expect(ftPlaceholderIconUri()).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  // ⚠️ The shape is the only thing distinguishing the two, so they must not collapse to one asset:
  // a fungible token and an NFT rendering identically is the distinction silently disappearing.
  it('is distinct from the NFT placeholder', () => {
    expect(ftPlaceholderIconUri()).not.toBe(nftPlaceholderIconUri())
  })

  it('is not the handle mark either', () => {
    expect(ftPlaceholderIconUri()).not.toBe(
      knownTokenIconUri('f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a.000de140'),
    )
  })
})
