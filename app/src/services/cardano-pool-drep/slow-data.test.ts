import {describe, expect, it, vi} from 'vitest'
import type {FetchLike} from './http'
import {fetchSlowData} from './slow-data'

const ok = (data: unknown): {ok: true; status: 200; json: () => Promise<unknown>} => ({
  ok: true,
  status: 200,
  json: async () => data,
})
const notOk = (status: number): {ok: false; status: number; json: () => Promise<unknown>} => ({
  ok: false,
  status,
  json: async () => ({}),
})

describe('fetchSlowData', () => {
  it('returns the R2 blob data (dataUrl set)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url === 'https://data.x/dreps.json') return ok({updatedAt: '2026-07-18T05:00:00Z', data: [{id: 'a'}]})
      throw new Error(`unexpected fetch: ${url}`)
    })
    const out = await fetchSlowData('https://data.x', 'dreps', fetchImpl)
    expect(out).toEqual([{id: 'a'}])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws (no fallback) when the R2 read is not ok', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => notOk(503))
    await expect(fetchSlowData('https://data.x', 'dreps', fetchImpl)).rejects.toThrow('dreps r2 503')
  })

  it('throws when the R2 blob is malformed (no data field)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok({updatedAt: '2026-07-18T05:00:00Z'}))
    await expect(fetchSlowData('https://data.x', 'pools', fetchImpl)).rejects.toThrow('pools r2 malformed')
  })

  it('throws without any fetch when dataUrl is undefined (testnets have no source)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ok({data: []}))
    await expect(fetchSlowData(undefined, 'pools', fetchImpl)).rejects.toThrow('pools unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
