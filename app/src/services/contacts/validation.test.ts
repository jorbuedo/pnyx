import {Address, Wallet} from '@pnyx/cardano-core'
import {CARDANO_MAINNET, ETHEREUM_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {encodeDustAddress, encodeNightAddress, encodeShieldedAddress} from '@pnyx/wallet'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {isValidContactName, validateContactAddress} from './validation'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
let cardanoAddress = ''

const NIGHT_PAYLOAD = Buffer.from('fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41', 'hex')
const SHIELDED_CPK = Buffer.from('978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699', 'hex')
const SHIELDED_EPK = Buffer.from('365e2c24716918bfc917051311df6ca8c39990abe9668db9674c144987503dbd', 'hex')
const DUST_SCALAR = 0x66888c208fa98096f1caf1c099529a42c0d861e33e111b4fa52cde9eb937de6cn

beforeAll(async () => {
  cardanoAddress = await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      return yield* account.baseAddress(Address.Network.Testnet)
    }),
  )
})

describe('validateContactAddress', () => {
  it('accepts a valid Cardano address', async () => {
    expect(await Effect.runPromise(validateContactAddress(CARDANO_MAINNET, cardanoAddress))).toEqual({ok: true})
  })

  it('rejects an empty address', async () => {
    expect(await Effect.runPromise(validateContactAddress(CARDANO_MAINNET, '   '))).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it('rejects an unparseable Cardano address', async () => {
    expect(await Effect.runPromise(validateContactAddress(CARDANO_MAINNET, 'not-an-address'))).toEqual({
      ok: false,
      reason: 'invalid-address',
    })
  })

  it('decodes a Midnight address rather than waving it through', async () => {
    expect(
      await Effect.runPromise(validateContactAddress(MIDNIGHT_MAINNET, encodeNightAddress(NIGHT_PAYLOAD, 'preprod'))),
    ).toEqual({ok: true})
    expect(
      await Effect.runPromise(
        validateContactAddress(MIDNIGHT_MAINNET, encodeShieldedAddress(SHIELDED_CPK, SHIELDED_EPK, 'preprod')),
      ),
    ).toEqual({ok: true})
  })

  it('rejects a damaged Midnight address, which used to be accepted unchecked', async () => {
    const address = encodeNightAddress(NIGHT_PAYLOAD, 'preprod')
    const damaged = `${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`
    expect(await Effect.runPromise(validateContactAddress(MIDNIGHT_MAINNET, damaged))).toEqual({
      ok: false,
      reason: 'invalid-address',
    })
    expect(await Effect.runPromise(validateContactAddress(MIDNIGHT_MAINNET, 'anything at all'))).toEqual({
      ok: false,
      reason: 'invalid-address',
    })
  })

  it('rejects a DUST address: it can receive generated DUST but can never be paid', async () => {
    expect(
      await Effect.runPromise(validateContactAddress(MIDNIGHT_MAINNET, encodeDustAddress(DUST_SCALAR, 'preprod'))),
    ).toEqual({ok: false, reason: 'invalid-address'})
  })

  it('does a basic non-empty check for non-Cardano chains', async () => {
    expect(await Effect.runPromise(validateContactAddress(ETHEREUM_MAINNET, '0xabc'))).toEqual({ok: true})
    expect(await Effect.runPromise(validateContactAddress(ETHEREUM_MAINNET, ''))).toEqual({ok: false, reason: 'empty'})
  })
})

describe('isValidContactName', () => {
  it('requires a non-whitespace name', () => {
    expect(isValidContactName('Alice')).toBe(true)
    expect(isValidContactName('  ')).toBe(false)
    expect(isValidContactName('')).toBe(false)
  })
})
