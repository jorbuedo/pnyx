import {afterEach, describe, expect, it} from 'vitest'
import {getAllowedLinksSnapshot, isAllowedExternalLink, setAllowedLinks} from './allowed-links'

describe('allowed-links', () => {
  afterEach(() => {
    // Module-level cache bleeds across tests otherwise.
    setAllowedLinks(undefined)
  })

  it('rejects all links when the allowlist is unset', () => {
    expect(isAllowedExternalLink('https://example.com/promo')).toBe(false)
  })

  it('rejects all links when the allowlist is an empty object', () => {
    setAllowedLinks({})
    expect(isAllowedExternalLink('https://example.com/promo')).toBe(false)
  })

  it('accepts links matching an allowlisted origin + path prefix', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/campaign/', docs: 'https://docs.pnyx.pxkq.uk/'})
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/campaign/summer')).toBe(true)
    expect(isAllowedExternalLink('https://docs.pnyx.pxkq.uk/getting-started')).toBe(true)
  })

  it('rejects links without a matching prefix', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/'})
    expect(isAllowedExternalLink('https://evil.com/phish')).toBe(false)
  })

  it('ignores undefined prefix entries without crashing', () => {
    // Record<string, string> with a missing value slot (e.g. stale config).
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/', legacy: undefined})
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/hello')).toBe(true)
    expect(isAllowedExternalLink('https://example.com')).toBe(false)
  })

  it('matches strictly by path — same origin, different path is rejected', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/campaign/'})
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/not-allowed')).toBe(false)
  })

  it('accepts an explicit per-call allowlist override', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/'})
    expect(isAllowedExternalLink('https://other.com/hi', {only: 'https://other.com/'})).toBe(true)
    // Cached value unaffected.
    expect(isAllowedExternalLink('https://other.com/hi')).toBe(false)
  })

  it('exposes the cached snapshot for test introspection', () => {
    const value = {marketing: 'https://pnyx.pxkq.uk/'}
    setAllowedLinks(value)
    expect(getAllowedLinksSnapshot()).toEqual(value)
    setAllowedLinks(undefined)
    expect(getAllowedLinksSnapshot()).toBeUndefined()
  })

  // ── Security: the specific attacks a raw startsWith would have allowed ───

  it("rejects domain-confusion attack: host appears as prefix of attacker's host", () => {
    // Without origin-exact matching, `https://pnyx.pxkq.uk.evil.com/...`
    // would pass a raw startsWith('https://pnyx.pxkq.uk') check. Parsing
    // both as URLs and comparing .origin prevents this.
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk'})
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk.evil.com/phishing')).toBe(false)
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/hello')).toBe(true)
  })

  it('rejects host-suffix confusion even when the allowlisted prefix has a path', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/campaign/'})
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk.evil.com/campaign/spoof')).toBe(false)
  })

  it('rejects path-prefix collision — /camp/ must not match /camping/', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/camp'})
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/camping/summer')).toBe(false)
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/camp')).toBe(true)
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/camp/summer')).toBe(true)
  })

  it('rejects different protocols even if host and path match', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/'})
    expect(isAllowedExternalLink('http://pnyx.pxkq.uk/hello')).toBe(false)
  })

  it('rejects different ports even if host matches', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk:443/'})
    // Default https port — same origin as https://pnyx.pxkq.uk
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/hello')).toBe(true)
    // Non-default port — different origin.
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk:8443/hello')).toBe(false)
  })

  it('rejects malformed link inputs without throwing', () => {
    setAllowedLinks({marketing: 'https://pnyx.pxkq.uk/'})
    expect(isAllowedExternalLink('not-a-url')).toBe(false)
    expect(isAllowedExternalLink('')).toBe(false)
  })

  it('skips malformed prefix entries without throwing', () => {
    setAllowedLinks({bad: 'not-a-url', good: 'https://pnyx.pxkq.uk/'})
    // Good prefix still works despite a bad sibling.
    expect(isAllowedExternalLink('https://pnyx.pxkq.uk/x')).toBe(true)
  })
})
