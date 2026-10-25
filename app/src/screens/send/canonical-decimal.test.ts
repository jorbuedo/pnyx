import {describe, expect, it} from 'vitest'
import {canonicalToDecimal} from './canonical-decimal'

describe('canonicalToDecimal', () => {
  it('renders a whole amount without a fraction', () => {
    expect(canonicalToDecimal(1_000n * 10n ** 6n, 6)).toBe('1000')
  })

  it('keeps every significant digit and trims only trailing zeros', () => {
    expect(canonicalToDecimal(1_500_000n, 6)).toBe('1.5')
    expect(canonicalToDecimal(1_000_001n, 6)).toBe('1.000001')
  })

  it('pads a fraction smaller than one unit', () => {
    expect(canonicalToDecimal(1n, 6)).toBe('0.000001')
  })

  it('handles zero', () => {
    expect(canonicalToDecimal(0n, 6)).toBe('0')
  })

  // The two copies this replaced disagreed here: one padded a zero-decimal value into '0.x'.
  it('returns a bare integer when the asset has no decimals', () => {
    expect(canonicalToDecimal(42n, 0)).toBe('42')
    expect(canonicalToDecimal(0n, 0)).toBe('0')
  })
})
