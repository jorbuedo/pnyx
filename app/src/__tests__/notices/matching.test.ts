/**
 * Unit tests for the pure notice-registry helpers.
 *
 * Covers the pieces extracted from the React layer so they can be tested
 * without rendering:
 *
 *   - `stripTrailingSlash` — route normalization
 *   - `matchesRoute` — descendant detection (exact + literal path-segment prefix)
 *   - `isDismissed` — revision-scoped dismissal check
 *   - `hasActiveDot` — should a consumer at `target` light up given current
 *     notices + dismissals?
 *   - `findKeysToDismissAt` — which dismissable+active keys a visit should
 *     silence, and at what revision
 *   - `parseDismissals` / `serializeDismissals` — storage round-trip, with
 *     tolerance for malformed blobs and the legacy `string[]` shape
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {
  type Dismissals,
  findKeysToDismissAt,
  hasActiveDot,
  isDismissed,
  matchesRoute,
  parseDismissals,
  serializeDismissals,
  stripTrailingSlash,
} from '../../notices/matching'
import type {NoticeValue} from '../../notices/NoticeContext'

const n = (over: Partial<NoticeValue> = {}): NoticeValue => ({route: '/x', active: true, ...over})
const dismissed = (...entries: Array<[string, string]>): Dismissals => new Map(entries)
const NONE: Dismissals = new Map()

// ============================================================================
// stripTrailingSlash
// ============================================================================

describe('stripTrailingSlash', () => {
  it('strips a single trailing slash', () => {
    expect(stripTrailingSlash('/settings/')).toBe('/settings')
    expect(stripTrailingSlash('/a/b/c/')).toBe('/a/b/c')
  })

  it('leaves a non-trailing path alone', () => {
    expect(stripTrailingSlash('/settings')).toBe('/settings')
    expect(stripTrailingSlash('/a/b')).toBe('/a/b')
  })

  it('leaves root alone', () => {
    expect(stripTrailingSlash('/')).toBe('/')
  })

  it('handles empty input without throwing', () => {
    expect(stripTrailingSlash('')).toBe('')
  })
})

// ============================================================================
// matchesRoute
// ============================================================================

describe('matchesRoute', () => {
  it('matches an exact equal route', () => {
    expect(matchesRoute('/settings', '/settings')).toBe(true)
  })

  it('matches a literal descendant (sub-route)', () => {
    expect(matchesRoute('/settings/wallet-settings', '/settings')).toBe(true)
    expect(matchesRoute('/claim-night/abc', '/claim-night')).toBe(true)
  })

  it('does NOT match a string prefix that is not a path-segment boundary', () => {
    // `/settings-foo` starts with `/settings` as a string but is not a
    // descendant of `/settings` — only `/settings/...` counts.
    expect(matchesRoute('/settings-foo', '/settings')).toBe(false)
    expect(matchesRoute('/settingsextra', '/settings')).toBe(false)
  })

  it('does NOT match an unrelated route', () => {
    expect(matchesRoute('/claim-night', '/settings')).toBe(false)
    expect(matchesRoute('/settings', '/settings/wallet-settings')).toBe(false)
  })

  it('tolerates a trailing slash on the target', () => {
    expect(matchesRoute('/settings/wallet-settings', '/settings/')).toBe(true)
    expect(matchesRoute('/settings', '/settings/')).toBe(true)
  })

  it('is case-sensitive', () => {
    expect(matchesRoute('/Settings', '/settings')).toBe(false)
  })
})

// ============================================================================
// isDismissed
// ============================================================================

describe('isDismissed', () => {
  it('is false when the key is absent', () => {
    expect(isDismissed(NONE, 'k', n())).toBe(false)
  })

  it('is true for a versionless notice dismissed at the empty revision', () => {
    expect(isDismissed(dismissed(['k', '']), 'k', n())).toBe(true)
  })

  it('is true only when the dismissed revision matches the current one', () => {
    const notice = n({revision: '150'})
    expect(isDismissed(dismissed(['k', '150']), 'k', notice)).toBe(true)
    expect(isDismissed(dismissed(['k', '100']), 'k', notice)).toBe(false)
  })
})

// ============================================================================
// hasActiveDot
// ============================================================================

describe('hasActiveDot', () => {
  it('returns false when the map is empty', () => {
    expect(hasActiveDot(new Map(), NONE, '/settings')).toBe(false)
  })

  it('lights up when an active notice is anchored at the target', () => {
    const notices = new Map([['k', n({route: '/settings', active: true})]])
    expect(hasActiveDot(notices, NONE, '/settings')).toBe(true)
  })

  it('lights up for a descendant notice (prefix propagation)', () => {
    const notices = new Map([['k', n({route: '/settings/wallet-settings', active: true})]])
    expect(hasActiveDot(notices, NONE, '/settings')).toBe(true)
    expect(hasActiveDot(notices, NONE, '/settings/wallet-settings')).toBe(true)
  })

  it('skips inactive notices', () => {
    const notices = new Map([['k', n({route: '/settings', active: false})]])
    expect(hasActiveDot(notices, NONE, '/settings')).toBe(false)
  })

  it('skips dismissable notices whose key is dismissed at the current revision', () => {
    const notices = new Map([['k', n({route: '/settings', active: true, dismissable: true})]])
    expect(hasActiveDot(notices, dismissed(['k', '']), '/settings')).toBe(false)
  })

  it('re-lights a dismissed notice once its revision changes', () => {
    // Dismissed at revision "100"; the notice now carries "150" → re-armed.
    const notices = new Map([['k', n({route: '/claim-night', active: true, dismissable: true, revision: '150'})]])
    expect(hasActiveDot(notices, dismissed(['k', '100']), '/claim-night')).toBe(true)
    expect(hasActiveDot(notices, dismissed(['k', '150']), '/claim-night')).toBe(false)
  })

  it('ignores the dismissals for NON-dismissable notices', () => {
    // A non-dismissable notice stays lit even if some stale dismissal entry
    // happens to share its key — dismissability is a per-notice contract.
    const notices = new Map([['k', n({route: '/settings', active: true, dismissable: false})]])
    expect(hasActiveDot(notices, dismissed(['k', '']), '/settings')).toBe(true)
  })

  it('lights up when ANY active undismissed notice matches, even if others are dismissed', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/settings/security', active: true, dismissable: true})],
      ['b', n({route: '/settings/wallet-settings', active: true, dismissable: true})],
    ])
    // `a` dismissed, `b` still shows → the parent `/settings` stays lit.
    expect(hasActiveDot(notices, dismissed(['a', '']), '/settings')).toBe(true)
  })

  it('returns false when all matching notices are dismissed', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/settings/security', active: true, dismissable: true})],
      ['b', n({route: '/settings/wallet-settings', active: true, dismissable: true})],
    ])
    expect(hasActiveDot(notices, dismissed(['a', ''], ['b', '']), '/settings')).toBe(false)
  })

  it('does not confuse string-prefix matches for path-segment matches', () => {
    const notices = new Map([['k', n({route: '/settings-foo', active: true})]])
    expect(hasActiveDot(notices, NONE, '/settings')).toBe(false)
  })

  it('tolerates a trailing slash on the query', () => {
    const notices = new Map([['k', n({route: '/settings/wallet-settings/x', active: true})]])
    expect(hasActiveDot(notices, NONE, '/settings/')).toBe(true)
  })
})

// ============================================================================
// findKeysToDismissAt
// ============================================================================

describe('findKeysToDismissAt', () => {
  it('returns only dismissable + active notices at or below the route, with their revision', () => {
    const notices = new Map<string, NoticeValue>([
      ['urgent', n({route: '/settings/wallet-settings', active: true, dismissable: false})],
      ['security', n({route: '/settings/security', active: true, dismissable: true})],
      ['midnight', n({route: '/claim-night/a', active: true, dismissable: true, revision: '42'})],
      ['elsewhere', n({route: '/settings', active: true, dismissable: true})],
    ])
    const out = findKeysToDismissAt(notices, NONE, '/claim-night')
    // - urgent: not dismissable, wrong route → skipped
    // - security: wrong route → skipped
    // - midnight: dismissable + active + matches → included at its revision
    // - elsewhere: wrong route → skipped
    expect([...out]).toEqual([['midnight', '42']])
  })

  it('records the empty revision for versionless notices', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/settings/security', active: true, dismissable: true})],
    ])
    const out = findKeysToDismissAt(notices, NONE, '/settings/security')
    expect(out.get('a')).toBe('')
  })

  it('excludes keys already dismissed at the current revision', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/settings/security', active: true, dismissable: true})],
      ['b', n({route: '/settings/security', active: true, dismissable: true})],
    ])
    const out = findKeysToDismissAt(notices, dismissed(['a', '']), '/settings/security')
    expect([...out.keys()]).toEqual(['b'])
  })

  it('re-includes a key whose revision changed since it was dismissed', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/claim-night', active: true, dismissable: true, revision: '150'})],
    ])
    const out = findKeysToDismissAt(notices, dismissed(['a', '100']), '/claim-night')
    expect(out.get('a')).toBe('150')
  })

  it('excludes inactive notices', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/settings/security', active: false, dismissable: true})],
      ['b', n({route: '/settings/security', active: true, dismissable: true})],
    ])
    const out = findKeysToDismissAt(notices, NONE, '/settings/security')
    expect([...out.keys()]).toEqual(['b'])
  })

  it('returns an empty map when nothing matches', () => {
    const notices = new Map<string, NoticeValue>([
      ['a', n({route: '/settings/security', active: true, dismissable: true})],
    ])
    const out = findKeysToDismissAt(notices, NONE, '/claim-night')
    expect(out.size).toBe(0)
  })

  it('includes the exact-route match, not only descendants', () => {
    const notices = new Map<string, NoticeValue>([['a', n({route: '/claim-night', active: true, dismissable: true})]])
    const out = findKeysToDismissAt(notices, NONE, '/claim-night')
    expect([...out.keys()]).toEqual(['a'])
  })
})

// ============================================================================
// parseDismissals / serializeDismissals
// ============================================================================

describe('parseDismissals', () => {
  it('returns an empty map for null / empty input', () => {
    expect(parseDismissals(null).size).toBe(0)
    expect(parseDismissals('').size).toBe(0)
  })

  it('parses the canonical [key, revision][] shape', () => {
    const out = parseDismissals(
      JSON.stringify([
        ['a', '1'],
        ['b', ''],
      ]),
    )
    expect(out.get('a')).toBe('1')
    expect(out.get('b')).toBe('')
  })

  it('maps a legacy string[] payload to the empty revision', () => {
    const out = parseDismissals(JSON.stringify(['a', 'b']))
    expect(out.get('a')).toBe('')
    expect(out.get('b')).toBe('')
  })

  it('falls back to empty map on malformed JSON (no throw)', () => {
    expect(parseDismissals('not json').size).toBe(0)
    expect(parseDismissals('{"not":"array"}').size).toBe(0)
    expect(parseDismissals('[').size).toBe(0)
  })

  it('coerces a non-string revision to the empty string', () => {
    const out = parseDismissals(
      JSON.stringify([
        ['a', 5],
        ['b', null],
      ]),
    )
    expect(out.get('a')).toBe('')
    expect(out.get('b')).toBe('')
  })
})

describe('serializeDismissals', () => {
  it('serializes an empty map to an empty JSON array', () => {
    expect(serializeDismissals(new Map())).toBe('[]')
  })

  it('round-trips through parseDismissals', () => {
    const start = dismissed(['security-settings-unseen', ''], ['midnight-redeem:abc', '4200'], ['backup-pending', ''])
    const parsed = parseDismissals(serializeDismissals(start))
    expect(parsed).toEqual(start)
  })
})
