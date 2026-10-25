import {RequestBudget} from '@evolution-sdk/evolution'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {koiosAuthHeaders, pacedKoiosFetch} from './koios-request'
import {clearKoiosToken, setKoiosToken} from './koios-token'

describe('koiosAuthHeaders', () => {
  afterEach(async () => {
    await clearKoiosToken('mainnet')
  })

  it('sends the token, so these calls are charged to the authenticated tier and not the shared IP bucket', async () => {
    await setKoiosToken('mainnet', 'tok')
    expect(koiosAuthHeaders('mainnet', 'https://api.koios.rest/api/v1')).toEqual({authorization: 'Bearer tok'})
  })

  it('withholds it from a plaintext endpoint rather than putting a credential on the wire', async () => {
    await setKoiosToken('mainnet', 'tok')
    expect(koiosAuthHeaders('mainnet', 'http://koios.example/api/v1')).toEqual({})
  })

  it('allows loopback, so a local Koios can stand in during development', async () => {
    await setKoiosToken('mainnet', 'tok')
    expect(koiosAuthHeaders('mainnet', 'http://127.0.0.1:8053/api/v1')).toEqual({authorization: 'Bearer tok'})
  })

  it('is empty with no token — an unauthenticated request, not a broken header', () => {
    expect(koiosAuthHeaders('preprod', 'https://preprod.koios.rest/api/v1')).toEqual({})
  })
})

describe('pacedKoiosFetch', () => {
  afterEach(() => {
    RequestBudget.setObserver(null)
    RequestBudget.reset()
    vi.unstubAllGlobals()
  })

  it('gives the endpoint the same allowance the provider does, so these calls are actually paced', async () => {
    // ⚠️ A host with no configured budget is counted and never held back, and this function
    // can run before any provider exists — so without this the out-of-band calls would read
    // as metered while spending the server's allowance unpaced.
    RequestBudget.reset()
    vi.stubGlobal('fetch', async () => new Response('[]', {status: 200}))

    await pacedKoiosFetch('https://api.koios.rest/api/v1/asset_info')

    expect(RequestBudget.budgetFor('https://api.koios.rest')).toEqual({limit: 90, windowMs: 10_000})
  })

  it('reports the request, so a call the provider has no method for still shows up in the tally', async () => {
    const seen: RequestBudget.RequestReport[] = []
    RequestBudget.setObserver((r) => seen.push(r))
    vi.stubGlobal('fetch', async () => new Response('[]', {status: 200}))
    const response = await pacedKoiosFetch('https://api.koios.rest/api/v1/asset_info?select=x', {method: 'POST'})
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({host: 'https://api.koios.rest', path: '/api/v1/asset_info', status: 200})
  })

  it('reports a refusal with its body, which is the only thing that tells the two 429s apart', async () => {
    const seen: RequestBudget.RequestReport[] = []
    RequestBudget.setObserver((r) => seen.push(r))
    vi.stubGlobal('fetch', async () => new Response('Exceeded Burst Limit, count was 76', {status: 429}))
    const response = await pacedKoiosFetch('https://api.koios.rest/api/v1/asset_nft_address')
    expect(seen[0]).toMatchObject({status: 429, refusalBody: 'Exceeded Burst Limit, count was 76'})
    // The caller still gets an unread body — the meter consumed a clone.
    await expect(response.text()).resolves.toBe('Exceeded Burst Limit, count was 76')
  })

  it('reports a request that never got a response, then rethrows', async () => {
    const seen: RequestBudget.RequestReport[] = []
    RequestBudget.setObserver((r) => seen.push(r))
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    await expect(pacedKoiosFetch('https://api.koios.rest/api/v1/tip')).rejects.toThrow('network down')
    expect(seen[0]).toMatchObject({status: 0, path: '/api/v1/tip'})
  })
})
