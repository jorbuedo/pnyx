import {describe, expect, it} from 'vitest'
import {OFFICIAL_MIDNIGHT_SRS, officialSrsForK} from './pnyx-srs-catalog'

describe('officialSrsForK', () => {
  it('returns the pinned checksum for Pnyx circuit sizes', () => {
    // revealVote K=13, join/createProposal K=14, castVote K=15.
    expect(officialSrsForK('13')).toEqual({
      size: 1573252,
      sha256: 'd3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803',
    })
    expect(officialSrsForK('14')).toEqual({
      size: 3146116,
      sha256: 'fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244',
    })
    expect(officialSrsForK('15')).toEqual({
      size: 6291844,
      sha256: '724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de',
    })
  })

  it('throws for a K outside the ceremony (1..25)', () => {
    expect(() => officialSrsForK('0')).toThrow(/K=0/)
    expect(() => officialSrsForK('26')).toThrow(/K=26/)
  })

  it('pins the full ceremony output (K = 1..25) with well-formed checksums', () => {
    const ks = Object.keys(OFFICIAL_MIDNIGHT_SRS)
    expect(ks).toHaveLength(25)
    for (let k = 1; k <= 25; k++) {
      const entry = officialSrsForK(String(k))
      // File size formula from MIDNIGHT_SRS_CATALOG.md: 4 + 2·n·96 + 2·192, n = 2^k.
      expect(entry.size).toBe(4 + 2 * 2 ** k * 96 + 2 * 192)
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
