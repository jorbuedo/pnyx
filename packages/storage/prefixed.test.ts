import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {createMemoryStorage} from './memory.js'
import {createPrefixedStorage} from './prefixed.js'

const run = <A>(e: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)

describe('createPrefixedStorage', () => {
  it('returns the inner storage untouched for an empty prefix', () => {
    const inner = createMemoryStorage()
    expect(createPrefixedStorage(inner, '')).toBe(inner)
  })

  it('writes under the prefix and reads back through the caller key', async () => {
    const inner = createMemoryStorage()
    const view = createPrefixedStorage(inner, 'p/')

    await run(view.set('k', 'v'))

    expect(await run(view.get('k'))).toBe('v')
    expect(await run(inner.get('p/k'))).toBe('v')
    expect(await run(inner.get('k'))).toBeNull()
  })

  it('isolates two views over the same backend', async () => {
    const inner = createMemoryStorage()
    const a = createPrefixedStorage(inner, 'a/')
    const b = createPrefixedStorage(inner, 'b/')

    await run(a.set('k', 'from-a'))
    await run(b.set('k', 'from-b'))

    expect(await run(a.get('k'))).toBe('from-a')
    expect(await run(b.get('k'))).toBe('from-b')
  })

  it('lists only its own keys, stripped', async () => {
    const inner = createMemoryStorage()
    const view = createPrefixedStorage(inner, 'p/')

    await run(inner.set('other', 'x'))
    await run(view.set('mine', 'y'))

    expect(await run(view.keys())).toEqual(['mine'])
  })

  it('clear() removes only its own namespace', async () => {
    const inner = createMemoryStorage()
    const view = createPrefixedStorage(inner, 'p/')

    await run(inner.set('outside', 'keep'))
    await run(view.set('inside', 'drop'))

    await run(view.clear())

    expect(await run(inner.get('outside'))).toBe('keep')
    expect(await run(inner.get('p/inside'))).toBeNull()
  })

  it('multiGet returns caller keys, not prefixed ones', async () => {
    const inner = createMemoryStorage()
    const view = createPrefixedStorage(inner, 'p/')

    await run(view.multiSet([['a', '1'] as [string, string], ['b', '2'] as [string, string]]))

    expect(await run(view.multiGet(['a', 'b', 'missing']))).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['missing', null],
    ])
  })

  it('multiRemove only touches its own namespace', async () => {
    const inner = createMemoryStorage()
    const view = createPrefixedStorage(inner, 'p/')

    await run(inner.set('a', 'outside'))
    await run(view.set('a', 'inside'))
    await run(view.multiRemove(['a']))

    expect(await run(inner.get('a'))).toBe('outside')
    expect(await run(view.get('a'))).toBeNull()
  })
})
