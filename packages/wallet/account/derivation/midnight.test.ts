import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {DerivationError} from '../../errors.js'
import {
  deriveMidnightDustAddress,
  deriveMidnightDustPublicKey,
  deriveMidnightNightAddress,
  deriveMidnightReceiveAddresses,
  deriveMidnightShieldedAddress,
} from './midnight.js'

// Golden vectors captured against the real @midnight-ntwrk SDK (wallet-sdk-hd 3.0.2,
// ledger-v8 8.1.0, wallet-sdk-address-format 3.1.2) for the canonical test mnemonic.
// The wallet's bip39 seed (pbkdf2-sha512, c=2048, dkLen=64) is byte-identical to mnemonicToSeedSync.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const seed = mnemonicToSeedSync(TEST_MNEMONIC)

const EXPECTED = {
  night: 'mn_addr1lhm2myd3rwe672fs3hsw2nc9t4wvkhtst7fq75jtlh7674a3reqspywdyd',
  dust: 'mn_dust1wdkdudaenm0zef20rvgnacmpmrqy9xjjn8q0rjh3j6q2nreq3jyxvv8fu09',
  shielded:
    'mn_shield-addr1j79fwduuxrpphd7v3flqufr6slsquc3laz5xcv0vn2ft23p4k6vnvh3vy3ckjx9leyts2yc3mak23suejz47je5dh9n5c9zfsagrm0gtahmdd',
} as const

const run = <A>(effect: Effect.Effect<A, DerivationError>): Promise<A> => Effect.runPromise(effect)

describe('midnight address derivation', () => {
  it('derives the unshielded (night) receive address', async () => {
    expect(await run(deriveMidnightNightAddress(seed))).toBe(EXPECTED.night)
  })

  it('derives the DUST delivery address', async () => {
    expect(await run(deriveMidnightDustAddress(seed))).toBe(EXPECTED.dust)
  })

  it('derives the shielded Zswap address', async () => {
    expect(await run(deriveMidnightShieldedAddress(seed))).toBe(EXPECTED.shielded)
  })

  it('derives the full receive-address set in one call', async () => {
    expect(await run(deriveMidnightReceiveAddresses(seed))).toEqual(EXPECTED)
  })

  it('exposes the DUST public key as a BLS12-381 scalar', async () => {
    const pk = await run(deriveMidnightDustPublicKey(seed))
    expect(typeof pk).toBe('bigint')
    // The scalar must be within the BLS12-381 scalar field.
    expect(pk).toBeLessThan(0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n)
  })

  it('produces distinct addresses per index', async () => {
    const a = await run(deriveMidnightDustAddress(seed, {index: 0}))
    const b = await run(deriveMidnightDustAddress(seed, {index: 1}))
    expect(a).not.toBe(b)
  })

  it('produces distinct addresses per account', async () => {
    const a = await run(deriveMidnightDustAddress(seed, {account: 0}))
    const b = await run(deriveMidnightDustAddress(seed, {account: 1}))
    expect(a).not.toBe(b)
  })

  it('fails with a typed DerivationError on an empty seed', async () => {
    const result = await Effect.runPromiseExit(deriveMidnightNightAddress(new Uint8Array(0)))
    expect(result._tag).toBe('Failure')
  })
})
