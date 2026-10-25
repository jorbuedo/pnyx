/**
 * Jazzicon identicon tests.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {Jazzicon} from './jazzicon.js'

describe('Jazzicon', () => {
  it('should generate a deterministic identicon for a given seed', () => {
    const seed = 'abcdef1234567890'
    const jazz1 = Jazzicon({seed})
    const jazz2 = Jazzicon({seed})

    const svg1 = jazz1.asBase64({size: 100})
    const svg2 = jazz2.asBase64({size: 100})

    expect(svg1).toBe(svg2)
    expect(svg1).toContain('data:image/svg+xml;base64,')
  })

  it('should generate different identicons for different seeds', () => {
    const svg1 = Jazzicon({seed: 'abcdef1234567890'}).asBase64()
    const svg2 = Jazzicon({seed: '1234567890abcdef'}).asBase64()

    expect(svg1).not.toBe(svg2)
  })

  it('should generate SVG string directly', () => {
    const svg = Jazzicon({seed: 'abcdef1234567890'}).asSvg({size: 50})

    expect(svg).toContain('<svg')
    expect(svg).toContain('width="50"')
    expect(svg).toContain('height="50"')
    expect(svg).toContain('</svg>')
  })

  it('should throw an error if the seed is invalid', () => {
    expect(() => Jazzicon({seed: 'invalidseed'})).toThrow('Seed must be a valid hexadecimal string.')
  })

  it('should throw an error if there are insufficient base colors', () => {
    expect(() => Jazzicon({seed: 'abcdef1234567890', shapeCount: 10})).toThrow(
      'Insufficient colors, shape count too high.',
    )
  })

  it('should throw an error if the seed is too short', () => {
    expect(() => Jazzicon({seed: 'abc'})).toThrow('Seed must be at least 10 characters long.')
  })

  it('should respect custom shape count', () => {
    const svg = Jazzicon({seed: 'abcdef1234567890', shapeCount: 5}).asSvg()

    // Background rect + 5 shape rects = 6 total rects
    const rectCount = (svg.match(/<rect/g) ?? []).length
    expect(rectCount).toBe(6)
  })

  it('should use default size of 100 when no size given', () => {
    const svg = Jazzicon({seed: 'abcdef1234567890'}).asSvg()

    expect(svg).toContain('width="100"')
    expect(svg).toContain('height="100"')
  })

  it('should clip to circle when clip option is set', () => {
    const svg = Jazzicon({seed: 'abcdef1234567890'}).asSvg({clip: 'circle'})

    expect(svg).toContain('<clipPath id="jazzicon-clip-abcdef12">')
    expect(svg).toContain('<circle cx="50" cy="50" r="50" />')
    expect(svg).toContain('clip-path="url(#jazzicon-clip-abcdef12)"')
  })

  it('should not clip by default', () => {
    const svg = Jazzicon({seed: 'abcdef1234567890'}).asSvg()

    expect(svg).not.toContain('clipPath')
  })

  it('should produce same colors regardless of clip option', () => {
    const square = Jazzicon({seed: 'abcdef1234567890'}).asSvg()
    const circle = Jazzicon({seed: 'abcdef1234567890'}).asSvg({clip: 'circle'})

    const extractFills = (svg: string) => [...svg.matchAll(/fill="(#[0-9a-f]+)"/gi)].map((m) => m[1])
    expect(extractFills(circle)).toEqual(extractFills(square))
  })
})
