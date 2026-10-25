import {type Cause, Effect, Exit} from 'effect'
import {describe, expect, it} from 'vitest'

import {failureOf, reasonOfThrown} from './effect-failure'

const causeOf = async (effect: Effect.Effect<never, unknown>): Promise<Cause.Cause<unknown>> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  return exit.cause
}

describe('failureOf', () => {
  it('reads kind and reason off a typed failure', async () => {
    const cause = await causeOf(Effect.fail({kind: 'protocol-params', reason: 'HTTP 503'}))
    expect(failureOf(cause)).toEqual({kind: 'protocol-params', reason: 'HTTP 503'})
  })

  it('keeps the reason when there is no kind', async () => {
    const cause = await causeOf(Effect.fail({reason: 'no endpoint configured'}))
    expect(failureOf(cause)).toEqual({kind: null, reason: 'no endpoint configured'})
  })

  /**
   * The case the bare `catch` used to swallow: a thrown defect carries neither field, and reporting
   * an empty reason is the same as reporting nothing. The pretty-printed cause keeps the message.
   */
  it('falls back to the pretty cause for a defect, rather than an empty reason', async () => {
    const cause = await causeOf(
      Effect.sync(() => {
        throw new Error('body is not valid CBOR')
      }),
    )
    const {kind, reason} = failureOf(cause)
    expect(kind).toBeNull()
    expect(reason).toContain('body is not valid CBOR')
  })

  it('reports something for a failure that is a bare string', async () => {
    const {reason} = failureOf(await causeOf(Effect.fail('nope')))
    expect(reason).toContain('nope')
  })
})

describe('reasonOfThrown', () => {
  it('keeps an Error’s name and message', () => {
    expect(reasonOfThrown(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
  })

  it('stringifies anything else', () => {
    expect(reasonOfThrown('plain')).toBe('plain')
    expect(reasonOfThrown(undefined)).toBe('undefined')
  })
})
