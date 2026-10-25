import {addressFromKey, signatureVerifyingKey, signingKeyFromBip340} from '@midnight-ntwrk/ledger-v8'
import {bech32m} from '@scure/base'
import {describe, expect, it} from 'vitest'
import {
  decodeDustAddressPayload,
  encodeDustAddress,
  encodeDustAddressPayload,
  encodeNightAddress,
  encodeShieldedAddress,
  nightPayloadFromVerifyingKey,
  parseMidnightAddress,
} from './midnight-address-encoding.js'

// Raw payloads decoded from the golden-vector addresses captured against the real @midnight-ntwrk
// SDK (wallet-sdk-address-format 3.1.2) for the canonical test mnemonic at account 0, index 0.
// These pin the pure encoders to the SDK's output byte-for-byte, independent of the curve math
// that produces the payloads.
const NIGHT_PAYLOAD = Buffer.from('fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41', 'hex')
const DUST_SCALAR = 0x66888c208fa98096f1caf1c099529a42c0d861e33e111b4fa52cde9eb937de6cn
const SHIELDED_CPK = Buffer.from('978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699', 'hex')
const SHIELDED_EPK = Buffer.from('365e2c24716918bfc917051311df6ca8c39990abe9668db9674c144987503dbd', 'hex')

const EXPECTED = {
  night: 'mn_addr1lhm2myd3rwe672fs3hsw2nc9t4wvkhtst7fq75jtlh7674a3reqspywdyd',
  dust: 'mn_dust1wdkdudaenm0zef20rvgnacmpmrqy9xjjn8q0rjh3j6q2nreq3jyxvv8fu09',
  shielded:
    'mn_shield-addr1j79fwduuxrpphd7v3flqufr6slsquc3laz5xcv0vn2ft23p4k6vnvh3vy3ckjx9leyts2yc3mak23suejz47je5dh9n5c9zfsagrm0gtahmdd',
} as const

describe('midnight address encoding', () => {
  it('encodes the unshielded (night) address', () => {
    expect(encodeNightAddress(NIGHT_PAYLOAD, 'mainnet')).toBe(EXPECTED.night)
  })

  it('encodes the DUST address from a BLS12-381 scalar', () => {
    expect(encodeDustAddress(DUST_SCALAR, 'mainnet')).toBe(EXPECTED.dust)
  })

  it('encodes the shielded Zswap address from coin + encryption public keys', () => {
    expect(encodeShieldedAddress(SHIELDED_CPK, SHIELDED_EPK, 'mainnet')).toBe(EXPECTED.shielded)
  })

  it('embeds a network segment for non-mainnet ids', () => {
    expect(encodeNightAddress(NIGHT_PAYLOAD, 'test')).toMatch(/^mn_addr_test1/)
  })

  it('rejects an out-of-range DUST scalar', () => {
    expect(() =>
      encodeDustAddress(0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n, 'mainnet'),
    ).toThrow()
  })

  it('rejects a wrong-length night payload', () => {
    expect(() => encodeNightAddress(new Uint8Array(31), 'mainnet')).toThrow()
  })

  it('decodes the DUST payload back from an mn_dust address (bech32m inverse)', () => {
    // The 33-byte registration-datum payload from the captured mainnet register tx.
    const golden = '736eac3e7bd29f5f6f950d57d3218f1f3194ba91e2e5f9e27b5add9f75fc78613d'
    const addr = bech32m.encode('mn_dust', bech32m.toWords(Buffer.from(golden, 'hex')), false)
    expect(Buffer.from(decodeDustAddressPayload(addr)).toString('hex')).toBe(golden)
  })

  it('recovers the payload from a real encodeDustAddress output (round-trip)', () => {
    const payload = decodeDustAddressPayload(EXPECTED.dust)
    expect(payload.length).toBeLessThanOrEqual(33)
    expect(bech32m.encode('mn_dust', bech32m.toWords(payload), false)).toBe(EXPECTED.dust)
  })

  it('rejects a non-dust address', () => {
    expect(() => decodeDustAddressPayload(EXPECTED.night)).toThrow(/mn_dust/)
  })
})

describe('encodeDustAddressPayload', () => {
  it('round-trips any mn_dust address through its raw payload', () => {
    const address = encodeDustAddress(DUST_SCALAR, 'mainnet')
    expect(encodeDustAddressPayload(decodeDustAddressPayload(address), 'mainnet')).toBe(address)
  })

  it('keeps the network segment, so a testnet payload never reads as mainnet', () => {
    const address = encodeDustAddress(DUST_SCALAR, 'preprod')
    const payload = decodeDustAddressPayload(address)
    expect(encodeDustAddressPayload(payload, 'preprod')).toBe(address)
    expect(encodeDustAddressPayload(payload, 'mainnet')).not.toBe(address)
  })

  it('rejects a payload no DUST address could carry', () => {
    // The datum caps `dust_address` at 33 bytes; anything else is not a destination we can name.
    expect(() => encodeDustAddressPayload(new Uint8Array(0), 'mainnet')).toThrow()
    expect(() => encodeDustAddressPayload(new Uint8Array(34), 'mainnet')).toThrow()
  })
})

// Moved here when `@pnyx/midnight-address` was retired: that package held a second, parallel
// mn_addr codec whose only remaining callers were tests. What was worth keeping is this pin —
// the pure-JS payload rule checked against the implementation Midnight nodes and wallets ship.
describe('nightPayloadFromVerifyingKey', () => {
  // Test vector from source-reads-2026-07.md §1 (verified against ledger WASM v6/v7/v8).
  const VK_HEX = '6a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3'
  const MAINNET_ADDR = 'mn_addr155jdc6mufu5jfcmn8hfl38m5cn2w04z0h0syt8etmd9zgcd2704q6k7cn4'

  it('reproduces the known mainnet test vector', () => {
    const payload = nightPayloadFromVerifyingKey(Buffer.from(VK_HEX, 'hex'))
    expect(encodeNightAddress(payload, 'mainnet')).toBe(MAINNET_ADDR)
  })

  it('matches ledger-v8 WASM addressFromKey byte-for-byte', () => {
    const sk = signingKeyFromBip340(new Uint8Array(32).fill(0xaa))
    const vk = signatureVerifyingKey(sk)
    expect(vk).toBe(VK_HEX)
    expect(nightPayloadFromVerifyingKey(Buffer.from(vk, 'hex'))).toEqual(
      new Uint8Array(Buffer.from(addressFromKey(vk), 'hex')),
    )
  })

  it('keeps the network in the HRP, so a preprod address never reads as mainnet', () => {
    const payload = nightPayloadFromVerifyingKey(Buffer.from(VK_HEX, 'hex'))
    expect(encodeNightAddress(payload, 'preprod').startsWith('mn_addr_preprod1')).toBe(true)
    expect(encodeNightAddress(payload, 'preprod')).not.toBe(MAINNET_ADDR)
  })

  // sha256 of a malformed key is still 32 bytes, so the guard cannot be delegated to
  // encodeNightAddress's payload check without silently producing a plausible address.
  it('rejects non-32-byte keys loudly (SEC1 33-byte, stale 35-byte forms)', () => {
    expect(() => nightPayloadFromVerifyingKey(new Uint8Array(33))).toThrow(/32 bytes/)
    expect(() => nightPayloadFromVerifyingKey(new Uint8Array(35))).toThrow(/32 bytes/)
  })
})

describe('parseMidnightAddress', () => {
  const parsed = (address: string) => {
    const result = parseMidnightAddress(address)
    if (!result.ok) throw new Error(`expected a Midnight address, got ${result.reason}`)
    return result
  }
  const refused = (address: string) => {
    const result = parseMidnightAddress(address)
    if (result.ok) throw new Error(`expected a refusal, got a ${result.kind} address`)
    return result
  }

  it('round-trips every kind the encoders produce', () => {
    expect(parsed(EXPECTED.night)).toMatchObject({kind: 'night', network: 'mainnet'})
    expect(parsed(EXPECTED.dust)).toMatchObject({kind: 'dust', network: 'mainnet'})
    expect(parsed(EXPECTED.shielded)).toMatchObject({kind: 'shielded', network: 'mainnet'})
    expect(Buffer.from(parsed(EXPECTED.night).payload)).toEqual(NIGHT_PAYLOAD)
    expect(Buffer.from(parsed(EXPECTED.shielded).payload)).toEqual(Buffer.concat([SHIELDED_CPK, SHIELDED_EPK]))
    expect(Buffer.from(parsed(EXPECTED.dust).payload)).toEqual(
      Buffer.from(decodeDustAddressPayload(encodeDustAddress(DUST_SCALAR, 'mainnet'))),
    )
  })

  it('reads the network segment for a non-mainnet address', () => {
    expect(parsed(encodeNightAddress(NIGHT_PAYLOAD, 'preprod'))).toMatchObject({kind: 'night', network: 'preprod'})
    expect(parsed(encodeShieldedAddress(SHIELDED_CPK, SHIELDED_EPK, 'preprod'))).toMatchObject({
      kind: 'shielded',
      network: 'preprod',
    })
    // The HRP that the chain rejected on 2026-08-19: a real network id, just not ours.
    expect(parsed(encodeNightAddress(NIGHT_PAYLOAD, 'testnet'))).toMatchObject({network: 'testnet'})
  })

  it('does not confuse an unshielded address with a shielded one', () => {
    expect(parsed(encodeNightAddress(NIGHT_PAYLOAD, 'preprod')).kind).toBe('night')
    expect(parsed(encodeShieldedAddress(SHIELDED_CPK, SHIELDED_EPK, 'preprod')).kind).toBe('shielded')
  })

  it('accepts the upper-case form a QR code carries', () => {
    expect(parsed(EXPECTED.night.toUpperCase())).toMatchObject({kind: 'night', network: 'mainnet'})
  })

  it('rejects mixed case, which bech32 forbids', () => {
    const mixed = `mn_addr1${EXPECTED.night.slice(8).toUpperCase()}`
    expect(refused(mixed).reason).toBe('malformed')
  })

  it('calls a Cardano address not-midnight rather than malformed', () => {
    expect(refused('addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7s').reason).toBe('not-midnight')
    expect(refused('').reason).toBe('not-midnight')
    expect(refused('$handle').reason).toBe('not-midnight')
  })

  it('calls a damaged Midnight address malformed — the checksum is the whole point', () => {
    // One character changed inside the data part: same length, same prefix, broken checksum.
    const typo = `${EXPECTED.night.slice(0, -1)}${EXPECTED.night.endsWith('d') ? 'e' : 'd'}`
    expect(refused(typo).reason).toBe('malformed')
  })

  it('reports an unknown mn_ type as such, not as a typo', () => {
    const unknown = bech32m.encode('mn_future', bech32m.toWords(NIGHT_PAYLOAD), false)
    expect(refused(unknown)).toMatchObject({reason: 'unknown-type', hrp: 'mn_future'})
  })

  it('refuses a payload the kind cannot have', () => {
    const shortNight = bech32m.encode('mn_addr_preprod', bech32m.toWords(NIGHT_PAYLOAD.subarray(0, 31)), false)
    expect(refused(shortNight).reason).toBe('malformed')
    const longShielded = bech32m.encode('mn_shield-addr', bech32m.toWords(NIGHT_PAYLOAD), false)
    expect(refused(longShielded).reason).toBe('malformed')
  })

  it('refuses a trailing network separator with no network', () => {
    const empty = bech32m.encode('mn_addr_', bech32m.toWords(NIGHT_PAYLOAD), false)
    expect(refused(empty).reason).toBe('unknown-type')
  })
})
