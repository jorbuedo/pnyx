import {CalendarIdentifier} from 'expo-localization'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {getSystemTimeZone} from '../../hooks/useFormatDate'

vi.mock('expo-localization', () => ({
  CalendarIdentifier: {
    GREGORIAN: 'gregory',
  },
  getCalendars: vi.fn(),
}))

// Import after mock registration so vi.mock is in scope
import {getCalendars} from 'expo-localization'

const mockGetCalendars = vi.mocked(getCalendars)

// ─── getSystemTimeZone ────────────────────────────────────────────────────────

describe('getSystemTimeZone', () => {
  beforeEach(() => {
    mockGetCalendars.mockReset()
  })

  it('returns the IANA timezone from the first calendar entry', () => {
    mockGetCalendars.mockReturnValue([
      {timeZone: 'Asia/Tokyo', calendar: CalendarIdentifier.GREGORIAN, uses24hourClock: null, firstWeekday: null},
    ])
    expect(getSystemTimeZone()).toBe('Asia/Tokyo')
  })

  it('returns undefined when timeZone is null (platform could not determine it)', () => {
    mockGetCalendars.mockReturnValue([
      {timeZone: null, calendar: CalendarIdentifier.GREGORIAN, uses24hourClock: null, firstWeekday: null},
    ])
    expect(getSystemTimeZone()).toBeUndefined()
  })

  it('returns undefined when getCalendars returns an empty array', () => {
    // Cast: getCalendars' return type is a non-empty tuple in some expo-localization
    // versions, so an empty array (the case under test) needs a version-agnostic cast.
    mockGetCalendars.mockReturnValue([] as unknown as ReturnType<typeof getCalendars>)
    expect(getSystemTimeZone()).toBeUndefined()
  })

  it('returns the timezone of the first calendar when multiple are present', () => {
    mockGetCalendars.mockReturnValue([
      {timeZone: 'America/New_York', calendar: CalendarIdentifier.GREGORIAN, uses24hourClock: null, firstWeekday: null},
      {timeZone: 'Europe/London', calendar: CalendarIdentifier.GREGORIAN, uses24hourClock: null, firstWeekday: null},
    ])
    expect(getSystemTimeZone()).toBe('America/New_York')
  })
})

// ─── Date formatting behaviour (via Intl.DateTimeFormat) ─────────────────────
// These tests exercise the underlying Intl API that useFormatDate delegates to,
// confirming locale-aware output without needing to render React hooks.

describe('Intl.DateTimeFormat locale-aware formatting', () => {
  // 2026-02-23T12:00:00.000Z — a fixed UTC instant for deterministic output
  const UTC_INSTANT = new Date('2026-02-23T12:00:00.000Z')

  it('formats date in en-US short style', () => {
    const result = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeZone: 'UTC',
    }).format(UTC_INSTANT)
    expect(result).toBe('2/23/26')
  })

  it('formats date in ja-JP short style', () => {
    const result = new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'short',
      timeZone: 'UTC',
    }).format(UTC_INSTANT)
    expect(result).toBe('2026/02/23')
  })

  it('formats time in en-US short style', () => {
    const result = new Intl.DateTimeFormat('en-US', {
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(UTC_INSTANT)
    expect(result).toMatch(/12:00\s*(PM|pm)?/)
  })

  it('shifts date when a non-UTC timezone is applied', () => {
    // UTC+9: 2026-02-23T12:00Z becomes 2026-02-23T21:00+09:00
    const tokyo = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeZone: 'Asia/Tokyo',
    }).format(UTC_INSTANT)
    // Still 2026-02-23 in Tokyo (21:00 local, same day)
    expect(tokyo).toBe('2/23/26')
  })

  it('shifts date across midnight when crossing a day boundary', () => {
    // UTC 2026-02-23T00:30Z is still 2026-02-22 in America/New_York (UTC-5)
    const midnight = new Date('2026-02-23T00:30:00.000Z')
    const ny = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeZone: 'America/New_York',
    }).format(midnight)
    expect(ny).toBe('2/22/26')
  })
})
