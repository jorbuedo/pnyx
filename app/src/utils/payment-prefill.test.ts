import {describe, expect, it} from 'vitest'
import {paymentPrefillFor} from './payment-prefill'

const ADDRESS =
  'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

describe('paymentPrefillFor', () => {
  it('carries the recipient and amount into the send flow', () => {
    expect(paymentPrefillFor(ADDRESS, 5_000_000n)).toEqual({
      addressBech32: ADDRESS,
      lovelace: 5_000_000n,
      origin: 'scan',
    })
  })

  it('carries an open request through with no amount', () => {
    expect(paymentPrefillFor(ADDRESS, null)?.lovelace).toBeNull()
  })

  it('reads a zero amount as open, not as a send of nothing', () => {
    expect(paymentPrefillFor(ADDRESS, 0n)?.lovelace).toBeNull()
  })

  it('reads a negative amount as open rather than prefilling nonsense', () => {
    // The CIP-13 parser already rejects these, so this is the belt to that
    // braces: a negative amount must never reach the amount step as a figure.
    expect(paymentPrefillFor(ADDRESS, -5n)?.lovelace).toBeNull()
  })

  it('keeps an amount past 2^53 exact', () => {
    expect(paymentPrefillFor(ADDRESS, 9_007_199_254_740_993n)?.lovelace).toBe(9_007_199_254_740_993n)
  })

  it('refuses a request with no address to pay', () => {
    expect(paymentPrefillFor('   ', 1n)).toBeNull()
  })

  it('trims the address, since a URI in a message arrives with whitespace', () => {
    expect(paymentPrefillFor(`  ${ADDRESS}  `, 1n)?.addressBech32).toBe(ADDRESS)
  })

  it('records where the request came from', () => {
    expect(paymentPrefillFor(ADDRESS, 1n, 'link')?.origin).toBe('link')
  })

  it('does not check the network, which the send screen owns', () => {
    // A mainnet address while on preprod still prefills; `resolveRecipient` is what
    // rejects it, and it says "wrong network" rather than "invalid address". A
    // second check here would be a weaker duplicate — a bech32 prefix cannot tell
    // preprod from preview.
    const mainnet = 'addr1qyfsgmjv6ckmwqp9c56sqzhfw2dlfvsnymzdd20wsue03k9wcrkj4yuwy84ekuwqu9m38trgujtggjfc54fulv3tkcpq'
    expect(paymentPrefillFor(mainnet, 1n)?.addressBech32).toBe(mainnet)
  })
})
