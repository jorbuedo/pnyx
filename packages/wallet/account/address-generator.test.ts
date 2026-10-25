import {BITCOIN_MAINNET, CARDANO_MAINNET, ETHEREUM_MAINNET, MIDNIGHT_MAINNET, SOLANA_MAINNET} from '@pnyx/config'
import {
  HDKey,
  secp256k1AccountXpub,
  secp256k1PrivateKeyAtPath,
  secp256k1PublicKeyCompressed,
  secp256k1PublicKeyRaw64,
} from '@pnyx/crypto'
import {Effect, Exit} from 'effect'
import {describe, expect, it} from 'vitest'
import {createAddressGeneratorForChain as makeGenerator} from './address-generator.js'
import {bitcoinAddressFromPublicKey} from './derivation/bitcoin.js'
import {deriveCardanoAccountXpub as deriveXpub} from './derivation/cardano.js'
import {evmAddressFromRaw64} from './derivation/evm.js'
import {mnemonicToSeed} from './seed.js'

// Both take their codec backend from the caller; a test names it.
const createAddressGeneratorForChain = (...args: Parameters<typeof makeGenerator>) => makeGenerator(...args)
const deriveCardanoAccountXpub = (...args: Parameters<typeof deriveXpub>) => deriveXpub(...args)

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Golden receive addresses for the canonical mnemonic, account 0, index 0.
const BTC_0_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const EVM_0_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const ADA_BASE_0 =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'
const ADA_REWARD = 'stake1u8j40zgr2gy4788kl54h6x3gu0pukq5lfr8nflufpg5dzaskqlx2l'

/** Rebuild the persisted secp256k1 account-xpub bytes (33 pub ‖ 32 cc), as wallet-manager stores them. */
const secp256k1XpubBytes = async (path: string): Promise<Uint8Array> => {
  const seed = await mnemonicToSeed(MNEMONIC)
  const node = HDKey.fromExtendedKey(secp256k1AccountXpub(seed, path))
  const pub = node.publicKey as Uint8Array
  const cc = node.chainCode as Uint8Array
  const out = new Uint8Array(pub.length + cc.length)
  out.set(pub, 0)
  out.set(cc, pub.length)
  return out
}

describe('createAddressGeneratorForChain — Bitcoin (BIP-84)', () => {
  it('derives the golden receive address from the account xpub (no seed)', async () => {
    const xpub = await secp256k1XpubBytes("m/84'/0'/0'")
    const gen = await Effect.runPromise(createAddressGeneratorForChain(xpub, BITCOIN_MAINNET, 'mainnet'))
    expect(gen.supportsMultipleAddresses).toBe(true)
    expect(gen.hasRewardAddress).toBe(false)
    expect(await Effect.runPromise(gen.derive(0, 0))).toBe(BTC_0_0)
  })

  it('receive (role 0) and change (role 1) branches reproduce the private-path addresses', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const xpub = await secp256k1XpubBytes("m/84'/0'/0'")
    const gen = await Effect.runPromise(createAddressGeneratorForChain(xpub, BITCOIN_MAINNET, 'mainnet'))

    for (const [role, index] of [
      [0, 0],
      [0, 3],
      [1, 0],
      [1, 2],
    ] as const) {
      const priv = secp256k1PrivateKeyAtPath(seed, `m/84'/0'/0'/${role}/${index}`)
      const expected = bitcoinAddressFromPublicKey(secp256k1PublicKeyCompressed(priv), 'mainnet')
      expect(await Effect.runPromise(gen.derive(role, index))).toBe(expected)
    }
  })

  it('deriveRange returns a contiguous set of distinct addresses', async () => {
    const xpub = await secp256k1XpubBytes("m/84'/0'/0'")
    const gen = await Effect.runPromise(createAddressGeneratorForChain(xpub, BITCOIN_MAINNET, 'mainnet'))
    const range = await Effect.runPromise(gen.deriveRange(0, 0, 5))
    expect(range).toHaveLength(5)
    expect(range[0]).toBe(BTC_0_0)
    expect(new Set(range).size).toBe(5)
  })

  it('reward address is null (no staking role)', async () => {
    const xpub = await secp256k1XpubBytes("m/84'/0'/0'")
    const gen = await Effect.runPromise(createAddressGeneratorForChain(xpub, BITCOIN_MAINNET, 'mainnet'))
    expect(await Effect.runPromise(gen.getRewardAddress())).toBeNull()
    const exit = await Effect.runPromiseExit(gen.derive(2, 0))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('createAddressGeneratorForChain — EVM (BIP-44)', () => {
  it('derives the golden receive address and is single-address', async () => {
    const xpub = await secp256k1XpubBytes("m/44'/60'/0'")
    const gen = await Effect.runPromise(createAddressGeneratorForChain(xpub, ETHEREUM_MAINNET, 'mainnet'))
    expect(gen.supportsMultipleAddresses).toBe(false)
    expect(await Effect.runPromise(gen.derive(0, 0))).toBe(EVM_0_0)
  })

  it('receive (role 0) and change (role 1) branches reproduce the private-path addresses', async () => {
    const seed = await mnemonicToSeed(MNEMONIC)
    const xpub = await secp256k1XpubBytes("m/44'/60'/0'")
    const gen = await Effect.runPromise(createAddressGeneratorForChain(xpub, ETHEREUM_MAINNET, 'mainnet'))

    for (const [role, index] of [
      [0, 0],
      [0, 1],
      [1, 0],
    ] as const) {
      const priv = secp256k1PrivateKeyAtPath(seed, `m/44'/60'/0'/${role}/${index}`)
      const expected = evmAddressFromRaw64(secp256k1PublicKeyRaw64(priv))
      expect(await Effect.runPromise(gen.derive(role, index))).toBe(expected)
    }
  })
})

describe('createAddressGeneratorForChain — Cardano (CIP-1852)', () => {
  it('derives the golden base receive address + reward address from the account xpub (no seed)', async () => {
    const xpubHex = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const bytes = Uint8Array.from(Buffer.from(xpubHex, 'hex'))
    const gen = await Effect.runPromise(createAddressGeneratorForChain(bytes, CARDANO_MAINNET, 'mainnet'))
    expect(gen.supportsMultipleAddresses).toBe(true)
    expect(gen.hasRewardAddress).toBe(true)
    expect(await Effect.runPromise(gen.derive(0, 0))).toBe(ADA_BASE_0)
    expect(await Effect.runPromise(gen.getRewardAddress())).toBe(ADA_REWARD)
    expect(await Effect.runPromise(gen.derive(2, 0))).toBe(ADA_REWARD)
  })

  it('external (role 0) and internal (role 1) role-0 addresses differ (same stake key)', async () => {
    const xpubHex = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const bytes = Uint8Array.from(Buffer.from(xpubHex, 'hex'))
    const gen = await Effect.runPromise(createAddressGeneratorForChain(bytes, CARDANO_MAINNET, 'mainnet'))
    const external0 = await Effect.runPromise(gen.derive(0, 0))
    const internal0 = await Effect.runPromise(gen.derive(1, 0))
    expect(external0).not.toBe(internal0)
    expect(external0).toBe(ADA_BASE_0)
  })
})

describe('createAddressGeneratorForChain — non-xpub families fail honestly', () => {
  it('Solana reports unsupported (persisted-address model)', async () => {
    const exit = await Effect.runPromiseExit(
      createAddressGeneratorForChain(new Uint8Array(64), SOLANA_MAINNET, 'mainnet'),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('Midnight reports unsupported (role secret-key model)', async () => {
    const exit = await Effect.runPromiseExit(
      createAddressGeneratorForChain(new Uint8Array(65), MIDNIGHT_MAINNET, 'mainnet'),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
