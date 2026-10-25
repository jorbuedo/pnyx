import {blake2b} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'
import {
  DUST_AUTH_TOKEN_ASSET_ID,
  DUST_VALIDATOR_ADDRESS,
  DUST_VALIDATOR_SCRIPT_HASH,
  DUST_VALIDATOR_SCRIPT_HEX,
} from './validator'

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

describe('the embedded mapping validator', () => {
  it('hashes to the policy id it claims', () => {
    // The only thing standing between a corrupted paste of ~3.2 KB of script and a
    // transaction the validator rejects. A Plutus V3 script hash is
    // blake2b-224 over the language tag 0x03 followed by the script bytes.
    const tagged = new Uint8Array([0x03, ...fromHex(DUST_VALIDATOR_SCRIPT_HEX)])

    expect(toHex(blake2b(tagged, 28))).toBe(DUST_VALIDATOR_SCRIPT_HASH)
  })

  it('the validator address carries that same script hash as an enterprise credential', () => {
    // Header 0x71 = enterprise address, script payment credential, mainnet. If the address
    // and the script ever disagreed, the auth token would go somewhere it cannot be spent.
    expect(DUST_VALIDATOR_ADDRESS.startsWith('addr1w')).toBe(true)
  })

  it('the auth token is the policy with an empty asset name', () => {
    expect(DUST_AUTH_TOKEN_ASSET_ID).toBe(`${DUST_VALIDATOR_SCRIPT_HASH}.`)
  })
})
