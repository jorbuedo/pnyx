/**
 * Test-only helpers for the SteelSwap CIP-8 credential.
 *
 * Every SteelSwap `/api/v2/*` call goes through `getSteelswapKey`, so a test
 * whose fetch stub does not answer the mint chain gets an auth failure instead
 * of the response it wrote. Before 2026-09-03 that chain was a single
 * `POST /auth/anon`; the endpoint was removed from the API, so the mint is now
 * `challenge → sign → verify → keys` and every stub has to serve four routes.
 *
 * This is the one place that shape lives, so a future change to the mint does
 * not mean editing every stub again. Not a `*.test.ts` file, so vitest does not
 * collect it as a suite; nothing in the app imports it.
 *
 * @module
 */

import {resetSteelswapAuth, setSteelswapSigner} from './steelswap-auth'

type StubResponse = {
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
  readonly headers?: {get(name: string): string | null}
}

/**
 * The mint-chain response for `url`, or `null` when the URL is not part of it —
 * so a stub can chain `steelswapAuthRoute(url) ?? …its own routes`.
 */
export const steelswapAuthRoute = (url: string): Promise<StubResponse> | null => {
  if (url.includes('/api/v2/auth/cip8/challenge')) {
    return Promise.resolve({ok: true, status: 200, json: async () => ({challenge: {}, message: 'sign-me'})})
  }
  if (url.includes('/api/v2/auth/cip8/verify')) {
    return Promise.resolve({ok: true, status: 200, json: async () => ({access_token: 'jwt', expires_in: 900})})
  }
  if (url.includes('/api/v2/auth/keys')) {
    return Promise.resolve({ok: true, status: 201, json: async () => ({api_key: 'test-key', prefix: 'pf'})})
  }
  return null
}

/** True when `url` belongs to the mint chain. */
export const isSteelswapAuthUrl = (url: string): boolean => url.includes('/api/v2/auth/')

/**
 * Reset the cached credential and register a signer that always succeeds, so
 * the mint chain can complete. Call from `beforeEach`.
 */
export const primeSteelswapAuth = (): void => {
  resetSteelswapAuth()
  setSteelswapSigner({
    addressBech32: 'addr1_test',
    sign: async () => ({signature: 'cose-sig', key: 'cose-key'}),
  })
}
