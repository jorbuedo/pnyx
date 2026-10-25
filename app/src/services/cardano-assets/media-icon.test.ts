import {describe, expect, it} from 'vitest'
import {MEDIA_ICON_SIZE, mediaIconUrl} from './media-icon'

const HOST = 'https://media.example.uk'
// CIP-14 vector: this policy + name fingerprints to asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92
const POLICY = '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373'
const ID = `${POLICY}.504154415445`
const FINGERPRINT = 'asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92'

describe('mediaIconUrl', () => {
  it('keys the URL on the CIP-14 fingerprint, not the raw asset id', () => {
    // The store is fingerprint-keyed; using policy.name would 404 every request.
    expect(mediaIconUrl(HOST, ID)).toBe(`${HOST}/${FINGERPRINT}/256.webp`)
  })

  it('returns null when no host is configured, so the feature stays opt-in', () => {
    // Absence is the default: the caller keeps its shipped placeholder and makes no request.
    expect(mediaIconUrl(undefined, ID)).toBeNull()
    expect(mediaIconUrl('', ID)).toBeNull()
  })

  it('returns null for ADA and malformed ids rather than a URL that cannot resolve', () => {
    expect(mediaIconUrl(HOST, '')).toBeNull()
    expect(mediaIconUrl(HOST, '.')).toBeNull()
    expect(mediaIconUrl(HOST, 'deadbeef.00')).toBeNull()
    expect(mediaIconUrl(HOST, `${POLICY}.zzzz`)).toBeNull()
  })

  it('tolerates a trailing slash on the host instead of emitting a double slash', () => {
    expect(mediaIconUrl(`${HOST}/`, ID)).toBe(`${HOST}/${FINGERPRINT}/256.webp`)
    expect(mediaIconUrl(`${HOST}///`, ID)).toBe(`${HOST}/${FINGERPRINT}/256.webp`)
  })

  it('an asset with an empty name still resolves — that is legal on Cardano', () => {
    expect(mediaIconUrl(HOST, `${POLICY}.`)).toBe(`${HOST}/asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3/256.webp`)
  })

  it('requests the 256 tier', () => {
    expect(MEDIA_ICON_SIZE).toBe(256)
    expect(mediaIconUrl(HOST, ID)).toContain('/256.webp')
  })
})

describe('assetMediaIconUrl (env-bound)', () => {
  it('is ON by default — no env var required', async () => {
    // Guards the deliberate choice that this needs no configuration: a flag nobody remembers to
    // set is a feature that never ships. If someone reintroduces an opt-in gate, this fails.
    const {assetMediaIconUrl} = await import('./config')
    const url = assetMediaIconUrl('7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373.504154415445')
    expect(url).toBe('https://media.pxkq.uk/asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92/256.webp')
  })

  it('still yields null for ADA and malformed ids', async () => {
    const {assetMediaIconUrl} = await import('./config')
    expect(assetMediaIconUrl('')).toBeNull()
    expect(assetMediaIconUrl('deadbeef.00')).toBeNull()
  })
})
