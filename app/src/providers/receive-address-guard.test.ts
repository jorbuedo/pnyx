import {describe, expect, it} from 'vitest'
import {ensureReceiveAddressValue} from './receive-address-guard'

describe('ensureReceiveAddressValue', () => {
  it('returns a non-empty string unchanged', () => {
    expect(ensureReceiveAddressValue('addr1qxy...', {chainId: 'cardano:mainnet'})).toBe('addr1qxy...')
    expect(ensureReceiveAddressValue('0xAbC', {chainId: 'eip155:8453'})).toBe('0xAbC')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['number', 42],
    ['object', {human: '0xAbC'}],
  ])('throws a named error for %s', (_label, value) => {
    expect(() => ensureReceiveAddressValue(value, {chainId: 'eip155:8453'})).toThrowError(
      expect.objectContaining({name: 'ReceiveAddressInvalidError'}),
    )
  })

  it('includes the chain and value shape in the message', () => {
    expect(() => ensureReceiveAddressValue(undefined, {chainId: 'eip155:8453'})).toThrowError(/eip155:8453.*undefined/)
  })

  it('falls back to "unknown chain" when no chainId is provided', () => {
    expect(() => ensureReceiveAddressValue(undefined, {})).toThrowError(/unknown chain/)
  })
})
