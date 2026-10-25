import {describe, expect, it} from 'vitest'

import {MAX_LINK_BYTES, parseQrContent} from './qr-parser'

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build an pnyx:// brand link URL from a versioned path and query string. */
const pnyxUrl = (path: string, query: string) => `pnyx://pnyx.pxkq.uk/w1/${path}?${query}`

/** Build a https://pnyx.pxkq.uk brand link URL. */
const httpsUrl = (path: string, query: string) => `https://pnyx.pxkq.uk/w1/${path}?${query}`

// ── Cardano addresses ─────────────────────────────────────────────────────────

describe('parseQrContent', () => {
  describe('Cardano addresses', () => {
    it('detects a mainnet address', () => {
      const result = parseQrContent(
        'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjc8',
      )
      expect(result).toEqual({
        type: 'address',
        address:
          'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjc8',
        network: 'mainnet',
      })
    })

    it('detects a testnet address', () => {
      const result = parseQrContent('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz37')
      expect(result).toEqual({
        type: 'address',
        address: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz37',
        network: 'testnet',
      })
    })

    it('trims surrounding whitespace before matching', () => {
      const result = parseQrContent('  addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxg  ')
      expect(result.type).toBe('address')
      if (result.type === 'address') {
        expect(result.address).toBe('addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxg')
      }
    })

    it('is case-insensitive for the addr1 prefix (bech32 is case-insensitive)', () => {
      const result = parseQrContent('ADDR1QX2FXV2UMYHTTKXYXP8X0DLPDT3K6CWNG5PXJ3JHSYDZER')
      expect(result.type).toBe('address')
      if (result.type === 'address') {
        expect(result.network).toBe('mainnet')
      }
    })

    it('returns unknown for addr1 prefix with invalid bech32 characters', () => {
      const result = parseQrContent('addr1qx2fxv2!invalid@chars')
      expect(result.type).toBe('unknown')
    })

    it('returns unknown for bare "addr1" with no data part', () => {
      const result = parseQrContent('addr1')
      expect(result.type).toBe('unknown')
    })
  })

  // ── Cardano URIs ─────────────────────────────────────────────────────────────

  describe('Cardano URIs — pay authority', () => {
    it('detects pay URI', () => {
      const result = parseQrContent('web+cardano://pay?address=addr1qx2fxv2u&amount=1000000')
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri') {
        expect(result.parsed.authority).toBe('pay')
      }
    })

    it('parses address and amount from pay URI', () => {
      const result = parseQrContent('web+cardano://pay?address=addr1qx2fxv2u&amount=1000000')
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri' && result.parsed.authority === 'pay') {
        expect(result.parsed.address).toBe('addr1qx2fxv2u')
        expect(result.parsed.amount).toBe(1000000n)
      }
    })

    it('parses pay URI without an amount', () => {
      const result = parseQrContent('web+cardano://pay?address=addr1qx2fxv2u')
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri' && result.parsed.authority === 'pay') {
        expect(result.parsed.address).toBe('addr1qx2fxv2u')
        expect(result.parsed.amount).toBeUndefined()
      }
    })
  })

  describe('Cardano URIs — stake authority', () => {
    it('detects stake URI', () => {
      const result = parseQrContent('web+cardano://stake/pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy')
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri') {
        expect(result.parsed.authority).toBe('stake')
      }
    })

    it('extracts the pool ID from stake URI', () => {
      const poolId = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy'
      const result = parseQrContent(`web+cardano://stake/${poolId}`)
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri' && result.parsed.authority === 'stake') {
        expect(result.parsed.poolId).toBe(poolId)
      }
    })
  })

  // ── Legacy CIP-13 ─────────────────────────────────────────────────────────────

  describe('Legacy CIP-13 (bare address)', () => {
    it('parses web+cardano:<address> as a pay URI', () => {
      const result = parseQrContent('web+cardano:addr1test')
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri') {
        expect(result.parsed.authority).toBe('pay')
      }
    })

    it('parses web+cardano:<address>?amount=... as pay URI with bigint amount', () => {
      const result = parseQrContent('web+cardano:addr1test?amount=5000000')
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri' && result.parsed.authority === 'pay') {
        expect(result.parsed.amount).toBe(5000000n)
      }
    })
  })

  // ── Brand links ────────────────────────────────────────────────────────────────

  describe('Brand links — request/ada', () => {
    const target = {receiver: 'addr1qtest', amounts: [{tokenId: '', quantity: '2000000'}]}

    it('detects request/ada and returns correct feature/useCase', () => {
      const url = pnyxUrl('transfer/request/ada', `targets[0]=${encodeURIComponent(JSON.stringify(target))}`)
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink') {
        expect(result.action.feature).toBe('transfer')
        expect(result.action.useCase).toBe('request/ada')
      }
    })

    it('parses receiver and amounts from targets', () => {
      const url = pnyxUrl('transfer/request/ada', `targets[0]=${encodeURIComponent(JSON.stringify(target))}`)
      const result = parseQrContent(url, 'pnyx')
      if (result.type === 'brandLink' && result.action.useCase === 'request/ada') {
        expect(result.action.params.targets[0]?.receiver).toBe('addr1qtest')
        expect(result.action.params.targets[0]?.amounts[0]?.quantity).toBe('2000000')
        expect(result.action.params.targets[0]?.amounts[0]?.tokenId).toBe('')
      }
    })

    it('parses optional memo param', () => {
      const url = pnyxUrl(
        'transfer/request/ada',
        `targets[0]=${encodeURIComponent(JSON.stringify(target))}&memo=pay+for+coffee`,
      )
      const result = parseQrContent(url, 'pnyx')
      if (result.type === 'brandLink' && result.action.useCase === 'request/ada') {
        expect(result.action.params.memo).toBe('pay for coffee')
      }
    })

    it('parses isSandbox flag as boolean', () => {
      const url = pnyxUrl(
        'transfer/request/ada',
        `targets[0]=${encodeURIComponent(JSON.stringify(target))}&isSandbox=true`,
      )
      const result = parseQrContent(url, 'pnyx')
      if (result.type === 'brandLink' && result.action.useCase === 'request/ada') {
        expect(result.action.params.isSandbox).toBe(true)
      }
    })
  })

  describe('Brand links — request/ada-with-link', () => {
    it('detects ada-with-link and returns correct useCase', () => {
      const link = encodeURIComponent('web+cardano://pay?address=addr1qx2fxv2u&amount=1000000')
      const url = pnyxUrl('transfer/request/ada-with-link', `link=${link}`)
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink') {
        expect(result.action.useCase).toBe('request/ada-with-link')
      }
    })

    it('extracts decoded link and redirectTo', () => {
      const link = encodeURIComponent('web+cardano://pay?address=addr1qx2fxv2u&amount=1000000')
      const redirectTo = encodeURIComponent('https://encryptus.io/callback')
      const url = pnyxUrl('transfer/request/ada-with-link', `link=${link}&redirectTo=${redirectTo}`)
      const result = parseQrContent(url, 'pnyx')
      if (result.type === 'brandLink' && result.action.useCase === 'request/ada-with-link') {
        expect(result.action.params.link).toBe('web+cardano://pay?address=addr1qx2fxv2u&amount=1000000')
        expect(result.action.params.redirectTo).toBe('https://encryptus.io/callback')
      }
    })
  })

  describe('Brand links — browser/launch', () => {
    it('detects launch and extracts decoded dappUrl', () => {
      const dappUrl = encodeURIComponent('https://sundaeswap.finance')
      const url = pnyxUrl('browser/launch', `dappUrl=${dappUrl}`)
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink' && result.action.useCase === 'launch') {
        expect(result.action.feature).toBe('browser')
        expect(result.action.params.dappUrl).toBe('https://sundaeswap.finance')
      }
    })
  })

  describe('Brand links — order/show-create-result', () => {
    it('detects order result and extracts provider and orderType', () => {
      const url = pnyxUrl('exchange/order/show-create-result', 'provider=acme&orderType=buy')
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink' && result.action.useCase === 'order/show-create-result') {
        expect(result.action.feature).toBe('exchange')
        expect(result.action.params.provider).toBe('acme')
        expect(result.action.params.orderType).toBe('buy')
      }
    })
  })

  describe('Brand links — HTTPS fallback', () => {
    it('detects https://pnyx.pxkq.uk as a brand link', () => {
      const dappUrl = encodeURIComponent('https://sundaeswap.finance')
      const url = httpsUrl('browser/launch', `dappUrl=${dappUrl}`)
      const result = parseQrContent(url)
      expect(result.type).toBe('brandLink')
    })

    it('does not treat a plain https URL on a different host as a brand link', () => {
      const result = parseQrContent('https://example.com/dapp')
      expect(result.type).toBe('url')
    })
  })

  describe('Brand links — pnyx:// scheme', () => {
    it('detects pnyx:// link when brandScheme is pnyx', () => {
      const dappUrl = encodeURIComponent('https://sundaeswap.finance')
      const url = pnyxUrl('browser/launch', `dappUrl=${dappUrl}`)
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink' && result.action.useCase === 'launch') {
        expect(result.action.params.dappUrl).toBe('https://sundaeswap.finance')
      }
    })

    it('parses chain-aware crypto transfer requests', () => {
      const url = pnyxUrl(
        'transfer/request/crypto',
        'chain=eip155%3A1&asset=ETH&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=50000000000000000',
      )
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink' && result.action.useCase === 'request/crypto') {
        expect(result.action.params.chain).toBe('eip155:1')
        expect(result.action.params.asset).toBe('ETH')
        expect(result.action.params.address).toBe('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')
        expect(result.action.params.amount).toBe('50000000000000000')
      }
    })

    it('parses partner crypto transfer requests with wallet-restore metadata', () => {
      const url = pnyxUrl(
        'transfer/request/crypto',
        'client=encryptus&sourceWalletGroupId=wallet-group-1&sourceWalletAccountIndex=2&chain=ETHEREUM&name=USDC&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=5050000',
      )
      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink' && result.action.useCase === 'request/crypto') {
        expect(result.action.params.chain).toBe('eip155:1')
        expect(result.action.params.asset).toBe('USDC')
        expect(result.action.params.amount).toBe('5050000')
        expect(result.action.params.token).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
        expect(result.action.params.sourceWalletGroupId).toBe('wallet-group-1')
        expect(result.action.params.sourceWalletAccountIndex).toBe('2')
      }
    })

    it('accepts long Encryptus-style crypto requests with nested redirect state', () => {
      const token = 't'.repeat(2300)
      const redirectTo = `https://hub.encryptus.co/pw/?orderType=sell&access_token=${token}`
      const url = pnyxUrl(
        'transfer/request/crypto',
        `chain=eip155%3A1&asset=ETH&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=50000000000000000&redirectTo=${encodeURIComponent(
          redirectTo,
        )}`,
      )

      expect(url.length).toBeGreaterThan(2048)
      expect(url.length).toBeLessThanOrEqual(MAX_LINK_BYTES)

      const result = parseQrContent(url, 'pnyx')
      expect(result.type).toBe('brandLink')
      if (result.type === 'brandLink' && result.action.useCase === 'request/crypto') {
        expect(result.action.params.redirectTo).toBe(redirectTo)
      }
    })
  })

  // ── Known-scheme fallback ─────────────────────────────────────────────────────

  describe('App-scheme fallback (pnyx)', () => {
    it('handles pnyx:// link when no brandScheme is provided', () => {
      const target = {receiver: 'addr1abc', amounts: [{tokenId: '', quantity: '2000000'}]}
      const url = pnyxUrl('transfer/request/ada', `targets[0]=${encodeURIComponent(JSON.stringify(target))}`)
      const result = parseQrContent(url)
      expect(result.type).toBe('brandLink')
    })

    it('handles pnyx:// link when brandScheme is an unknown scheme', () => {
      const dappUrl = encodeURIComponent('https://sundaeswap.finance')
      const url = pnyxUrl('browser/launch', `dappUrl=${dappUrl}`)
      const result = parseQrContent(url, 'otherwallet')
      expect(result.type).toBe('brandLink')
    })

    it('returns unknown when the authority is not a brand link authority (wrong host rejected)', () => {
      // parseBrandLink enforces a known brand-link hostname even for known schemes.
      const dappUrl = encodeURIComponent('https://sundaeswap.finance')
      const result = parseQrContent(`pnyx://evil-host.com/w1/browser/launch?dappUrl=${dappUrl}`, 'otherwallet')
      expect(result.type).toBe('unknown')
    })
  })

  // ── Size guard ────────────────────────────────────────────────────────────────

  describe('Size guard', () => {
    it('returns unknown (empty raw) for content exceeding the link size limit', () => {
      const oversized = 'a'.repeat(MAX_LINK_BYTES + 1)
      expect(parseQrContent(oversized)).toEqual({type: 'unknown', raw: ''})
    })

    it('accepts content at exactly the link size limit', () => {
      const atLimit = 'a'.repeat(MAX_LINK_BYTES)
      const result = parseQrContent(atLimit)
      expect(result.type).toBe('unknown')
      if (result.type === 'unknown') {
        expect(result.raw).toBe(atLimit)
      }
    })

    it('accepts a valid URL at the link size limit', () => {
      const prefix = 'https://example.com/'
      const url = `${prefix}${'a'.repeat(MAX_LINK_BYTES - prefix.length)}`
      expect(url.length).toBe(MAX_LINK_BYTES)
      const result = parseQrContent(url)
      expect(result).toEqual({type: 'url', url})
    })
  })

  // ── Percent-encoded input (safeDecodeUri) ─────────────────────────────────────

  describe('Percent-encoded input (safeDecodeUri)', () => {
    it('decodes a percent-encoded Cardano URI from a QR code', () => {
      // Some QR generators percent-encode the full URL
      const encoded = encodeURIComponent('web+cardano://pay?address=addr1qx2fxv2u&amount=1000000')
      const result = parseQrContent(encoded)
      expect(result.type).toBe('cardanoUri')
      if (result.type === 'cardanoUri' && result.parsed.authority === 'pay') {
        expect(result.parsed.address).toBe('addr1qx2fxv2u')
        expect(result.parsed.amount).toBe(1000000n)
      }
    })

    it('returns decoded text as raw for unrecognised percent-encoded content', () => {
      expect(parseQrContent('hello%20world')).toEqual({type: 'unknown', raw: 'hello world'})
    })

    it('does not throw on malformed percent sequences', () => {
      expect(() => parseQrContent('%GG%ZZ')).not.toThrow()
      expect(parseQrContent('%GG%ZZ').type).toBe('unknown')
    })

    it('preserves original percent-encoding for URL results (browser normalises on load)', () => {
      const url = 'https://example.com/path?q=hello%20world'
      const result = parseQrContent(url)
      expect(result).toEqual({type: 'url', url})
    })
  })

  // ── URLs ──────────────────────────────────────────────────────────────────────

  describe('URLs', () => {
    it('detects an https URL', () => {
      expect(parseQrContent('https://example.com/dapp')).toEqual({
        type: 'url',
        url: 'https://example.com/dapp',
      })
    })

    it('detects an http URL', () => {
      expect(parseQrContent('http://example.com')).toEqual({
        type: 'url',
        url: 'http://example.com',
      })
    })

    it('is case-insensitive for the https:// scheme', () => {
      const result = parseQrContent('HTTPS://example.com')
      expect(result).toEqual({type: 'url', url: 'HTTPS://example.com'})
    })

    it('preserves query params including percent-encoding', () => {
      const url = 'https://example.com/dapp?token=abc%2Fdef&amount=100'
      expect(parseQrContent(url)).toEqual({type: 'url', url})
    })
  })

  // ── Unknown content ───────────────────────────────────────────────────────────

  describe('Unknown content', () => {
    it('returns unknown for random text', () => {
      expect(parseQrContent('some random text')).toEqual({type: 'unknown', raw: 'some random text'})
    })

    it('returns unknown for an empty string', () => {
      expect(parseQrContent('')).toEqual({type: 'unknown', raw: ''})
    })

    it('returns unknown for whitespace-only input (trimmed to empty)', () => {
      expect(parseQrContent('   ')).toEqual({type: 'unknown', raw: ''})
    })

    it('returns unknown for unsupported URI schemes (e.g. ftp://)', () => {
      expect(parseQrContent('ftp://example.com/file')).toEqual({
        type: 'unknown',
        raw: 'ftp://example.com/file',
      })
    })

    it('returns unknown for addr1 prefix with non-bech32 trailing characters', () => {
      expect(parseQrContent('addr1qx2fxv2!invalid')).toEqual({
        type: 'unknown',
        raw: 'addr1qx2fxv2!invalid',
      })
    })
  })
})

// ── Pnyx identities ───────────────────────────────────────────────────────────

describe('pnyx_id', () => {
  // A real 32-byte identity through `encodePnyxId`, so the checksum is genuine rather than plausible.
  const PNYX_ID = 'pnyx_id1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hwqk8jmw3'

  it('detects the bare id this app puts in its own ID-screen QR', () => {
    expect(parseQrContent(PNYX_ID)).toEqual({type: 'pnyxId', pnyxId: PNYX_ID})
  })

  it('accepts the all-upper form an encoder may emit, and returns the canonical spelling', () => {
    // bech32m is case-insensitive and upper case packs denser in a QR, so this is the same identity.
    expect(parseQrContent(PNYX_ID.toUpperCase())).toEqual({type: 'pnyxId', pnyxId: PNYX_ID})
  })

  it('refuses an id whose checksum does not hold', () => {
    // One character of payload changed: still id-shaped, no longer that identity — and treating it as
    // one would send a lookup after somebody else and report them "not registered".
    const damaged = `${PNYX_ID.slice(0, -8)}z${PNYX_ID.slice(-7)}`
    expect(parseQrContent(damaged).type).toBe('unknown')
  })

  it('refuses a foreign bech32 payload wearing the right shape', () => {
    expect(parseQrContent('pnyx_id1notavalididentityatall').type).toBe('unknown')
  })
})
