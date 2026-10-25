import {encodeDustAddress, encodeNightAddress, encodeShieldedAddress} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {routeRecipient} from './recipient-rail'

const NIGHT_PAYLOAD = Buffer.from('fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41', 'hex')
const SHIELDED_CPK = Buffer.from('978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699', 'hex')
const SHIELDED_EPK = Buffer.from('365e2c24716918bfc917051311df6ca8c39990abe9668db9674c144987503dbd', 'hex')
const DUST_SCALAR = 0x66888c208fa98096f1caf1c099529a42c0d861e33e111b4fa52cde9eb937de6cn

const night = (network: string) => encodeNightAddress(NIGHT_PAYLOAD, network)
const shielded = (network: string) => encodeShieldedAddress(SHIELDED_CPK, SHIELDED_EPK, network)

const CARDANO_ADDRESS =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'

describe('routeRecipient', () => {
  it('routes an unshielded address to the Midnight rail', () => {
    expect(routeRecipient(night('preprod'), 'preprod')).toEqual({
      rail: 'midnight',
      kind: 'unshielded',
      network: 'preprod',
      onOurNetwork: true,
    })
  })

  it('routes a shielded address to the shielded rail, not the unshielded one', () => {
    expect(routeRecipient(shielded('preprod'), 'preprod')).toMatchObject({rail: 'midnight', kind: 'shielded'})
  })

  it('maps the app network to its Midnight pairing', () => {
    expect(routeRecipient(night('mainnet'), 'mainnet')).toMatchObject({onOurNetwork: true})
    // Cardano preview has no Midnight pairing, so no Midnight address is on our network.
    expect(routeRecipient(night('mainnet'), 'preview')).toMatchObject({onOurNetwork: false})
    expect(routeRecipient(night('preprod'), null)).toMatchObject({onOurNetwork: false})
  })

  it('reports another network without calling the address wrong', () => {
    const route = routeRecipient(night('mainnet'), 'preprod')
    expect(route).toEqual({rail: 'midnight', kind: 'unshielded', network: 'mainnet', onOurNetwork: false})
  })

  it('leaves anything that is not a Midnight address to Cardano', () => {
    expect(routeRecipient(CARDANO_ADDRESS, 'mainnet')).toEqual({rail: 'cardano'})
    expect(routeRecipient('$alice', 'mainnet')).toEqual({rail: 'cardano'})
    expect(routeRecipient('someone.ada', 'mainnet')).toEqual({rail: 'cardano'})
    expect(routeRecipient('', 'mainnet')).toEqual({rail: 'cardano'})
  })

  it('refuses a DUST address as a destination', () => {
    expect(routeRecipient(encodeDustAddress(DUST_SCALAR, 'preprod'), 'preprod')).toEqual({
      rail: 'unusable',
      reason: 'dust-address',
    })
  })

  it('distinguishes a damaged Midnight address from another chain', () => {
    const address = night('preprod')
    const damaged = `${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`
    expect(routeRecipient(damaged, 'preprod')).toEqual({rail: 'unusable', reason: 'damaged-midnight'})
  })

  it('tolerates the whitespace a paste carries', () => {
    expect(routeRecipient(`  ${night('preprod')}\n`, 'preprod')).toMatchObject({rail: 'midnight'})
  })
})
