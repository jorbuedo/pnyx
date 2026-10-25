import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {chainTip} from './chain-tip'

describe('chainTip', () => {
  it('answers the backend tip', async () => {
    const tip = {slot: 42, blockHash: 'ab'.repeat(32), blockHeight: 7, blockTime: 1_700_000_000}
    expect(await Effect.runPromise(chainTip({getTip: () => Effect.succeed(tip)}))).toEqual(tip)
  })

  it('fails typed when the backend reports no tip, rather than being asserted away', async () => {
    // `getTip` is optional on Evolution's provider; the alternative at every call site is `!`.
    const exit = await Effect.runPromiseExit(chainTip({}))
    expect(exit._tag).toBe('Failure')
    const error = exit._tag === 'Failure' ? exit.cause : null
    expect(JSON.stringify(error)).toContain('does not report a tip')
  })

  it('passes a provider failure through unchanged', async () => {
    const boom = new EvolutionProvider.ProviderError({message: '503 upstream'})
    const exit = await Effect.runPromiseExit(chainTip({getTip: () => Effect.fail(boom)}))
    expect(exit._tag === 'Failure' && JSON.stringify(exit.cause)).toContain('503 upstream')
  })
})
