import {afterEach, describe, expect, it} from 'vitest'
import {
  clearDeepAdaHistory,
  type DeepAdaDataset,
  deepPointsInRange,
  hasDeepAdaHistory,
  loadDeepAdaPoints,
} from './deep-ada-history'
import type {FetchLike} from './port'

const DATASET: DeepAdaDataset = {
  fiats: {
    USD: [
      [1_000, 0.3],
      [2_000, 0.35],
      [3_000, 0.4],
    ],
  },
}

const ENV_KEY = 'EXPO_PUBLIC_DEEP_ADA_HISTORY_URL'
const original = process.env[ENV_KEY]

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = original
  clearDeepAdaHistory()
})

describe('deepPointsInRange', () => {
  it('returns the fiat points within the window, ascending', () => {
    expect(deepPointsInRange(DATASET, 'USD', 1_500, 3_000)).toEqual([
      {ts: 2_000, value: 0.35},
      {ts: 3_000, value: 0.4},
    ])
  })
  it('is empty for a fiat the dataset lacks', () => {
    expect(deepPointsInRange(DATASET, 'EUR', 0, 9_999)).toEqual([])
  })
})

describe('loadDeepAdaPoints', () => {
  it('defaults on (R2-direct URL) when no override is set', () => {
    delete process.env[ENV_KEY]
    expect(hasDeepAdaHistory()).toBe(true)
  })

  it('is disabled (no fetch) when explicitly turned off', async () => {
    process.env[ENV_KEY] = 'off'
    expect(hasDeepAdaHistory()).toBe(false)
    expect(await loadDeepAdaPoints('USD', 0, 9_999, () => Promise.reject(new Error('must not fetch')))).toEqual([])
  })

  it('fetches once, caches, and serves points in range', async () => {
    process.env[ENV_KEY] = 'https://r2.example/deep-ada.json'
    let calls = 0
    const fetchImpl: FetchLike = () => {
      calls++
      return Promise.resolve({ok: true, status: 200, json: async () => DATASET})
    }
    expect(hasDeepAdaHistory()).toBe(true)
    const a = await loadDeepAdaPoints('USD', 1_500, 3_000, fetchImpl)
    expect(a.map((p) => p.value)).toEqual([0.35, 0.4])
    // Second call serves from the in-memory cache — no refetch.
    const b = await loadDeepAdaPoints('USD', 0, 1_500, fetchImpl)
    expect(b.map((p) => p.value)).toEqual([0.3])
    expect(calls).toBe(1)
  })

  it('degrades to empty (and does not retry) on a failed fetch', async () => {
    process.env[ENV_KEY] = 'https://r2.example/deep-ada.json'
    let calls = 0
    const fetchImpl: FetchLike = () => {
      calls++
      return Promise.resolve({ok: false, status: 404, json: async () => ({})})
    }
    expect(await loadDeepAdaPoints('USD', 0, 9_999, fetchImpl)).toEqual([])
    expect(await loadDeepAdaPoints('USD', 0, 9_999, fetchImpl)).toEqual([])
    expect(calls).toBe(1) // `loaded` guard prevents a re-fetch storm
  })
})
