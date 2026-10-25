import {describe, expect, it} from 'vitest'

import {describeSocketError} from './graphql-ws'

describe('describeSocketError', () => {
  it('reads an Error message', () => {
    expect(describeSocketError(new Error('refused'))).toBe('refused')
  })

  it('reads a React Native event-shaped object rather than rendering [object Object]', () => {
    // The defect this exists for: `String(event)` gave "[object Object]" and a failed DUST sync
    // reported nothing at all about why.
    expect(describeSocketError({message: 'connection failed', code: 1006})).toBe('connection failed · 1006')
  })

  it('reads a bare type when that is all there is', () => {
    expect(describeSocketError({type: 'error'})).toBe('error')
  })

  it('says so when an object carries no readable fields', () => {
    // Better than an empty string, which reads as "no error".
    expect(describeSocketError({})).toMatch(/no readable fields|\{\}/)
  })

  it('falls back to own properties for a non-enumerable event', () => {
    const event = Object.create({}, {reason: {value: 'handshake', enumerable: false}}) as object
    expect(describeSocketError(event)).toContain('handshake')
  })

  it('passes a string through', () => {
    expect(describeSocketError('plain')).toBe('plain')
  })

  it('handles null and undefined without throwing', () => {
    expect(describeSocketError(null)).toBe('null')
    expect(describeSocketError(undefined)).toBe('undefined')
  })
})
