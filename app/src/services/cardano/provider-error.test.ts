import {describe, expect, it} from 'vitest'
import {providerErrorText} from './provider-error'

describe('providerErrorText', () => {
  it('keeps both halves: the member from the summary, the reason from the cause', () => {
    expect(providerErrorText({message: 'getTxInfo failed', cause: new Error('429 Too Many Requests')})).toBe(
      'getTxInfo failed (429 Too Many Requests)',
    )
  })

  it('is the summary alone when there is no cause', () => {
    expect(providerErrorText({message: 'getUtxos failed'})).toBe('getUtxos failed')
  })

  it('reaches the innermost cause rather than the wrapper', () => {
    const inner = new Error('ECONNREFUSED 127.0.0.1:443')
    const outer = new Error('fetch failed', {cause: inner})
    expect(providerErrorText({message: 'submitTx failed', cause: outer})).toBe(
      'submitTx failed (ECONNREFUSED 127.0.0.1:443)',
    )
  })

  it('does not report the string "undefined" as an explanation', () => {
    // `String(undefined)` reads as a real reason to anyone looking at the log line.
    expect(providerErrorText({message: 'getTip failed', cause: new Error('fetch failed', {cause: undefined})})).toBe(
      'getTip failed (fetch failed)',
    )
    expect(providerErrorText({message: 'getTip failed', cause: undefined})).toBe('getTip failed')
    expect(providerErrorText({message: 'getTip failed', cause: ''})).toBe('getTip failed')
  })

  it('does not repeat a cause that is already the summary', () => {
    expect(providerErrorText({message: 'the same thing', cause: 'the same thing'})).toBe('the same thing')
  })

  it('reads a non-Error cause', () => {
    expect(providerErrorText({message: 'getPools failed', cause: {status: 503}})).toBe(
      'getPools failed ([object Object])',
    )
    expect(providerErrorText({message: 'getPools failed', cause: 'plain string'})).toBe(
      'getPools failed (plain string)',
    )
  })
})
