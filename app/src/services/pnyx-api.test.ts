import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {PnyxApiError, pnyxApi} from './pnyx-api'
import {serviceUrl} from './pnyx-session'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pnyxApi request mapping', () => {
  it('lists circles from GET /circles without auth headers', async () => {
    const circles = [
      {
        id: 'c1',
        name: 'Treasury',
        description: 'demo',
        author: 'night-owl',
        createdAt: '2026-07-03T11:01:24.360Z',
        memberCount: 2,
        chain: {status: 'confirmed', chainId: '2', txId: 'aa'.repeat(32)},
      },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse({circles}))

    const result = await pnyxApi.listCircles()

    expect(result.circles).toEqual(circles)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${serviceUrl()}/circles`)
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({'content-type': 'application/json'})
    expect(init.body).toBeUndefined()
  })

  it('sends the bearer token and JSON body on POST endpoints', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({membership: {persona: 'owl', disclosed: false, joinedAt: 'now'}}))

    await pnyxApi.join('jwt-123', 'circle-1', 'owl')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${serviceUrl()}/circles/circle-1/join`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer jwt-123',
    })
    expect(JSON.parse(init.body as string)).toEqual({persona: 'owl'})
  })

  it('passes the optional token on getCircle and returns the full view', async () => {
    const view = {
      circle: {id: 'c1', name: 'T', description: '', author: 'a', createdAt: 'now', memberCount: 1},
      membership: null,
      proposals: [],
      posts: [],
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(view))
    await expect(pnyxApi.getCircle('c1')).resolves.toEqual(view)
    const [, anonInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(anonInit.headers).toEqual({'content-type': 'application/json'})

    fetchMock.mockResolvedValueOnce(jsonResponse(view))
    await pnyxApi.getCircle('c1', 'jwt-123')
    const [, authInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(authInit.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer jwt-123',
    })
  })

  it('posts votes with the yes/no value', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({proposal: {id: 'p1'}}))

    await pnyxApi.vote('jwt', 'p1', 'no')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${serviceUrl()}/proposals/p1/vote`)
    expect(JSON.parse(init.body as string)).toEqual({value: 'no'})
  })

  it('surfaces the service error body as an PnyxApiError with the HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({error: 'join the circle to post'}, 403))

    const failure = await pnyxApi.createPost('jwt', 'c1', {body: 'hello'}).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(PnyxApiError)
    expect((failure as PnyxApiError).status).toBe(403)
    expect((failure as PnyxApiError).message).toBe('join the circle to post')
    expect((failure as PnyxApiError).isNetworkError).toBe(false)
  })

  it('falls back to a generic message when the error body has no error field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const failure = await pnyxApi.listCircles().catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(PnyxApiError)
    expect((failure as PnyxApiError).message).toBe('request failed: 500')
  })

  it('maps a non-JSON error response to the HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', {status: 502}))

    const failure = await pnyxApi.listCircles().catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(PnyxApiError)
    expect((failure as PnyxApiError).status).toBe(502)
    expect((failure as PnyxApiError).message).toBe('request failed: 502')
  })

  it('maps fetch rejections to a network PnyxApiError (status undefined)', async () => {
    const cause = new TypeError('Network request failed')
    fetchMock.mockRejectedValueOnce(cause)

    const failure = await pnyxApi.listCircles().catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(PnyxApiError)
    expect((failure as PnyxApiError).status).toBeUndefined()
    expect((failure as PnyxApiError).isNetworkError).toBe(true)
    expect((failure as PnyxApiError).cause).toBe(cause)
  })
})
