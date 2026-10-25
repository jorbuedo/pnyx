import {describe, expect, it} from 'vitest'
import {redactUrl} from './redact-url'

describe('redactUrl', () => {
  it('leaves a url with no query string alone', () => {
    expect(redactUrl('https://pnyx.pxkq.uk/register')).toBe('https://pnyx.pxkq.uk/register')
  })

  it('redacts the preprod indexer project id', () => {
    expect(redactUrl('https://midnight-preprod.blockfrost.io/api/v4/graphql?project_id=nightpreprodSECRET')).toBe(
      'https://midnight-preprod.blockfrost.io/api/v4/graphql?project_id=<redacted>',
    )
  })

  it('keeps non-secret parameters readable', () => {
    expect(redactUrl('https://x.test/a?page=2&api_key=abc&sort=desc')).toBe(
      'https://x.test/a?page=2&api_key=<redacted>&sort=desc',
    )
  })

  it('matches a secret name case-insensitively and inside a compound name', () => {
    expect(redactUrl('https://x.test/a?X-Api-Key=abc&accessToken=def&projectid=ghi')).toBe(
      'https://x.test/a?X-Api-Key=<redacted>&accessToken=def&projectid=<redacted>',
    )
  })

  it('does not redact a parameter that merely contains a secret word', () => {
    expect(redactUrl('https://x.test/a?monkey=1&keyboard=2')).toBe('https://x.test/a?monkey=1&keyboard=2')
  })

  it('redacts a valueless and a repeated parameter without losing the rest', () => {
    expect(redactUrl('https://x.test/a?token&token=1&token=2&q=z')).toBe(
      'https://x.test/a?token&token=<redacted>&token=<redacted>&q=z',
    )
  })

  it('keeps the fragment, and redacts only the query', () => {
    expect(redactUrl('https://x.test/a?secret=1#token=keep')).toBe('https://x.test/a?secret=<redacted>#token=keep')
  })

  it('redacts a relative url, which has no origin to parse', () => {
    expect(redactUrl('/api/graphql?project_id=abc')).toBe('/api/graphql?project_id=<redacted>')
  })
})
