/**
 * The endpoint-injects-the-credential path: what lets the SteelSwap partner key stop being
 * published in a world-readable remote config at all.
 *
 * ⚠️ The case these cover is the one that was measured on device 2026-10-18 and is easy to get
 * wrong: with no partner key AND no injection, `getSteelswapKey` falls through to minting a
 * per-install CIP-8 key, and that mint posts the wallet's address to SteelSwap — which serves
 * mainnet only and answers `400 Invalid address` for a testnet one. The gate then fails before any
 * request is made, taking token metadata and prices down with it, not just swaps.
 */

import {getRemoteSwapKeyInjectedByEndpoint} from '@pnyx/config'
import {Effect} from 'effect'
import {beforeEach, describe, expect, it} from 'vitest'
import {getCardanoAssetsConfig, setRemoteSteelswapKeyInjected, setRemoteSteelswapUrl} from './config'
import {getSteelswapKey, invalidateSteelswapKey, resetSteelswapAuth, steelswapAuthHeaders} from './steelswap-auth'
import {steelswapCredentialState} from './steelswap-credential-state'
import type {FetchLike} from './token-metadata'

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

/** Fails the test if reached: nothing here may touch the network. */
const noFetch: FetchLike = () => {
  throw new Error('no request should be made')
}

beforeEach(() => {
  resetSteelswapAuth()
  setRemoteSteelswapKeyInjected(false)
  setRemoteSteelswapUrl(undefined)
})

describe('getRemoteSwapKeyInjectedByEndpoint', () => {
  it('is true only for an explicit true', () => {
    expect(getRemoteSwapKeyInjectedByEndpoint({swap: {keyInjectedByEndpoint: true}})).toBe(true)
  })

  it('defaults to false for absent, missing and malformed values', () => {
    // The safe direction: sending no credential to an API that requires one is a 401, whereas
    // sending one to an endpoint that also injects is simply overwritten.
    expect(getRemoteSwapKeyInjectedByEndpoint(undefined)).toBe(false)
    expect(getRemoteSwapKeyInjectedByEndpoint({})).toBe(false)
    expect(getRemoteSwapKeyInjectedByEndpoint({swap: {}})).toBe(false)
    expect(getRemoteSwapKeyInjectedByEndpoint({swap: {keyInjectedByEndpoint: 'yes'}} as never)).toBe(false)
  })
})

describe('the control plane flag reaching the assets config', () => {
  it('is off until the control plane says otherwise', () => {
    expect(getCardanoAssetsConfig('preprod').steelswapKeyInjectedByEndpoint).toBe(false)
  })

  it('is on once published', () => {
    setRemoteSteelswapKeyInjected(true)
    expect(getCardanoAssetsConfig('preprod').steelswapKeyInjectedByEndpoint).toBe(true)
  })

  it('applies to the control plane’s own URL, which is the pairing that ships', () => {
    setRemoteSteelswapKeyInjected(true)
    setRemoteSteelswapUrl('https://remote.example/swap')
    expect(getCardanoAssetsConfig('preprod').steelswapKeyInjectedByEndpoint).toBe(true)
  })

  // The other half of that rule — a build-time EXPO_PUBLIC_CARDANO_STEELSWAP_URL override
  // suppressing the flag — is asserted on the source in `config.ts`, because the override is
  // read once at module scope from env and cannot be moved at runtime from here.
})

describe('steelswapAuthHeaders', () => {
  it('sends NO authorization header when the endpoint injects the credential', async () => {
    setRemoteSteelswapKeyInjected(true)
    const headers = await run(steelswapAuthHeaders(getCardanoAssetsConfig('preprod'), noFetch))

    // Not an empty string and not a placeholder: either would authenticate as nothing.
    expect(headers).toEqual({})
    expect(Object.keys(headers)).toHaveLength(0)
  })

  it('reports the `endpoint` credential state, distinct from `partner`', () => {
    setRemoteSteelswapKeyInjected(true)
    return run(steelswapAuthHeaders(getCardanoAssetsConfig('preprod'), noFetch)).then(() => {
      expect(steelswapCredentialState()).toEqual({tag: 'endpoint'})
    })
  })

  it('acquires no key, so a testnet with no signer still succeeds', async () => {
    // This is the whole point. Without the flag this same call mints a CIP-8 key, and on preprod
    // that mint cannot succeed — so the headers would never be produced at all.
    setRemoteSteelswapKeyInjected(true)
    const result = await run(Effect.either(steelswapAuthHeaders(getCardanoAssetsConfig('preprod'), noFetch)))

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.right).toEqual({})
  })
})

describe('getSteelswapKey under endpoint injection', () => {
  it('fails rather than minting a key nothing will send', async () => {
    setRemoteSteelswapKeyInjected(true)
    // Via `Effect.either`: `runPromise` rejects with a FiberFailure whose message is the opaque
    // "An error has occurred", so asserting on the rejection would assert nothing about the reason.
    const result = await run(Effect.either(getSteelswapKey(getCardanoAssetsConfig('preprod'), noFetch)))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.reason).toMatch(/endpoint injects the credential/)
    }
  })
})

describe('invalidateSteelswapKey under endpoint injection', () => {
  it('refuses to retry, because nothing of ours was sent', () => {
    // A 401 here is the endpoint's own credential being rejected. Re-minting would send a
    // per-install key the proxy strips anyway, turning an operator problem into a silent one.
    setRemoteSteelswapKeyInjected(true)
    expect(invalidateSteelswapKey(getCardanoAssetsConfig('preprod'))).toBe(false)
  })
})
