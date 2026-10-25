import {describe, expect, it} from 'vitest'
import {isCexplorerPlaceholder} from './cexplorer-placeholder'

describe('isCexplorerPlaceholder', () => {
  // Measured against the live CDN: real logos come back as pre-sized WEBP, the "no icon" answer as
  // one static 40×40 SVG (same etag for three assets, one of them a policy id that does not exist).
  it('classifies the SVG answer as the placeholder', () => {
    expect(isCexplorerPlaceholder({mediaType: 'image/svg+xml', width: 40, height: 40})).toBe(true)
  })

  it('leaves a real WEBP logo alone', () => {
    expect(isCexplorerPlaceholder({mediaType: 'image/webp', width: 256, height: 256})).toBe(false)
  })

  it('leaves a real PNG logo alone even at 40×40', () => {
    expect(isCexplorerPlaceholder({mediaType: 'image/png', width: 40, height: 40})).toBe(false)
  })

  it('is case- and whitespace-tolerant on the media type', () => {
    expect(isCexplorerPlaceholder({mediaType: ' IMAGE/SVG+XML '})).toBe(true)
  })

  // The fallback for platforms that report no media type.
  it('falls back to the exact intrinsic size when the media type is unknown', () => {
    expect(isCexplorerPlaceholder({mediaType: null, width: 40, height: 40})).toBe(true)
    expect(isCexplorerPlaceholder({width: 40, height: 40})).toBe(true)
  })

  // ⚠️ Exact match on both edges, not a bound: a small real logo has to keep rendering, and 40×40 is
  // one specific file rather than a size range.
  it('does not treat a merely small logo as the placeholder', () => {
    expect(isCexplorerPlaceholder({mediaType: null, width: 40, height: 41})).toBe(false)
    expect(isCexplorerPlaceholder({mediaType: null, width: 32, height: 32})).toBe(false)
  })

  it('says nothing when it knows nothing', () => {
    expect(isCexplorerPlaceholder({})).toBe(false)
  })
})
