import {describe, expect, it} from 'vitest'

import {normalizeUrl} from './normalize-url'

const search = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`

describe('normalizeUrl — an explicit scheme is decisive', () => {
  it('opens http://localhost:8765/ instead of searching for it', () => {
    // The bug this exists for: the scheme check used to sit *inside* a `includes('.')` test, and
    // `localhost` has no dot — a port is a colon — so an explicit URL was sent to a search engine.
    expect(normalizeUrl('http://localhost:8765/', 'google')).toBe('http://localhost:8765/')
  })

  it('keeps http:// and https:// untouched, dot or no dot', () => {
    expect(normalizeUrl('http://10.0.2.2:8081', 'google')).toBe('http://10.0.2.2:8081')
    expect(normalizeUrl('https://example.com/a?b=c#d', 'google')).toBe('https://example.com/a?b=c#d')
    // Single-label internal hosts, and an IPv6 literal: colons, no dots.
    expect(normalizeUrl('https://intranet/page', 'google')).toBe('https://intranet/page')
    expect(normalizeUrl('http://[::1]:8080/', 'google')).toBe('http://[::1]:8080/')
  })

  it('does not downgrade or rewrite an http:// URL to https://', () => {
    // A dev server has no TLS; silently upgrading it would fail to connect and look like our bug.
    expect(normalizeUrl('http://example.com', 'google')).toBe('http://example.com')
  })
})

describe('normalizeUrl — bare hosts', () => {
  it('treats a dotted host as a URL and defaults it to https', () => {
    expect(normalizeUrl('example.com', 'google')).toBe('https://example.com')
    expect(normalizeUrl('example.com/path', 'google')).toBe('https://example.com/path')
  })

  it('treats localhost as a host even without a dot', () => {
    expect(normalizeUrl('localhost', 'google')).toBe('http://localhost')
    expect(normalizeUrl('localhost:8765', 'google')).toBe('http://localhost:8765')
    expect(normalizeUrl('localhost/probe', 'google')).toBe('http://localhost/probe')
  })

  it('uses http for localhost, since a local dev server has no TLS', () => {
    expect(normalizeUrl('localhost:8765', 'google').startsWith('http://')).toBe(true)
  })
})

describe('normalizeUrl — searches', () => {
  it('searches for words', () => {
    expect(normalizeUrl('midnight wallet', 'google')).toBe(search('midnight wallet'))
    expect(normalizeUrl('single', 'google')).toBe(search('single'))
  })

  it('searches for a phrase with a dot in it, because it has spaces', () => {
    // "the file is a.txt" is a question, not an address.
    expect(normalizeUrl('the file is a.txt', 'google')).toBe(search('the file is a.txt'))
  })

  it('searches for a colon-bearing phrase rather than treating it as a scheme', () => {
    expect(normalizeUrl('note: buy milk', 'google')).toBe(search('note: buy milk'))
  })

  it('does not mistake a word that merely starts with http for a URL', () => {
    expect(normalizeUrl('https', 'google')).toBe(search('https'))
    expect(normalizeUrl('httpsomething', 'google')).toBe(search('httpsomething'))
  })

  it('honours the chosen engine', () => {
    expect(normalizeUrl('midnight', 'brave')).toBe('https://search.brave.com/search?q=midnight')
  })
})

describe('normalizeUrl — empty', () => {
  it('answers empty for empty or whitespace, rather than searching for nothing', () => {
    expect(normalizeUrl('', 'google')).toBe('')
    expect(normalizeUrl('   ', 'google')).toBe('')
  })

  it('trims before deciding', () => {
    expect(normalizeUrl('  http://localhost:8765/  ', 'google')).toBe('http://localhost:8765/')
  })
})
