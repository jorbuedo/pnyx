import {XprvHex, XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {Effect, Exit} from 'effect'
import {describe, expect, it} from 'vitest'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const HARDENED = 0x80000000

// Golden vectors (see cardano.test.ts) for the canonical mnemonic, account 0.
const MAINNET_BASE =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'
const TESTNET_BASE =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'

/** payment key hash from a role/index via the SEEDLESS public path (CKDpub from the account xpub). */
const publicKeyHash = (accountXpubHex: string, role: number, index: number) =>
  Keys.derivePublicPath(XpubHex(accountXpubHex), [role, index]).pipe(
    Effect.map((childXpub) => childXpub.slice(0, 64)),
    Effect.flatMap(Keys.keyHash),
  )

/** payment key hash from a role/index via the PRIVATE path (root xprv). */
const privateKeyHash = (rootXprvHex: string, role: number, index: number) =>
  Keys.deriveCip1852(XprvHex(rootXprvHex), 0, role, index).pipe(Effect.flatMap(Keys.keyHashOf))

describe('Cardano BIP32-Ed25519 seedless public derivation (CKDpub)', () => {
  it('reproduces the golden base address via the PUBLIC path (== private path)', async () => {
    const program = Effect.gen(function* () {
      const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC)
      const acctXprv = yield* Keys.derivePath(root, [
        (1852 | HARDENED) >>> 0,
        (1815 | HARDENED) >>> 0,
        (0 | HARDENED) >>> 0,
      ])
      const accountXpub = yield* Keys.accountXpubOf(acctXprv)
      const stakeKeyHash = yield* privateKeyHash(root, 2, 0)

      const publicPayment = yield* publicKeyHash(accountXpub, 0, 0)
      const privatePayment = yield* privateKeyHash(root, 0, 0)
      const mainnet = yield* Address.toBech32(Address.baseHex(Address.Network.Mainnet, publicPayment, stakeKeyHash))
      const testnet = yield* Address.toBech32(Address.baseHex(Address.Network.Testnet, publicPayment, stakeKeyHash))

      return {publicPayment, privatePayment, mainnet, testnet}
    })

    const r = await Effect.runPromise(program)
    expect(r.publicPayment).toBe(r.privatePayment)
    expect(r.mainnet).toBe(MAINNET_BASE)
    expect(r.testnet).toBe(TESTNET_BASE)
  })

  it('public key hash == private key hash for role 0 / 0..3 and role 1 / 0..2', async () => {
    const program = Effect.gen(function* () {
      const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC)
      const acctXprv = yield* Keys.derivePath(root, [
        (1852 | HARDENED) >>> 0,
        (1815 | HARDENED) >>> 0,
        (0 | HARDENED) >>> 0,
      ])
      const accountXpub = yield* Keys.accountXpubOf(acctXprv)
      const cases: Array<{role: number; index: number}> = [
        ...[0, 1, 2, 3].map((index) => ({role: 0, index})),
        ...[0, 1, 2].map((index) => ({role: 1, index})),
      ]
      return yield* Effect.forEach(cases, ({role, index}) =>
        Effect.all({
          pub: publicKeyHash(accountXpub, role, index),
          priv: privateKeyHash(root, role, index),
        }),
      )
    })

    const results = await Effect.runPromise(program)
    for (const {pub, priv} of results) expect(pub).toBe(priv)
  })

  it('accountXpubOf agrees with bip32Public + chaincode and is 128 hex', async () => {
    const program = Effect.gen(function* () {
      const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC)
      const acctXprv = yield* Keys.derivePath(root, [
        (1852 | HARDENED) >>> 0,
        (1815 | HARDENED) >>> 0,
        (0 | HARDENED) >>> 0,
      ])
      const xpub = yield* Keys.accountXpubOf(acctXprv)
      const pub = yield* Keys.publicKey(acctXprv)
      return {xpub, pub, chainCode: acctXprv.slice(-64)}
    })

    const r = await Effect.runPromise(program)
    expect(r.xpub).toMatch(/^[0-9a-f]{128}$/)
    expect(r.xpub).toBe(r.pub + r.chainCode)
  })

  it('fails on a hardened index (impossible from a public key)', async () => {
    const program = Effect.gen(function* () {
      const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC)
      const acctXprv = yield* Keys.derivePath(root, [
        (1852 | HARDENED) >>> 0,
        (1815 | HARDENED) >>> 0,
        (0 | HARDENED) >>> 0,
      ])
      const accountXpub = yield* Keys.accountXpubOf(acctXprv)
      return yield* Keys.derivePublicPath(accountXpub, [(0 | HARDENED) >>> 0])
    })

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
