import {Bech32} from '@evolution-sdk/review/Brands'
import {Address, Wallet} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {CARDANO_PAYMENT_PATH, CARDANO_STAKE_PATH, cardanoAccountFromAddress} from './account'

// Golden vector from packages/wallet/account/derivation/cardano.test.ts
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TESTNET_BASE =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
const MAINNET_REWARD = 'stake1u8j40zgr2gy4788kl54h6x3gu0pukq5lfr8nflufpg5dzaskqlx2l'
// Same account, receive index 1 — shares the stake credential, different payment key.
const TESTNET_INDEX_1 =
  'addr_test1qqz85693g4fr8c55mfyxhae8j2u04pydxrgqr73vmwpx3a8927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqlu9096'

describe('cardanoAccountFromAddress', () => {
  it('derives credentials matching the mnemonic-derived key hashes', async () => {
    const {context, paymentHash, stakeHash} = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* cardanoAccountFromAddress(Bech32(TESTNET_BASE))
        const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
        return {
          context,
          paymentHash: yield* account.paymentKeyHash(),
          stakeHash: yield* account.stakeKeyHash,
        }
      }),
    )
    expect(context.paymentKeyHashHex).toBe(paymentHash)
    expect(context.stakeKeyHashHex).toBe(stakeHash)
    expect(context.keyRegistry).toEqual([
      {keyHashHex: paymentHash, path: CARDANO_PAYMENT_PATH},
      {keyHashHex: stakeHash, path: CARDANO_STAKE_PATH},
    ])
    expect(context.walletContext.paymentKeyHashes.has(paymentHash)).toBe(true)
    expect(context.walletContext.stakeKeyHashHex).toBe(stakeHash)
    expect(context.addressBech32).toBe(TESTNET_BASE)
  })

  it('admits another derived address of the same account into the own-set', async () => {
    // Without this, paying our own index-1 address read as a stake-key hijack:
    // the warning was false and Activity counted the whole amount as leaving.
    const {context, index1Payment} = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* cardanoAccountFromAddress(Bech32(TESTNET_BASE), 0, null, [Bech32(TESTNET_INDEX_1)])
        const info = Address.inspect(Address.fromBech32Sync(Bech32(TESTNET_INDEX_1)))
        return {context, index1Payment: info.paymentCredHex}
      }),
    )

    expect(index1Payment).toBeDefined()
    expect(context.walletContext.paymentKeyHashes.has(index1Payment as string)).toBe(true)
    expect(context.walletContext.paymentKeyHashes.size).toBe(2)
    // The primary address is still the one we spend from and label with.
    expect(context.addressBech32).toBe(TESTNET_BASE)
  })

  it('leaves the own-set at one entry when no extra addresses are known', async () => {
    // A hijack address reuses the stake key under a foreign spending key. It is
    // never in our derived book, so it must stay a counterparty.
    const context = await Effect.runPromise(cardanoAccountFromAddress(Bech32(TESTNET_BASE), 0, null, []))

    expect(context.walletContext.paymentKeyHashes.size).toBe(1)
  })

  it('round-trips the address hex', async () => {
    const context = await Effect.runPromise(cardanoAccountFromAddress(Bech32(TESTNET_BASE)))
    const info = Address.inspect(context.addressHex)
    expect(info.kind).toBe('base')
  })

  it('rejects a reward (non-base) address', async () => {
    const error = await Effect.runPromise(Effect.flip(cardanoAccountFromAddress(Bech32(MAINNET_REWARD))))
    expect(error._tag).toBe('CardanoAccountError')
  })

  it('rejects garbage input', async () => {
    const error = await Effect.runPromise(Effect.flip(cardanoAccountFromAddress('not-an-address' as Bech32)))
    expect(error._tag).toBe('CardanoAccountError')
  })
})
