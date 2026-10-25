import {Data, Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {isCoinContentionError} from './submission'
import {describeSubmitFailure, submitRejectionError} from './submit-failure'

/** The shape the wallet SDK actually throws: a TaggedError whose truth is a field, not `Error.cause`. */
class SubmissionError extends Data.TaggedError('SubmissionError')<{
  readonly message: string
  readonly cause: unknown
}> {}

describe('describeSubmitFailure', () => {
  it('recovers the node reason the SDK wraps and runPromise flattens', async () => {
    // The reported failure: the sponsor recorded only "Transaction submission error" and the node's
    // actual complaint was unrecoverable from anywhere.
    const nodeError = new Error('1010: Invalid Transaction: Custom error: 186')
    const rejected = await Effect.runPromise(
      Effect.fail(new SubmissionError({message: 'Transaction submission error', cause: nodeError})),
    ).catch((error: unknown) => error)

    const described = describeSubmitFailure(rejected)
    expect(described).toContain('Custom error: 186')
    expect(described).toContain('Transaction submission error')
  })

  it('walks a plain Error cause chain', () => {
    const inner = new Error('connection refused')
    const outer = new Error('submit failed', {cause: inner})
    expect(describeSubmitFailure(outer)).toBe('submit failed ← connection refused')
  })

  it('reads a cause carried as a field rather than through Error', () => {
    const error = new SubmissionError({message: 'Transaction submission error', cause: new Error('node said no')})
    expect(describeSubmitFailure(error)).toContain('node said no')
  })

  it('does not repeat a message already covered by the rendered cause', async () => {
    const rejected = await Effect.runPromise(Effect.fail(new Error('only once'))).catch((e: unknown) => e)
    const described = describeSubmitFailure(rejected)
    expect(described.match(/only once/g)?.length).toBe(1)
  })

  it('survives a cause cycle instead of looping', () => {
    const a = new Error('a')
    const b = new Error('b', {cause: a})
    ;(a as {cause?: unknown}).cause = b
    expect(describeSubmitFailure(a)).toBe('a ← b')
  })

  it('says something for a non-Error rejection', () => {
    expect(describeSubmitFailure('just a string')).toBe('just a string')
    expect(describeSubmitFailure(undefined)).toBe('undefined')
  })

  it('makes a stale-coin rejection retryable, which it was not', async () => {
    // The claim that failed: the node said `Custom error: 170` (InvalidDustSpendProof) — a stale
    // fee-coin rejection the submitter knows how to recover from by resyncing and rebuilding. But
    // `isCoinContentionError` reads the *message*, and the SDK's said only "Transaction submission
    // error", so the retry never fired and a recoverable failure was thrown as fatal.
    const nodeError = new Error('1010: Invalid Transaction: Custom error: 170')
    const rejected = await Effect.runPromise(
      Effect.fail(new SubmissionError({message: 'Transaction submission error', cause: nodeError})),
    ).catch((error: unknown) => error)

    expect(isCoinContentionError(rejected)).toBe(false)
    expect(isCoinContentionError(submitRejectionError(rejected))).toBe(true)
  })
})
