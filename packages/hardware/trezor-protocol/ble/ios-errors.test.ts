import {describe, expect, it} from 'vitest'
import {classifyBleConnectionError, classifyCBError} from './ios-errors'

describe('classifyCBError', () => {
  it('returns undefined for undefined error code', () => {
    expect(classifyCBError(undefined)).toBeUndefined()
  })

  it('classifies code 14 as pairing-error', () => {
    expect(classifyCBError(14)).toBe('pairing-error')
  })

  it('classifies code 15 as pairing-error', () => {
    expect(classifyCBError(15)).toBe('pairing-error')
  })

  it('classifies code 6 as timeout', () => {
    expect(classifyCBError(6)).toBe('timeout')
  })

  it('classifies code 5 as recoverable', () => {
    expect(classifyCBError(5)).toBe('recoverable')
  })

  it('classifies code 10 as connection-error', () => {
    expect(classifyCBError(10)).toBe('connection-error')
  })

  it('classifies code 7 as connection-error', () => {
    expect(classifyCBError(7)).toBe('connection-error')
  })

  it('defaults unknown codes to connection-error', () => {
    expect(classifyCBError(999)).toBe('connection-error')
  })
})

describe('classifyBleConnectionError', () => {
  it('returns pairing-error for iOS code 14', () => {
    expect(classifyBleConnectionError({iosErrorCode: 14})).toBe('pairing-error')
  })

  it('returns pairing-error for iOS code 15', () => {
    expect(classifyBleConnectionError({iosErrorCode: 15})).toBe('pairing-error')
  })

  it('returns timeout for iOS code 6', () => {
    expect(classifyBleConnectionError({iosErrorCode: 6})).toBe('timeout')
  })

  it('returns pairing-error for peer removed pairing reason string', () => {
    expect(classifyBleConnectionError({reason: 'Peer removed pairing information'})).toBe('pairing-error')
  })

  it('returns connection-error for generic errors', () => {
    expect(classifyBleConnectionError({message: 'Something went wrong'})).toBe('connection-error')
  })

  it('returns connection-error when no iOS code and no matching reason', () => {
    expect(classifyBleConnectionError({})).toBe('connection-error')
  })

  it('prefers iOS code classification over reason string', () => {
    // Code 6 is timeout, but reason says pairing — iOS code wins
    expect(classifyBleConnectionError({iosErrorCode: 6, reason: 'Peer removed pairing information'})).toBe('timeout')
  })
})
