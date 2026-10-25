import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  deriveCardanoAccountXpub,
  deriveCardanoAddress,
  deriveCardanoAddressBook,
  deriveCardanoGovKeys,
  deriveCardanoGovKeysFromAccountXpub,
  deriveCardanoRewardAddress,
  discoverUsedCardanoAddresses,
} from './cardano.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Golden vectors for the canonical `abandon…about` mnemonic, CIP-1852 account 0,
// index 0 (Icarus BIP32-Ed25519). Byte-exact with CSL/CML when produced.
const MAINNET_BASE =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'
const TESTNET_BASE =
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn'
const MAINNET_REWARD = 'stake1u8j40zgr2gy4788kl54h6x3gu0pukq5lfr8nflufpg5dzaskqlx2l'

describe('deriveCardanoAddress', () => {
  it('derives the mainnet base address for the canonical mnemonic', async () => {
    const addr = await Effect.runPromise(deriveCardanoAddress(MNEMONIC))
    expect(addr).toBe(MAINNET_BASE)
  })

  it('derives the testnet base address', async () => {
    const addr = await Effect.runPromise(deriveCardanoAddress(MNEMONIC, {network: Address.Network.Testnet}))
    expect(addr).toBe(TESTNET_BASE)
  })

  it('is deterministic', async () => {
    const a = await Effect.runPromise(deriveCardanoAddress(MNEMONIC))
    const b = await Effect.runPromise(deriveCardanoAddress(MNEMONIC))
    expect(a).toBe(b)
  })

  it('derives distinct addresses per account', async () => {
    const a0 = await Effect.runPromise(deriveCardanoAddress(MNEMONIC, {account: 0}))
    const a1 = await Effect.runPromise(deriveCardanoAddress(MNEMONIC, {account: 1}))
    expect(a0).not.toBe(a1)
  })

  it('derives distinct addresses per index', async () => {
    const i0 = await Effect.runPromise(deriveCardanoAddress(MNEMONIC, {index: 0}))
    const i1 = await Effect.runPromise(deriveCardanoAddress(MNEMONIC, {index: 1}))
    expect(i0).not.toBe(i1)
  })
})

describe('deriveCardanoRewardAddress', () => {
  it('derives the mainnet reward (stake) address', async () => {
    const addr = await Effect.runPromise(deriveCardanoRewardAddress(MNEMONIC))
    expect(addr).toBe(MAINNET_REWARD)
  })
})

describe('deriveCardanoAccountXpub', () => {
  it('is a 128-hex account xpub (32-byte pubkey ‖ 32-byte chaincode), deterministic', async () => {
    const a = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const b = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    expect(a).toMatch(/^[0-9a-f]{128}$/)
    expect(a).toBe(b)
  })
})

describe('deriveCardanoAddressBook', () => {
  it('derives external + internal addresses sharing one stake key; external[0] == the primary address', async () => {
    // Seedless: the book derives entirely from the persisted account xpub (CKDpub).
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 3}))
    expect(book.external).toHaveLength(3)
    expect(book.internal).toHaveLength(3)
    expect(book.external[0]?.bech32).toBe(MAINNET_BASE)
    expect(book.rewardAddressBech32).toBe(MAINNET_REWARD)
    expect(book.accountXpubHex).toBe(xpub)
    // external and internal role-0 addresses differ (different payment key hash), same stake
    expect(book.external[0]?.bech32).not.toBe(book.internal[0]?.bech32)
    expect(book.external[0]?.role).toBe(0)
    expect(book.internal[0]?.role).toBe(1)
    // testnet form matches the golden testnet base at external[0]
    const testnet = await Effect.runPromise(
      deriveCardanoAddressBook(xpub, {count: 1, network: Address.Network.Testnet}),
    )
    expect(testnet.external[0]?.bech32).toBe(TESTNET_BASE)
  })

  // ⚠️ The property the gap scan's growth rests on. It stops re-deriving from zero each
  // time the book doubles and appends `from..count-1` instead, so an off-by-one here does
  // not fail loudly — it shifts every index in the extension, and the wallet quietly stops
  // recognising its own addresses.
  it('an extension is byte-identical to the tail of a full derivation', async () => {
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const whole = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 8}))
    const head = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 4}))
    const tail = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 8, from: 4}))

    expect(tail.external).toHaveLength(4)
    expect(tail.external.map((a) => a.index)).toEqual([4, 5, 6, 7])
    expect([...head.external, ...tail.external]).toEqual(whole.external)
    expect([...head.internal, ...tail.internal]).toEqual(whole.internal)
    // The stake half is derived per call and must not drift between them.
    expect(tail.stakeKeyHashHex).toBe(whole.stakeKeyHashHex)
    expect(tail.rewardAddressBech32).toBe(whole.rewardAddressBech32)
  })

  // The two roles have unrelated frontiers, so a caller growing them under one shared
  // count derives one role's book to fit the other's. Asking for a single role is what
  // lets each stop where its own gap does.
  it('a single-role derivation matches that role in a full one, and leaves the other empty', async () => {
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const both = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 5}))
    const externalOnly = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 5, roles: [0]}))
    const internalOnly = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 5, roles: [1]}))

    expect(externalOnly.external).toEqual(both.external)
    expect(externalOnly.internal).toEqual([])
    expect(internalOnly.internal).toEqual(both.internal)
    expect(internalOnly.external).toEqual([])
    // The stake half is shared and must not differ between the three.
    expect(externalOnly.rewardAddressBech32).toBe(both.rewardAddressBech32)
    expect(internalOnly.stakeKeyHashHex).toBe(both.stakeKeyHashHex)
  })

  it('a single-role extension still lines up with the tail of the full one', async () => {
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const whole = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 6}))
    const tail = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 6, from: 3, roles: [1]}))
    expect(tail.internal).toEqual(whole.internal.slice(3))
  })

  it('an empty extension asks for nothing rather than re-deriving the head', async () => {
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const none = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 4, from: 4}))
    expect(none.external).toEqual([])
    expect(none.internal).toEqual([])
  })
})

describe('deriveCardanoGovKeys', () => {
  it('derives distinct 32-byte DRep + stake public keys and the account xpub', async () => {
    const keys = await Effect.runPromise(deriveCardanoGovKeys(MNEMONIC))
    expect(keys.drepPubKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.stakePubKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(keys.accountXpubHex).toMatch(/^[0-9a-f]{128}$/) // pubkey(64) ‖ chaincode(64)
    expect(keys.drepPubKeyHex).not.toBe(keys.stakePubKeyHex)
  })

  it('is deterministic and agrees with deriveCardanoAccountXpub on the xpub', async () => {
    const keys = await Effect.runPromise(deriveCardanoGovKeys(MNEMONIC))
    const again = await Effect.runPromise(deriveCardanoGovKeys(MNEMONIC))
    expect(keys).toEqual(again)
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    expect(keys.accountXpubHex).toBe(xpub)
  })
})

describe('deriveCardanoGovKeysFromAccountXpub', () => {
  // The claim this whole hardware path rests on: the seedless CKDpub route to
  // the DRep and stake keys reaches the same keys the seed does. If it did not,
  // a hardware wallet would publish a CIP-95 DRep key nobody could match and a
  // stake key that names a different reward address than its own wallet.
  it('reaches the same keys as the seed path', async () => {
    const fromSeed = await Effect.runPromise(deriveCardanoGovKeys(MNEMONIC))
    const fromXpub = await Effect.runPromise(
      deriveCardanoGovKeysFromAccountXpub({
        accountXpubHex: fromSeed.accountXpubHex,
        // The one value a device has to supply — it is under a hardened purpose,
        // so no public derivation reaches it from the CIP-1852 xpub.
        sharedAccountXpubHex: fromSeed.sharedAccountXpubHex ?? '',
      }),
    )
    expect(fromXpub).toEqual(fromSeed)
  })

  it('agrees at a non-zero account too', async () => {
    const fromSeed = await Effect.runPromise(deriveCardanoGovKeys(MNEMONIC, 3))
    const fromXpub = await Effect.runPromise(
      deriveCardanoGovKeysFromAccountXpub({
        accountXpubHex: fromSeed.accountXpubHex,
        sharedAccountXpubHex: fromSeed.sharedAccountXpubHex ?? '',
        account: 3,
      }),
    )
    expect(fromXpub).toEqual(fromSeed)
  })

  it('passes the shared xpub through untouched', async () => {
    // It cannot be derived or checked here — it comes from a different hardened
    // purpose. Anything but a passthrough would be inventing a roster identity.
    const fromSeed = await Effect.runPromise(deriveCardanoGovKeys(MNEMONIC))
    const keys = await Effect.runPromise(
      deriveCardanoGovKeysFromAccountXpub({
        accountXpubHex: fromSeed.accountXpubHex,
        sharedAccountXpubHex: 'ff'.repeat(64),
      }),
    )
    expect(keys.sharedAccountXpubHex).toBe('ff'.repeat(64))
    expect(keys.accountXpubHex).toBe(fromSeed.accountXpubHex)
  })

  it('fails rather than inventing keys from a malformed xpub', async () => {
    await expect(
      Effect.runPromise(
        deriveCardanoGovKeysFromAccountXpub({accountXpubHex: 'not-an-xpub', sharedAccountXpubHex: 'ff'.repeat(64)}),
      ),
    ).rejects.toThrow()
  })
})

describe('discoverUsedCardanoAddresses', () => {
  it('gap-limits the scan and always keeps the primary address', async () => {
    const xpub = await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC))
    const book = await Effect.runPromise(deriveCardanoAddressBook(xpub, {count: 10}))
    // external 0 + 1 are used; the unused tail beyond triggers the gap stop.
    const usedSet = new Set([book.external[0]?.bech32, book.external[1]?.bech32])
    const active = await Effect.runPromise(discoverUsedCardanoAddresses(book, (b) => Effect.succeed(usedSet.has(b)), 2))
    const bechs = active.map((a) => a.bech32)
    expect(bechs).toContain(book.external[0]?.bech32) // primary always kept
    expect(bechs).toContain(book.external[1]?.bech32) // used, in-window
    // gap-limit 2: two consecutive unused (idx 2,3) stops the scan — the far tail is never kept
    expect(bechs).not.toContain(book.external[9]?.bech32)
  })
})
