import {CARDANO_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {encodeDustAddress, encodeNightAddress, encodeShieldedAddress} from '@pnyx/wallet'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {resolveContactChain} from './chain-for-address'

const NIGHT_PAYLOAD = Buffer.from('fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41', 'hex')
const SHIELDED_CPK = Buffer.from('978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699', 'hex')
const SHIELDED_EPK = Buffer.from('365e2c24716918bfc917051311df6ca8c39990abe9668db9674c144987503dbd', 'hex')
const DUST_SCALAR = 0x66888c208fa98096f1caf1c099529a42c0d861e33e111b4fa52cde9eb937de6cn

const CARDANO_ADDRESS =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'

const resolve = (address: string, network: string | null = 'preprod') =>
  Effect.runPromise(resolveContactChain(address, network))

describe('resolveContactChain', () => {
  it('stores an unshielded Midnight address under the Midnight chain', async () => {
    expect(await resolve(encodeNightAddress(NIGHT_PAYLOAD, 'preprod'))).toEqual({ok: true, chain: MIDNIGHT_MAINNET})
  })

  it('stores a shielded Midnight address under the Midnight chain', async () => {
    expect(await resolve(encodeShieldedAddress(SHIELDED_CPK, SHIELDED_EPK, 'preprod'))).toEqual({
      ok: true,
      chain: MIDNIGHT_MAINNET,
    })
  })

  it('stores a Cardano address under the Cardano chain', async () => {
    expect(await resolve(CARDANO_ADDRESS)).toEqual({ok: true, chain: CARDANO_MAINNET})
  })

  /**
   * The whole point of the chain field: it records which chain, never which network. A contact saved
   * on preprod must still be payable on mainnet, exactly as Cardano contacts always have been.
   */
  it('does not bind the network — a mainnet address saved from a preprod wallet still resolves', async () => {
    expect(await resolve(encodeNightAddress(NIGHT_PAYLOAD, 'mainnet'), 'preprod')).toEqual({
      ok: true,
      chain: MIDNIGHT_MAINNET,
    })
  })

  it('refuses a DUST address with its own reason, not "invalid"', async () => {
    expect(await resolve(encodeDustAddress(DUST_SCALAR, 'preprod'))).toEqual({ok: false, reason: 'dust-address'})
  })

  it('refuses a damaged Midnight address', async () => {
    const address = encodeNightAddress(NIGHT_PAYLOAD, 'preprod')
    const damaged = `${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`
    expect(await resolve(damaged)).toEqual({ok: false, reason: 'invalid-address'})
  })

  it('refuses an empty address', async () => {
    expect(await resolve('   ')).toEqual({ok: false, reason: 'empty'})
  })

  it('refuses something that is neither chain', async () => {
    expect(await resolve('not-an-address')).toEqual({ok: false, reason: 'invalid-address'})
  })
})
