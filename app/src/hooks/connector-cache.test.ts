import {describe, expect, it, vi} from 'vitest'

import {cachedBuild} from './connector-cache'

describe('cachedBuild', () => {
  it('keeps a successful build', async () => {
    const store = new Map<string, Promise<string | null>>()
    const build = vi.fn(async () => 'connector')

    expect(await cachedBuild(store, 'a', build)).toBe('connector')
    expect(await cachedBuild(store, 'a', build)).toBe('connector')
    expect(build).toHaveBeenCalledTimes(1)
  })

  // ⚠️ The defect this module exists for. One failed address read used to be answered from the cache
  // for the rest of the session, so "Serve agents" could never recover without a network switch.
  it('does not keep a null, so the next caller retries', async () => {
    const store = new Map<string, Promise<string | null>>()
    let attempt = 0
    const build = vi.fn(async () => {
      attempt++
      return attempt === 1 ? null : 'connector'
    })

    expect(await cachedBuild(store, 'a', build)).toBeNull()
    expect(store.has('a')).toBe(false)
    expect(await cachedBuild(store, 'a', build)).toBe('connector')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('does not keep a rejection, and rethrows it', async () => {
    const store = new Map<string, Promise<string | null>>()
    const build = vi.fn(async () => {
      throw new Error('the database is closed')
    })

    await expect(cachedBuild(store, 'a', build)).rejects.toThrow('the database is closed')
    expect(store.has('a')).toBe(false)
  })

  it('shares one build between callers that arrive together', async () => {
    const store = new Map<string, Promise<string | null>>()
    let release: (value: string) => void = () => undefined
    const build = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve
        }),
    )

    const first = cachedBuild(store, 'a', build)
    const second = cachedBuild(store, 'a', build)
    release('connector')

    expect(await first).toBe('connector')
    expect(await second).toBe('connector')
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('keeps entries apart by key', async () => {
    const store = new Map<string, Promise<string | null>>()
    await cachedBuild(store, 'a', async () => 'one')
    await cachedBuild(store, 'b', async () => 'two')

    expect(await cachedBuild(store, 'a', async () => 'unused')).toBe('one')
    expect(await cachedBuild(store, 'b', async () => 'unused')).toBe('two')
  })

  // A failing entry must not delete the retry that replaced it — otherwise two callers racing a
  // recovery leave the good connector unreachable.
  it('a late null does not evict a newer successful entry', async () => {
    const store = new Map<string, Promise<string | null>>()
    let releaseFirst: (value: string | null) => void = () => undefined
    const slowNull = cachedBuild(
      store,
      'a',
      () =>
        new Promise<string | null>((resolve) => {
          releaseFirst = resolve
        }),
    )

    // The first build is still in flight; force the entry out as a retry would, then seat a good one.
    store.delete('a')
    const good = cachedBuild(store, 'a', async () => 'connector')
    expect(await good).toBe('connector')

    releaseFirst(null)
    expect(await slowNull).toBeNull()
    expect(await cachedBuild(store, 'a', async () => 'unused')).toBe('connector')
  })
})
