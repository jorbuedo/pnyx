import {describe, expect, it} from 'vitest'
import {addressNetworkFamily, networkFitFor} from './address-network'

const MAINNET = 'addr1qyfsgmjv6ckmwqp9c56sqzhfw2dlfvsnymzdd20wsue03k9wcrkj4yuwy84ekuwqu9m38trgujtggjfc54fulv3tkcpq'
const TESTNET =
  'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

describe('addressNetworkFamily', () => {
  it('reads the family out of the bech32 prefix', () => {
    expect(addressNetworkFamily(MAINNET)).toBe('mainnet')
    expect(addressNetworkFamily(TESTNET)).toBe('testnet')
  })

  it('checks addr_test before addr, since one is a prefix of the other', () => {
    // Ordering this the other way makes every testnet address read as mainnet —
    // and the consequence is a switch to the wrong network, silently.
    expect(addressNetworkFamily('addr_test1abc')).toBe('testnet')
  })

  it('tolerates surrounding whitespace and case, which a pasted URI carries', () => {
    expect(addressNetworkFamily(`  ${TESTNET.toUpperCase()}  `)).toBe('testnet')
  })

  it('is null for anything that is not a Cardano address', () => {
    for (const value of ['', 'stake1abc', '0xabc', 'pool1abc', 'bc1qxy']) {
      expect(addressNetworkFamily(value)).toBeNull()
    }
  })
})

describe('networkFitFor', () => {
  it('is ok when the address belongs to the family we are on', () => {
    expect(networkFitFor(TESTNET, 'preprod')).toEqual({kind: 'ok'})
    expect(networkFitFor(TESTNET, 'preview')).toEqual({kind: 'ok'})
    expect(networkFitFor(MAINNET, 'mainnet')).toEqual({kind: 'ok'})
  })

  it('offers a switch rather than a refusal', () => {
    // A mainnet request while on preprod is nobody's mistake; "wrong network" with
    // no way forward sends the user into settings for something already known.
    expect(networkFitFor(MAINNET, 'preprod')).toEqual({kind: 'switch', switchTo: 'mainnet', from: 'preprod'})
  })

  it('suggests preprod for a testnet address, and names it so the guess is visible', () => {
    // An address cannot say preprod from preview. Preprod is what this app's rails
    // and faucet are set up for, and the copy shows the target before switching.
    expect(networkFitFor(TESTNET, 'mainnet')).toEqual({kind: 'switch', switchTo: 'preprod', from: 'mainnet'})
  })

  it('says nothing about networks for a non-Cardano address', () => {
    expect(networkFitFor('0xabc', 'preprod')).toEqual({kind: 'unknown'})
  })
})
