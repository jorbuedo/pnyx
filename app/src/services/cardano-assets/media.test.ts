import {describe, expect, it} from 'vitest'
import {assetMediaUrl} from './media'

describe('assetMediaUrl', () => {
  it('passes through an https URI', () => {
    expect(assetMediaUrl({image: 'https://example.org/a.png'})).toBe('https://example.org/a.png')
  })

  it('passes through an inline data URI — no network at all', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo='
    expect(assetMediaUrl({image: uri})).toBe(uri)
  })

  it('rewrites an ipfs URI onto the gateway', () => {
    const cid = 'QmWJXZcAuao4odPwEc37dE3Rdbu2mJ4PJqmoPqoPxVyGuH'
    expect(assetMediaUrl({image: `ipfs://${cid}`})).toBe(`https://ipfs.io/ipfs/${cid}`)
  })

  it('tolerates the ipfs://ipfs/ form and a trailing path', () => {
    expect(assetMediaUrl({image: 'ipfs://ipfs/QmAbc'})).toBe('https://ipfs.io/ipfs/QmAbc')
    expect(assetMediaUrl({image: 'ipfs://QmAbc/1.png'})).toBe('https://ipfs.io/ipfs/QmAbc/1.png')
  })

  it('is null when the asset declares no media', () => {
    expect(assetMediaUrl({})).toBeNull()
    expect(assetMediaUrl({image: '   '})).toBeNull()
  })

  it('refuses a scheme that is not media over TLS', () => {
    expect(assetMediaUrl({image: 'javascript:alert(1)'})).toBeNull()
    expect(assetMediaUrl({image: 'http://example.org/a.png'})).toBeNull()
    expect(assetMediaUrl({image: 'ipfs://'})).toBeNull()
  })
})
