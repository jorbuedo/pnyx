import {describe, expect, it} from 'vitest'

import {Blockies} from './blockies.js'
import {walletChecksum} from './checksum.js'
import {colorSaturation} from './color-saturation.js'
import {colorScheme} from './color-scheme.js'
import {walletProfile} from './wallet-profile.js'

describe('Blockies', () => {
  it('produces deterministic output for the same seed', () => {
    const a = Blockies({seed: 'deadbeef01234567'}).asBase64()
    const b = Blockies({seed: 'deadbeef01234567'}).asBase64()
    expect(a).toBe(b)
  })

  it('produces different output for different seeds', () => {
    const a = Blockies({seed: 'deadbeef01234567'}).asBase64()
    const b = Blockies({seed: 'cafebabe89abcdef'}).asBase64()
    expect(a).not.toBe(b)
  })

  it('returns a base64 data URI', () => {
    const result = Blockies({seed: 'aabbccdd'}).asBase64()
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('generates SVG with correct dimensions', () => {
    const result = Blockies({seed: 'aabbccdd'}).asBase64({size: 4, scale: 10})
    const svg = atob(result.replace('data:image/svg+xml;base64,', ''))
    expect(svg).toContain('viewBox="0 0 40 40"')
  })

  it('uses default size 8 and scale 8 (64x64)', () => {
    const result = Blockies({seed: 'aabbccdd'}).asBase64()
    const svg = atob(result.replace('data:image/svg+xml;base64,', ''))
    expect(svg).toContain('viewBox="0 0 64 64"')
  })

  it('handles empty seed', () => {
    const result = Blockies({seed: ''}).asBase64()
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('applies saturation factor', () => {
    const normal = Blockies({seed: 'aabbccdd'}).asBase64({saturationFactor: 0})
    const saturated = Blockies({seed: 'aabbccdd'}).asBase64({saturationFactor: 50})
    // Saturation changes colors, so SVGs should differ
    expect(normal).not.toBe(saturated)
  })
})

describe('colorScheme', () => {
  it('has 5 color palettes', () => {
    expect(colorScheme).toHaveLength(5)
  })

  it('each palette has primary, secondary, and spots', () => {
    for (const scheme of colorScheme) {
      expect(scheme.primary).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(scheme.secondary).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(scheme.spots).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})

describe('colorSaturation', () => {
  it('returns the same color for factor 0', () => {
    expect(colorSaturation('#FF0000', 0)).toBe('#FF0000')
  })

  it('throws for out-of-range factor', () => {
    expect(() => colorSaturation('#FF0000', 150)).toThrow()
    expect(() => colorSaturation('#FF0000', -150)).toThrow()
  })

  it('desaturates a color with negative factor', () => {
    const result = colorSaturation('#FF0000', -100)
    // Fully desaturated red at 50% lightness → gray
    expect(result).toBe('#808080')
  })

  it('handles white and black (no saturation to change)', () => {
    // White has no saturation, so saturation changes have no effect
    const white = colorSaturation('#FFFFFF', 50)
    expect(white).toBe('#ffffff')
  })
})

describe('walletChecksum', () => {
  it('produces deterministic output', () => {
    const a = walletChecksum('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')
    const b = walletChecksum('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')
    expect(a.plate).toBe(b.plate)
    expect(a.seed).toBe(b.seed)
  })

  it('plate matches XXXX-1234 format', () => {
    const result = walletChecksum('deadbeefcafebabe1234567890abcdef')
    expect(result.plate).toMatch(/^[A-Z]{4}-\d{4}$/)
  })

  it('seed is a 128-char hex string (BLAKE2B-512 output)', () => {
    const result = walletChecksum('deadbeefcafebabe1234567890abcdef')
    expect(result.seed).toMatch(/^[0-9a-f]{128}$/)
  })

  it('different keys produce different checksums', () => {
    const a = walletChecksum('0000000000000000000000000000000000000000000000000000000000000001')
    const b = walletChecksum('0000000000000000000000000000000000000000000000000000000000000002')
    expect(a.seed).not.toBe(b.seed)
  })

  it('handles 0x-prefixed keys', () => {
    const a = walletChecksum('deadbeef')
    const b = walletChecksum('0xdeadbeef')
    expect(a.plate).toBe(b.plate)
    expect(a.seed).toBe(b.seed)
  })
})

describe('walletProfile', () => {
  const seed128 = (prefix: string) => prefix.padEnd(128, '0')

  it('produces deterministic output for the same seed', () => {
    const a = walletProfile(seed128('abcd1234'), 21, 49)
    const b = walletProfile(seed128('abcd1234'), 21, 49)
    expect(a).toEqual(b)
  })

  it('indices are within bounds', () => {
    const profile = walletProfile(seed128('ffffffff'), 21, 49)
    expect(profile.colorIndex).toBeGreaterThanOrEqual(0)
    expect(profile.colorIndex).toBeLessThan(21)
    expect(profile.iconIndex).toBeGreaterThanOrEqual(0)
    expect(profile.iconIndex).toBeLessThan(49)
  })

  it('different seeds produce different profiles', () => {
    const a = walletProfile(seed128('00000000'), 21, 49)
    const b = walletProfile(seed128('ffffffff'), 21, 49)
    expect(a.colorIndex !== b.colorIndex || a.iconIndex !== b.iconIndex).toBe(true)
  })

  it('works with a real checksum seed', () => {
    const checksum = walletChecksum('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')
    const profile = walletProfile(checksum.seed, 21, 49)
    expect(profile.colorIndex).toBeGreaterThanOrEqual(0)
    expect(profile.colorIndex).toBeLessThan(21)
    expect(profile.iconIndex).toBeGreaterThanOrEqual(0)
    expect(profile.iconIndex).toBeLessThan(49)
  })
})
