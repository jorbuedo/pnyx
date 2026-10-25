import {Effect, Exit} from 'effect'
import {describe, expect, it} from 'vitest'
import {buildBrandLink, buildTransferRequestCryptoLink, isBrandLink, parseBrandLink} from './brand-links.js'
import type {InvalidUriError} from './errors.js'
import {build, isCardanoUri, parse} from './parser.js'
import {ETHEREUM_MAINNET_USDC_TOKEN} from './transfer-normalization.js'
import type {CardanoUri} from './types.js'

describe('parse', () => {
  describe('claim URIs (CIP-99)', () => {
    // CIP-13 shows this authority once, as an example, and points at "a separate
    // CIP for that protocol" — CIP-99, Proof of Onboarding, which fixes this
    // grammar. The parser previously read `//claim/<faucet>/<code>`, a shape found
    // nowhere, which rejected the documented one.
    it('parses the shape CIP-99 documents', async () => {
      const result = await Effect.runPromise(
        parse('web+cardano://claim/v1?faucet_url=https%3A%2F%2Fclaim.hosky.io&code=consensus2023' as CardanoUri),
      )
      expect(result).toEqual({
        authority: 'claim',
        version: 'v1',
        faucetUrl: 'https://claim.hosky.io',
        code: 'consensus2023',
        params: {},
      })
    })

    // CIP-99: additional parameters "should be passed through to the provided
    // `faucet_url` without modification". Dropping them hands the faucet a claim it
    // cannot attribute.
    it("keeps the faucet's own query parameters", async () => {
      const result = await Effect.runPromise(
        parse(
          'web+cardano://claim/v1?faucet_url=https%3A%2F%2Fclaim.nftxlv.com&code=ABC123&invoice=123456&user_id=Adam1337' as CardanoUri,
        ),
      )
      expect(result).toMatchObject({
        code: 'ABC123',
        params: {invoice: '123456', user_id: 'Adam1337'},
      })
    })

    // The live Moneta tUSDM faucet's link, verbatim: a path-carrying faucet URL,
    // which the pre-CIP-99 path grammar could not express at all.
    it('parses a faucet URL that carries a path', async () => {
      const result = await Effect.runPromise(
        parse(
          'web+cardano://claim/v1?faucet_url=https%3A%2F%2Fbeta.onbd.io%2Fapi%2Fclaim%2Fv1%2F01ksj7qeeg0kbh5s64ds2x9yya&code=01KSJ8PW11CPCG40G7S7TVKXZ9' as CardanoUri,
        ),
      )
      expect(result).toMatchObject({
        faucetUrl: 'https://beta.onbd.io/api/claim/v1/01ksj7qeeg0kbh5s64ds2x9yya',
        code: '01KSJ8PW11CPCG40G7S7TVKXZ9',
      })
    })

    it('fails on a missing code', async () => {
      const exit = await Effect.runPromiseExit(
        parse('web+cardano://claim/v1?faucet_url=https%3A%2F%2Fclaim.hosky.io' as CardanoUri),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('fails without the version segment', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://claim/faucet123/code456' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    // Redeeming POSTs the user's receiving address, so cleartext is refused here
    // rather than at the screen: one place to remember it.
    it.each([
      ['http://claim.hosky.io', 'http'],
      ['javascript:alert(1)', 'javascript'],
      ['not a url', 'garbage'],
    ])('refuses a faucet_url that is not https (%s)', async (faucet) => {
      const exit = await Effect.runPromiseExit(
        parse(`web+cardano://claim/v1?faucet_url=${encodeURIComponent(faucet)}&code=abc` as CardanoUri),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe('browse URIs (CIP-0158)', () => {
    it('parses a v1 URI with percent-encoded https URL', async () => {
      const inner = 'https://app.example.com/route?x=1&y=2'
      const result = await Effect.runPromise(
        parse(`web+cardano://browse/v1?uri=${encodeURIComponent(inner)}` as CardanoUri),
      )
      expect(result).toEqual({
        authority: 'browse',
        version: 'v1',
        uri: inner,
      })
    })

    it('parses a v1 URI with http scheme', async () => {
      const result = await Effect.runPromise(
        parse(`web+cardano://browse/v1?uri=${encodeURIComponent('http://example.com/')}` as CardanoUri),
      )
      expect(result).toEqual({authority: 'browse', version: 'v1', uri: 'http://example.com/'})
    })

    it('defaults to https when the inner URI omits a scheme', async () => {
      const result = await Effect.runPromise(parse('web+cardano://browse/v1?uri=app.example.com' as CardanoUri))
      expect(result).toEqual({authority: 'browse', version: 'v1', uri: 'https://app.example.com/'})
    })

    it('fails when the version segment is missing', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://browse?uri=https%3A%2F%2Fa.com' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('fails on an unsupported version', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://browse/v9?uri=https%3A%2F%2Fa.com' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('fails when the `uri` query param is missing', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://browse/v1' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('rejects javascript: URLs', async () => {
      const exit = await Effect.runPromiseExit(
        parse(`web+cardano://browse/v1?uri=${encodeURIComponent('javascript:alert(1)')}` as CardanoUri),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('rejects file: URLs', async () => {
      const exit = await Effect.runPromiseExit(
        parse(`web+cardano://browse/v1?uri=${encodeURIComponent('file:///etc/passwd')}` as CardanoUri),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('rejects data: URLs', async () => {
      const exit = await Effect.runPromiseExit(
        parse(`web+cardano://browse/v1?uri=${encodeURIComponent('data:text/html,<script>')}` as CardanoUri),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe('pay URIs (CIP-13)', () => {
    it('parses pay URI with address only', async () => {
      const result = await Effect.runPromise(parse('web+cardano://pay?address=addr1test' as CardanoUri))
      expect(result).toEqual({
        authority: 'pay',
        address: 'addr1test',
        amount: undefined,
        message: undefined,
      })
    })

    it('parses pay URI with amount', async () => {
      const result = await Effect.runPromise(parse('web+cardano://pay?address=addr1test&amount=1000000' as CardanoUri))
      expect(result).toEqual({
        authority: 'pay',
        address: 'addr1test',
        amount: 1000000n,
        message: undefined,
      })
    })

    it('parses pay URI with all parameters', async () => {
      const result = await Effect.runPromise(
        parse('web+cardano://pay?address=addr1test&amount=5000000&message=Hello%20World' as CardanoUri),
      )
      expect(result).toEqual({
        authority: 'pay',
        address: 'addr1test',
        amount: 5000000n,
        message: 'Hello World',
      })
    })

    it('parses payment URI as alias for pay', async () => {
      const result = await Effect.runPromise(parse('web+cardano://payment?address=addr1test' as CardanoUri))
      expect(result).toEqual({
        authority: 'pay',
        address: 'addr1test',
        amount: undefined,
        message: undefined,
      })
    })

    it('fails on missing address', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://pay?amount=1000000' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('fails on invalid amount', async () => {
      const exit = await Effect.runPromiseExit(
        parse('web+cardano://pay?address=addr1test&amount=invalid' as CardanoUri),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('fails on negative amount', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://pay?address=addr1test&amount=-100' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe('stake URIs', () => {
    it('parses stake URI with pool ID in path', async () => {
      const result = await Effect.runPromise(parse('web+cardano://stake/pool1abc123' as CardanoUri))
      expect(result).toEqual({
        authority: 'stake',
        poolId: 'pool1abc123',
      })
    })

    it('parses stake URI with pool parameter', async () => {
      const result = await Effect.runPromise(parse('web+cardano://stake?pool=pool1xyz' as CardanoUri))
      expect(result).toEqual({
        authority: 'stake',
        poolId: 'pool1xyz',
      })
    })

    it('fails on missing pool ID', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://stake' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe('drep URIs', () => {
    it('parses drep URI with ID in path', async () => {
      const result = await Effect.runPromise(parse('web+cardano://drep/drep1abc' as CardanoUri))
      expect(result).toEqual({
        authority: 'drep',
        drepId: 'drep1abc',
      })
    })

    it('parses drep URI with id parameter', async () => {
      const result = await Effect.runPromise(parse('web+cardano://drep?id=drep1xyz' as CardanoUri))
      expect(result).toEqual({
        authority: 'drep',
        drepId: 'drep1xyz',
      })
    })
  })

  describe('transaction URIs', () => {
    it('parses transaction URI', async () => {
      const result = await Effect.runPromise(parse('web+cardano://transaction/txhash123' as CardanoUri))
      expect(result).toEqual({
        authority: 'transaction',
        hash: 'txhash123',
      })
    })

    it('fails on missing hash', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://transaction' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe('block URIs', () => {
    it('parses block URI', async () => {
      const result = await Effect.runPromise(parse('web+cardano://block/blockhash456' as CardanoUri))
      expect(result).toEqual({
        authority: 'block',
        hash: 'blockhash456',
      })
    })
  })

  describe('address URIs', () => {
    it('parses address URI', async () => {
      const result = await Effect.runPromise(parse('web+cardano://address/addr1abc' as CardanoUri))
      expect(result).toEqual({
        authority: 'address',
        address: 'addr1abc',
      })
    })
  })

  describe('connect URIs', () => {
    it('parses connect URI with params', async () => {
      const result = await Effect.runPromise(
        parse('web+cardano://connect?dappUrl=https://dapp.com&icon=logo.png' as CardanoUri),
      )
      expect(result).toEqual({
        authority: 'connect',
        params: {
          dappUrl: 'https://dapp.com',
          icon: 'logo.png',
        },
      })
    })

    it('parses connect URI without params', async () => {
      const result = await Effect.runPromise(parse('web+cardano://connect' as CardanoUri))
      expect(result).toEqual({
        authority: 'connect',
        params: {},
      })
    })
  })

  describe('backup URIs', () => {
    it('parses backup URI with encrypted envelope', async () => {
      const result = await Effect.runPromise(parse('web+cardano://backup?v=1&enc=base64data' as CardanoUri))
      expect(result).toEqual({
        authority: 'backup',
        enc: 'base64data',
        params: {
          v: '1',
        },
      })
    })

    it('fails on missing enc parameter', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://backup?v=1' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('rejects non-cardano protocols', async () => {
      const exit = await Effect.runPromiseExit(parse('web+other://pay?address=addr1test' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe('legacy-transfer URIs', () => {
    it('parses legacy-transfer URI', async () => {
      const result = await Effect.runPromise(
        parse('web+cardano://legacy-transfer?source=byron&target=shelley' as CardanoUri),
      )
      expect(result).toEqual({
        authority: 'legacy-transfer',
        params: {
          source: 'byron',
          target: 'shelley',
        },
      })
    })
  })

  describe('error handling', () => {
    it('fails on invalid URL format', async () => {
      const exit = await Effect.runPromiseExit(parse('not a valid url' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause as unknown as {_tag: string; error: InvalidUriError}
        expect(error.error?.reason).toContain('Invalid URL format')
      }
    })

    it('fails on non-cardano protocol', async () => {
      const exit = await Effect.runPromiseExit(parse('https://example.com' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })

    it('fails on unknown authority', async () => {
      const exit = await Effect.runPromiseExit(parse('web+cardano://unknown/path' as CardanoUri))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })
})

describe('build', () => {
  it('builds claim URI', () => {
    const uri = build({
      authority: 'claim',
      version: 'v1',
      faucetUrl: 'https://faucet.example',
      code: 'code1',
      params: {},
    })
    expect(uri).toBe('web+cardano://claim/v1?faucet_url=https%3A%2F%2Ffaucet.example&code=code1')
  })

  it('round-trips a claim URI with pass-through parameters', async () => {
    const uri = build({
      authority: 'claim',
      version: 'v1',
      faucetUrl: 'https://faucet.example',
      code: 'code1',
      params: {invoice: '99'},
    })
    expect(await Effect.runPromise(parse(uri))).toMatchObject({params: {invoice: '99'}})
  })

  it('builds pay URI with all params', () => {
    const uri = build({authority: 'pay', address: 'addr1test', amount: 1000000n, message: 'test'})
    expect(uri).toContain('web+cardano://pay?')
    expect(uri).toContain('address=addr1test')
    expect(uri).toContain('amount=1000000')
    expect(uri).toContain('message=test')
  })

  it('builds stake URI', () => {
    const uri = build({authority: 'stake', poolId: 'pool1abc'})
    expect(uri).toBe('web+cardano://stake/pool1abc')
  })

  it('builds drep URI', () => {
    const uri = build({authority: 'drep', drepId: 'drep1xyz'})
    expect(uri).toBe('web+cardano://drep/drep1xyz')
  })

  it('builds browse URI (CIP-0158)', () => {
    const uri = build({authority: 'browse', version: 'v1', uri: 'https://app.example.com/x?y=1'})
    expect(uri).toBe('web+cardano://browse/v1?uri=https%3A%2F%2Fapp.example.com%2Fx%3Fy%3D1')
  })

  it('builds transaction URI', () => {
    const uri = build({authority: 'transaction', hash: 'txhash'})
    expect(uri).toBe('web+cardano://transaction/txhash')
  })

  it('builds block URI', () => {
    const uri = build({authority: 'block', hash: 'blockhash'})
    expect(uri).toBe('web+cardano://block/blockhash')
  })

  it('builds address URI', () => {
    const uri = build({authority: 'address', address: 'addr1...'})
    expect(uri).toBe('web+cardano://address/addr1...')
  })

  it('builds connect URI', () => {
    const uri = build({authority: 'connect', params: {dappUrl: 'https://test.com'}})
    expect(uri).toContain('web+cardano://connect?')
    expect(uri).toContain('dappUrl=https')
  })

  it('builds backup URI', () => {
    const uri = build({authority: 'backup', enc: 'data', params: {v: '1'}})
    expect(uri).toContain('web+cardano://backup?')
    expect(uri).toContain('enc=data')
    expect(uri).toContain('v=1')
  })

  it('builds legacy-transfer URI', () => {
    const uri = build({authority: 'legacy-transfer', params: {key: 'value'}})
    expect(uri).toContain('web+cardano://legacy-transfer?')
    expect(uri).toContain('key=value')
  })
})

describe('isCardanoUri', () => {
  it('returns true for valid cardano URIs', () => {
    expect(isCardanoUri('web+cardano://pay?address=addr1')).toBe(true)
    expect(isCardanoUri('web+cardano://stake/pool1')).toBe(true)
    expect(isCardanoUri('web+cardano://connect')).toBe(true)
  })

  it('returns false for non-cardano URIs', () => {
    expect(isCardanoUri('https://example.com')).toBe(false)
    expect(isCardanoUri('bitcoin://address')).toBe(false)
    expect(isCardanoUri('cardano://pay?address=addr1')).toBe(false)
    expect(isCardanoUri('not a url')).toBe(false)
    expect(isCardanoUri('')).toBe(false)
  })
})

describe('round-trip', () => {
  it('parse and build produce equivalent URIs', async () => {
    const testCases = [
      'web+cardano://claim/v1?faucet_url=https%3A%2F%2Ffaucet.example&code=code1',
      'web+cardano://watch/v1?address=addr1test&name=Treasury',
      `web+cardano://browse/v1?uri=${encodeURIComponent('https://app.example.com/')}`,
      'web+cardano://stake/pool1abc',
      'web+cardano://drep/drep1xyz',
      'web+cardano://transaction/txhash',
      'web+cardano://block/blockhash',
      'web+cardano://address/addr1test',
    ] as CardanoUri[]

    for (const originalUri of testCases) {
      const parsed = await Effect.runPromise(parse(originalUri))
      const rebuilt = build(parsed)
      expect(rebuilt).toBe(originalUri)
    }
  })
})

describe('legacy CIP-13 (bare address)', () => {
  it('parses web+cardano:<address> as pay URI', async () => {
    const result = await Effect.runPromise(parse('web+cardano:addr1test' as CardanoUri))
    expect(result).toEqual({
      authority: 'pay',
      address: 'addr1test',
    })
  })

  it('parses web+cardano:<address>?amount=... as pay URI with amount', async () => {
    const result = await Effect.runPromise(parse('web+cardano:addr1test?amount=5000000' as CardanoUri))
    expect(result).toEqual({
      authority: 'pay',
      address: 'addr1test',
      amount: 5000000n,
    })
  })

  it('parses web+cardano:<address>?amount=...&memo=... with all params', async () => {
    const result = await Effect.runPromise(parse('web+cardano:addr1test?amount=1000000&message=Hello' as CardanoUri))
    expect(result).toEqual({
      authority: 'pay',
      address: 'addr1test',
      amount: 1000000n,
      message: 'Hello',
    })
  })

  it('detects legacy format with isCardanoUri', () => {
    expect(isCardanoUri('web+cardano:addr1test')).toBe(true)
    expect(isCardanoUri('web+cardano:addr1test?amount=1000000')).toBe(true)
  })
})

describe('brand links', () => {
  describe('isBrandLink', () => {
    it('detects pnyx:// links', () => {
      expect(isBrandLink('pnyx://pnyx.pxkq.uk/w1/transfer/request/ada?foo=bar', 'pnyx')).toBe(true)
    })

    it('detects https://pnyx.pxkq.uk/w1/ links', () => {
      expect(isBrandLink('https://pnyx.pxkq.uk/w1/browser/launch?dappUrl=x')).toBe(true)
    })

    it('does not detect unsupported brand web schemes', () => {
      expect(isBrandLink('web+pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=x', 'pnyx')).toBe(false)
    })

    it('returns false for unrelated links', () => {
      expect(isBrandLink('https://example.com')).toBe(false)
      expect(isBrandLink('web+cardano://pay?address=addr1')).toBe(false)
    })
  })

  describe('parseBrandLink', () => {
    it('parses transfer/request/ada', () => {
      const target = JSON.stringify({receiver: 'addr1abc', amounts: [{tokenId: '', quantity: '2000000'}]})
      const url = `pnyx://pnyx.pxkq.uk/w1/transfer/request/ada?targets[0]=${encodeURIComponent(target)}`
      const result = parseBrandLink(url, 'pnyx')
      expect(result).not.toBeNull()
      expect(result?.feature).toBe('transfer')
      expect(result?.useCase).toBe('request/ada')
      if (result?.useCase === 'request/ada') {
        expect(result.params.targets[0]?.receiver).toBe('addr1abc')
      }
    })

    it('parses transfer/request/ada-with-link', () => {
      const link = encodeURIComponent('web+cardano://pay?address=addr1test&amount=1000000')
      const url = `pnyx://pnyx.pxkq.uk/w1/transfer/request/ada-with-link?link=${link}`
      const result = parseBrandLink(url, 'pnyx')
      expect(result).not.toBeNull()
      expect(result?.feature).toBe('transfer')
      expect(result?.useCase).toBe('request/ada-with-link')
      if (result?.useCase === 'request/ada-with-link') {
        expect(result.params.link).toContain('web+cardano://pay')
      }
    })

    it('parses transfer/request/crypto', () => {
      const url =
        'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=eip155%3A1&asset=ETH&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=50000000000000000'
      const result = parseBrandLink(url, 'pnyx')
      expect(result).not.toBeNull()
      expect(result?.feature).toBe('transfer')
      expect(result?.useCase).toBe('request/crypto')
      if (result?.useCase === 'request/crypto') {
        expect(result.params.chain).toBe('eip155:1')
        expect(result.params.asset).toBe('ETH')
        expect(result.params.address).toBe('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')
        expect(result.params.amount).toBe('50000000000000000')
      }
    })

    it('rejects web+pnyx brand links because no handler is registered for that scheme', () => {
      const result = parseBrandLink(
        'web+pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=cardano%3Amainnet&asset=ADA&address=addr1abc&amount=1000000',
        'pnyx',
      )

      expect(result).toBeNull()
    })

    it('rejects transfer/request/crypto with a non-integer amount', () => {
      const result = parseBrandLink(
        'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=eip155%3A1&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=0.05',
        'pnyx',
      )
      expect(result).toBeNull()
    })

    it('parses exchange/order/show-create-result', () => {
      const url =
        'https://pnyx.pxkq.uk/w1/exchange/order/show-create-result?provider=acme&orderType=buy&coinAmount=100&coin=ADA'
      const result = parseBrandLink(url)
      expect(result).not.toBeNull()
      expect(result?.feature).toBe('exchange')
      expect(result?.useCase).toBe('order/show-create-result')
      if (result?.useCase === 'order/show-create-result') {
        expect(result.params.provider).toBe('acme')
        expect(result.params.orderType).toBe('buy')
        expect(result.params.coinAmount).toBe(100)
        expect(result.params.coin).toBe('ADA')
      }
    })

    it('parses browser/launch', () => {
      const dappUrl = encodeURIComponent('https://sundaeswap.finance')
      const url = `pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=${dappUrl}`
      const result = parseBrandLink(url, 'pnyx')
      expect(result).not.toBeNull()
      expect(result?.feature).toBe('browser')
      expect(result?.useCase).toBe('launch')
      if (result?.useCase === 'launch') {
        expect(result.params.dappUrl).toBe('https://sundaeswap.finance')
      }
    })

    it('returns null for unknown paths', () => {
      const result = parseBrandLink('pnyx://pnyx.pxkq.uk/w1/unknown/path', 'pnyx')
      expect(result).toBeNull()
    })

    it('does not parse an app-internal path as a brand link', () => {
      expect(parseBrandLink('pnyx://internal/some/path?success=true', 'pnyx')).toBeNull()
    })

    it('returns null for missing required params', () => {
      const result = parseBrandLink('pnyx://pnyx.pxkq.uk/w1/browser/launch', 'pnyx')
      expect(result).toBeNull()
    })

    it('parses partner info params', () => {
      const url =
        'https://pnyx.pxkq.uk/w1/exchange/order/show-create-result?provider=test&orderType=sell&appId=myapp&message=hello'
      const result = parseBrandLink(url)
      expect(result).not.toBeNull()
      if (result?.useCase === 'order/show-create-result') {
        expect(result.params.appId).toBe('myapp')
        expect(result.params.message).toBe('hello')
      }
    })
  })

  describe('buildBrandLink', () => {
    it('builds browser/launch link', () => {
      const url = buildBrandLink({feature: 'browser', useCase: 'launch', params: {dappUrl: 'https://app.com'}}, 'pnyx')
      expect(url).toContain('pnyx://pnyx.pxkq.uk/w1/browser/launch')
      expect(url).toContain('dappUrl=')
    })

    it('builds exchange result link with https', () => {
      const url = buildBrandLink(
        {
          feature: 'exchange',
          useCase: 'order/show-create-result',
          params: {provider: 'acme', orderType: 'buy'},
        },
        'https',
      )
      expect(url).toContain('https://pnyx.pxkq.uk/w1/exchange/order/show-create-result')
      expect(url).toContain('provider=acme')
      expect(url).toContain('orderType=buy')
    })

    it('builds transfer/request/crypto links with partner metadata', () => {
      const url = buildTransferRequestCryptoLink({
        client: 'encryptus',
        chain: 'ETHEREUM',
        name: 'USDC',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        amount: '5050000',
        callbackPlatform: 'app',
        sourceWalletGroupId: 'wallet-group-1',
        sourceWalletAccountIndex: '2',
      })

      expect(url).toContain('pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto')
      expect(url).toContain('client=encryptus')
      expect(url).toContain('callbackPlatform=app')
      expect(url).toContain('sourceWalletGroupId=wallet-group-1')
      expect(url).toContain('sourceWalletAccountIndex=2')
      expect(url).toContain('chain=eip155%3A1')
      expect(url).toContain('asset=USDC')
      expect(url).toContain('amount=5050000')
      expect(url).toContain(`token=${ETHEREUM_MAINNET_USDC_TOKEN}`)
    })

    it('builds pnyx transfer/request/crypto link', () => {
      const redirectTo =
        'https://hub.encryptus.co/pw/?orderType=sell&returnUrl=pnyx%253A%252F%252Fpnyx.pxkq.uk%252Fw1%252Ftransfer%252Frequest%252Fcrypto%253Fchain%253Deip155%25253A1&x=a%20b'
      const url = buildTransferRequestCryptoLink({
        chain: 'cardano:mainnet',
        asset: 'ADA',
        address: 'addr1abc',
        amount: '25000000',
        redirectTo,
      })
      expect(url).toContain('pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto')
      expect(url).toContain('chain=cardano%3Amainnet')
      expect(url).toContain('asset=ADA')
      expect(url).toContain('amount=25000000')
      expect(url).toContain('redirectTo=https%3A%2F%2Fhub.encryptus.co%2Fpw%2F%3ForderType%3Dsell')

      const parsed = parseBrandLink(url, 'pnyx')
      expect(parsed?.useCase).toBe('request/crypto')
      if (parsed?.useCase === 'request/crypto') {
        expect(parsed.params.redirectTo).toBe(redirectTo)
      }
    })

    it('normalizes Encryptus ADA labels when building transfer/request/crypto links', () => {
      const url = buildTransferRequestCryptoLink({
        client: 'encryptus',
        chain: 'CARDANO',
        name: 'ADA',
        address: 'addr1abc',
        amount: '5050000',
      })

      expect(url).toContain('client=encryptus')
      expect(url).toContain('chain=cardano%3Amainnet')
      expect(url).toContain('asset=ADA')
      expect(url).toContain('amount=5050000')
      expect(url).not.toContain('token=')
      expect(url).not.toContain('name=')
    })

    it('normalizes Encryptus Ethereum USDC labels when building transfer/request/crypto links', () => {
      const url = buildTransferRequestCryptoLink({
        client: 'encryptus',
        chain: 'ETHEREUM',
        name: 'USDC',
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        amount: '5050000',
      })

      expect(url).toContain('client=encryptus')
      expect(url).toContain('chain=eip155%3A1')
      expect(url).toContain('asset=USDC')
      expect(url).toContain('amount=5050000')
      expect(url).toContain(`token=${ETHEREUM_MAINNET_USDC_TOKEN}`)
      expect(url).not.toContain('name=')
    })

    it('normalizes raw Encryptus transfer/request/crypto links while parsing', () => {
      const url =
        'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?client=encryptus&callbackPlatform=app&sourceWalletGroupId=wallet-group-1&sourceWalletAccountIndex=2&chain=ETHEREUM&name=USDC&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=5050000'

      const parsed = parseBrandLink(url, 'pnyx')

      expect(parsed?.useCase).toBe('request/crypto')
      if (parsed?.useCase === 'request/crypto') {
        expect(parsed.params.client).toBe('encryptus')
        expect(parsed.params.callbackPlatform).toBe('app')
        expect(parsed.params.sourceWalletGroupId).toBe('wallet-group-1')
        expect(parsed.params.sourceWalletAccountIndex).toBe('2')
        expect(parsed.params.chain).toBe('eip155:1')
        expect(parsed.params.asset).toBe('USDC')
        expect(parsed.params.amount).toBe('5050000')
        expect(parsed.params.token).toBe(ETHEREUM_MAINNET_USDC_TOKEN)
        expect(parsed.params.name).toBe('USDC')
      }
    })

    it('rejects decimal Encryptus callback amounts because callbacks use base units', () => {
      const parsed = parseBrandLink(
        'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?client=encryptus&chain=ETHEREUM&name=USDC&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=5.05',
        'pnyx',
      )

      expect(parsed).toBeNull()
    })

    it('normalizes Encryptus ETH labels while preserving wei callback amounts', () => {
      const url =
        'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?client=encryptus&chain=ETH&name=ETH&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&amount=50000000000000000'

      const parsed = parseBrandLink(url, 'pnyx')

      expect(parsed?.useCase).toBe('request/crypto')
      if (parsed?.useCase === 'request/crypto') {
        expect(parsed.params.chain).toBe('eip155:1')
        expect(parsed.params.asset).toBe('ETH')
        expect(parsed.params.amount).toBe('50000000000000000')
      }
    })

    it('parses legacy pre-encoded redirectTo without decoding nested callback params', () => {
      const redirectTo =
        'https://hub.encryptus.co/pw/?orderType=sell&returnUrl=pnyx%253A%252F%252Fpnyx.pxkq.uk%252Fw1%252Ftransfer%252Frequest%252Fcrypto%253Fchain%253Deip155%25253A1&x=a%20b'
      const legacyUrl = `pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=eip155%3A1&address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e&redirectTo=${encodeURIComponent(
        encodeURIComponent(redirectTo),
      )}`

      const parsed = parseBrandLink(legacyUrl, 'pnyx')

      expect(parsed?.useCase).toBe('request/crypto')
      if (parsed?.useCase === 'request/crypto') {
        expect(parsed.params.redirectTo).toBe(redirectTo)
      }
    })
  })
})

describe('multisig links', () => {
  const KEY = `acct_shared_xvk1${'q'.repeat(100)}`

  it('round-trips a co-signer key, which carries only the key', () => {
    const action = {feature: 'multisig', useCase: 'cosigner-key', params: {key: KEY}} as const
    const url = buildBrandLink(action, 'pnyx')
    expect([...new URL(url).searchParams.keys()]).toEqual(['key'])
    expect(parseBrandLink(url, 'pnyx')).toEqual(action)
  })

  it('still reads a name and account index from an older build, without requiring them', () => {
    // Those fields are gone from what we send. Refusing to parse them would make a
    // key answered from a phone that has not updated unreadable.
    const legacy = `pnyx://pnyx.pxkq.uk/w1/multisig/cosigner-key?key=${KEY}&name=Bob&accountIndex=3`
    expect(parseBrandLink(legacy, 'pnyx')).toEqual({
      feature: 'multisig',
      useCase: 'cosigner-key',
      params: {key: KEY, name: 'Bob', accountIndex: 3},
    })
  })

  it('rejects a co-signer key with no key at all', () => {
    expect(parseBrandLink('pnyx://pnyx.pxkq.uk/w1/multisig/cosigner-key', 'pnyx')).toBeNull()
    expect(parseBrandLink('pnyx://pnyx.pxkq.uk/w1/multisig/cosigner-key?key=', 'pnyx')).toBeNull()
  })

  it('round-trips an invite, which carries nothing', () => {
    const action = {feature: 'multisig', useCase: 'invite', params: {}} as const
    const url = buildBrandLink(action, 'pnyx')
    expect([...new URL(url).searchParams.keys()]).toEqual([])
    expect(parseBrandLink(url, 'pnyx')).toEqual(action)
  })

  it('reads an older invite, ignoring the wallet name, sender and correlation id it carried', () => {
    const legacy = 'pnyx://pnyx.pxkq.uk/w1/multisig/invite?walletName=T&fromName=A&inviteId=x'
    expect(parseBrandLink(legacy, 'pnyx')).toEqual({feature: 'multisig', useCase: 'invite', params: {}})
  })

  it('round-trips a shared-wallet definition, treating the payload as opaque', () => {
    const def = 'eyJ2IjoxfQ'
    const link = buildBrandLink({feature: 'multisig', useCase: 'wallet', params: {def}}, 'pnyx')
    expect(link).toContain('/multisig/wallet?')
    expect(parseBrandLink(link, 'pnyx')).toEqual({feature: 'multisig', useCase: 'wallet', params: {def}})
  })

  it('rejects a definition link with no payload', () => {
    expect(parseBrandLink('pnyx://pnyx.pxkq.uk/w1/multisig/wallet', 'pnyx')).toBeNull()
    expect(parseBrandLink('pnyx://pnyx.pxkq.uk/w1/multisig/wallet?def=', 'pnyx')).toBeNull()
  })
})

describe('dm invite links', () => {
  const PERMIT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJtbl9hZGRyMWFsaWNlIn0.sig-with_base64url-chars'

  it('round-trips a permit through build and parse', () => {
    const link = buildBrandLink({feature: 'dm', useCase: 'invite', params: {permit: PERMIT}}, 'https')
    const parsed = parseBrandLink(link, 'pnyx')
    expect(parsed).toEqual({feature: 'dm', useCase: 'invite', params: {permit: PERMIT}})
  })

  // ⚠️ `invite` is a use case two features share, and the builder switches on the use case. Before
  // the feature check was added, a DM invite was encoded with the multisig arm's params.
  it('does not encode a dm invite with the multisig invite’s params', () => {
    const link = buildBrandLink({feature: 'dm', useCase: 'invite', params: {permit: PERMIT}}, 'https')
    expect(link).toContain('/dm/invite')
    expect(link).toContain('permit=')
    for (const foreign of ['walletName', 'fromName', 'inviteId']) expect(link).not.toContain(foreign)
  })

  it('still round-trips a multisig invite, which shares the use case', () => {
    // The multisig arm carries no params, so this is the case the feature check
    // must keep apart from a DM invite's permit rather than a difference in shape.
    const link = buildBrandLink({feature: 'multisig', useCase: 'invite', params: {}}, 'https')
    expect(link).toContain('/multisig/invite')
    expect(link).not.toContain('permit=')
    expect(parseBrandLink(link, 'pnyx')).toEqual({feature: 'multisig', useCase: 'invite', params: {}})
  })

  it('refuses a dm invite with no permit', () => {
    expect(parseBrandLink('https://pnyx.pxkq.uk/w1/dm/invite', 'pnyx')).toBeNull()
  })
})
