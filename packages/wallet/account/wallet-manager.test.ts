/**
 * Tests for WalletManager group-centric storage and multi-account features,
 * plus the per-family account-xpub derivation + import/backfill persistence
 * (BO-2). Midnight/BTC/EVM derive a 65-byte secp256k1 xpub, Cardano a 64-byte
 * BIP32-Ed25519 xpub; Solana is deferred (no public-child derivation).
 *
 * @module
 */

import {describe, expect, it} from '@effect/vitest'
import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  type ChainId,
  ETHEREUM_MAINNET,
  MIDNIGHT_MAINNET,
  SOLANA_MAINNET,
} from '@pnyx/config'
import {
  asMnemonic,
  encodeSegwitAddress,
  HDKey,
  hash160,
  keccak256,
  secp256k1AccountXpub,
  secp256k1PublicChild,
  secp256k1Raw64FromCompressed,
} from '@pnyx/crypto'
import {createMemoryStorage, Storage} from '@pnyx/storage'
import {Effect, Layer, Ref} from 'effect'
import type {WalletGroupId} from '../types.js'
import {deriveCardanoAccountXpub} from './derivation/cardano.js'
import {mnemonicToSeed} from './seed.js'
import {deriveAccountXPub as deriveXPub, createWalletManager as makeManager} from './wallet-manager.js'

// The manager and `deriveAccountXPub` take their codec backend from the caller; a test names it.
const createWalletManager = (...args: Parameters<typeof makeManager>) => makeManager(...args)
const deriveAccountXPub = (...args: Parameters<typeof deriveXPub>) => deriveXPub(...args)

const TEST_MNEMONIC = asMnemonic(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
)
const OTHER_MNEMONIC = asMnemonic(
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
)

// Canonical BIP-39 vector — the golden receive addresses below are for it.
const CANONICAL_MNEMONIC = asMnemonic(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
)
// Golden receive addresses at index 0/0 (see bitcoin/evm/cardano derivation tests).
const BTC_MAINNET_0_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const EVM_0_0_LOWER = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const CARDANO_MAINNET_BASE =
  'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

/** Rebuild the base58 secp256k1 account xpub from stored `pubkey‖chaincode` bytes.
 *  Child derivation only reads pubkey + chain code, so zeroed metadata is fine. */
const secp256k1XpubFromBytes = (bytes: Uint8Array): string =>
  new HDKey({publicKey: bytes.slice(0, 33), chainCode: bytes.slice(33)}).publicExtendedKey

describe('deriveAccountXPub', () => {
  it('derives a deterministic 65-byte midnight xpub (33-byte pubkey + 32-byte chain code)', async () => {
    const a = await Effect.runPromise(deriveAccountXPub(TEST_MNEMONIC, MIDNIGHT_MAINNET, 0))
    const b = await Effect.runPromise(deriveAccountXPub(TEST_MNEMONIC, MIDNIGHT_MAINNET, 0))

    expect(a).toHaveLength(65)
    // Compressed secp256k1 public key prefix
    expect(a[0] === 0x02 || a[0] === 0x03).toBe(true)
    expect(a).toEqual(b)
  })

  it('derives distinct xpubs for distinct account indices and mnemonics', async () => {
    const account0 = await Effect.runPromise(deriveAccountXPub(TEST_MNEMONIC, MIDNIGHT_MAINNET, 0))
    const account1 = await Effect.runPromise(deriveAccountXPub(TEST_MNEMONIC, MIDNIGHT_MAINNET, 1))
    const otherSeed = await Effect.runPromise(deriveAccountXPub(OTHER_MNEMONIC, MIDNIGHT_MAINNET, 0))

    expect(account0).not.toEqual(account1)
    expect(account0).not.toEqual(otherSeed)
  })

  it('derives the secp256k1 (BTC/EVM) account xpub as 65-byte pubkey‖chaincode == secp256k1AccountXpub', async () => {
    const seed = await mnemonicToSeed(CANONICAL_MNEMONIC)
    for (const [chainId, path] of [
      [BITCOIN_MAINNET, "m/84'/0'/0'"],
      [ETHEREUM_MAINNET, "m/44'/60'/0'"],
    ] as const) {
      const bytes = await Effect.runPromise(deriveAccountXPub(CANONICAL_MNEMONIC, chainId, 0))
      const node = HDKey.fromExtendedKey(secp256k1AccountXpub(seed, path))
      expect(bytes).toHaveLength(65)
      expect(toHex(bytes.slice(0, 33))).toBe(toHex(node.publicKey as Uint8Array))
      expect(toHex(bytes.slice(33))).toBe(toHex(node.chainCode as Uint8Array))
    }
  })

  it('derives the cardano account xpub as 64-byte pubkey‖chaincode == deriveCardanoAccountXpub', async () => {
    const bytes = await Effect.runPromise(deriveAccountXPub(CANONICAL_MNEMONIC, CARDANO_MAINNET, 0))
    const goldenHex = await Effect.runPromise(deriveCardanoAccountXpub(CANONICAL_MNEMONIC, 0))
    expect(bytes).toHaveLength(64)
    expect(toHex(bytes)).toBe(goldenHex)
  })

  it('defers Solana — fails with DerivationError (no public-child derivation)', async () => {
    const result = await Effect.runPromise(Effect.either(deriveAccountXPub(CANONICAL_MNEMONIC, SOLANA_MAINNET, 0)))
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left._tag).toBe('DerivationError')
  })

  describe('xpub → golden address loop (closes BO-1)', () => {
    it('BTC: public child of the derived account xpub rebuilds the golden bc1 address', async () => {
      const bytes = await Effect.runPromise(deriveAccountXPub(CANONICAL_MNEMONIC, BITCOIN_MAINNET, 0))
      const child = secp256k1PublicChild(secp256k1XpubFromBytes(bytes), 0, 0)
      expect(encodeSegwitAddress('bc', 0, hash160(child))).toBe(BTC_MAINNET_0_0)
    })

    it('EVM: public child of the derived account xpub rebuilds the golden 0x address', async () => {
      const bytes = await Effect.runPromise(deriveAccountXPub(CANONICAL_MNEMONIC, ETHEREUM_MAINNET, 0))
      const child = secp256k1PublicChild(secp256k1XpubFromBytes(bytes), 0, 0)
      const addr20 = keccak256(secp256k1Raw64FromCompressed(child)).slice(-20)
      expect(`0x${toHex(addr20)}`).toBe(EVM_0_0_LOWER)
    })

    it('Cardano: public path from the derived account xpub rebuilds the golden base address', async () => {
      const bytes = await Effect.runPromise(deriveAccountXPub(CANONICAL_MNEMONIC, CARDANO_MAINNET, 0))
      const accountXpubHex = toHex(bytes)
      const base = await Effect.runPromise(
        Effect.gen(function* () {
          const paymentKeyHash = yield* Keys.derivePublicPath(XpubHex(accountXpubHex), [0, 0]).pipe(
            Effect.map((childXpub) => childXpub.slice(0, 64)),
            Effect.flatMap(Keys.keyHash),
          )
          // Stake key hash from the (private) root — role 2, index 0.
          const root = yield* Keys.rootKeyFromMnemonic(CANONICAL_MNEMONIC)
          const stakeKeyHash = yield* Keys.deriveCip1852(root, 0, 2, 0).pipe(Effect.flatMap(Keys.keyHashOf))
          return yield* Address.toBech32(Address.baseHex(Address.Network.Mainnet, paymentKeyHash, stakeKeyHash))
        }),
      )
      expect(base).toBe(CARDANO_MAINNET_BASE)
    })
  })
})

describe('ensureAccountXpubs (import + backfill)', () => {
  it('persists an xpub per configured + derive-only chain, skipping Solana', async () => {
    const manager = await Effect.runPromise(createWalletManager({allChainIds: [MIDNIGHT_MAINNET]}))
    const groupId = 'group-xpub-import' as WalletGroupId
    await Effect.runPromise(
      manager.createFromMnemonic({name: 'Main', mnemonic: CANONICAL_MNEMONIC, chainId: MIDNIGHT_MAINNET, groupId}),
    )

    const added = await Effect.runPromise(manager.ensureAccountXpubs(groupId, CANONICAL_MNEMONIC))
    // Midnight was already derived by createFromMnemonic; BTC/EVM/ADA are new.
    expect([...added].sort()).toEqual([BITCOIN_MAINNET, CARDANO_MAINNET, ETHEREUM_MAINNET].sort())

    const derived: readonly ChainId[] = [MIDNIGHT_MAINNET, BITCOIN_MAINNET, ETHEREUM_MAINNET, CARDANO_MAINNET]
    for (const chainId of derived) {
      const xpub = await Effect.runPromise(manager.getXPub(groupId, chainId, 0))
      expect(xpub.length).toBeGreaterThanOrEqual(64)
    }
    // Solana is never persisted.
    const sol = await Effect.runPromise(Effect.either(manager.getXPub(groupId, SOLANA_MAINNET, 0)))
    expect(sol._tag).toBe('Left')
  })

  it('is idempotent — a second call adds nothing and does not overwrite', async () => {
    const manager = await Effect.runPromise(createWalletManager({allChainIds: [MIDNIGHT_MAINNET]}))
    const groupId = 'group-xpub-idem' as WalletGroupId
    await Effect.runPromise(
      manager.createFromMnemonic({name: 'Main', mnemonic: CANONICAL_MNEMONIC, chainId: MIDNIGHT_MAINNET, groupId}),
    )

    await Effect.runPromise(manager.ensureAccountXpubs(groupId, CANONICAL_MNEMONIC))
    const before = await Effect.runPromise(manager.getXPub(groupId, BITCOIN_MAINNET, 0))

    const secondPass = await Effect.runPromise(manager.ensureAccountXpubs(groupId, CANONICAL_MNEMONIC))
    expect(secondPass).toEqual([])
    const after = await Effect.runPromise(manager.getXPub(groupId, BITCOIN_MAINNET, 0))
    expect(after).toEqual(before)
  })

  it('backfills a missing xpub and is a no-op when already present', async () => {
    const manager = await Effect.runPromise(createWalletManager()) // no allChainIds → derive-only set only
    const groupId = 'group-xpub-backfill' as WalletGroupId
    await Effect.runPromise(
      manager.createFromMnemonic({name: 'Main', mnemonic: CANONICAL_MNEMONIC, chainId: MIDNIGHT_MAINNET, groupId}),
    )

    // Fresh group has no derive-only xpubs — backfill populates BTC/EVM/ADA.
    const firstBefore = await Effect.runPromise(Effect.either(manager.getXPub(groupId, BITCOIN_MAINNET, 0)))
    expect(firstBefore._tag).toBe('Left')

    const added = await Effect.runPromise(manager.ensureAccountXpubs(groupId, CANONICAL_MNEMONIC))
    expect([...added].sort()).toEqual([BITCOIN_MAINNET, CARDANO_MAINNET, ETHEREUM_MAINNET].sort())

    const noop = await Effect.runPromise(manager.ensureAccountXpubs(groupId, CANONICAL_MNEMONIC))
    expect(noop).toEqual([])
  })
})

describe('WalletManager', () => {
  // ⚠️ No key of ours derives a watch-only or shared-wallet address, so the group record
  // is its only durable copy. The address table drops and recreates on a schema-version
  // mismatch and only derived books come back afterwards.
  describe('non-derived addresses', () => {
    it("keeps a read-only wallet's addresses on the chain config", async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createReadOnly({name: 'Watched', addresses: ['addr1_a', 'addr1_b'], chainId: CARDANO_MAINNET}),
      )
      expect(group.chains.get(CARDANO_MAINNET)?.nonDerivedAddresses).toEqual(['addr1_a', 'addr1_b'])
    })

    it('survives a save/load round trip', async () => {
      const storageLayer = Layer.succeed(Storage, createMemoryStorage())
      const manager = await Effect.runPromise(createWalletManager())
      await Effect.runPromise(
        manager.createReadOnly({
          name: 'Shared',
          addresses: ['addr1_script'],
          chainId: CARDANO_MAINNET,
          source: 'multisig',
        }),
      )
      await Effect.runPromise(manager.save().pipe(Effect.provide(storageLayer)))

      const reopened = await Effect.runPromise(createWalletManager())
      await Effect.runPromise(reopened.load().pipe(Effect.provide(storageLayer)))
      const groups = await Effect.runPromise(Ref.get(reopened.groups))
      const restored = [...groups.values()][0]
      expect(restored?.chains.get(CARDANO_MAINNET)?.nonDerivedAddresses).toEqual(['addr1_script'])
    })

    it('an ordinary wallet records none — its book comes from the xpub', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createFromMnemonic({name: 'HD', mnemonic: TEST_MNEMONIC, chainId: MIDNIGHT_MAINNET}),
      )
      expect(group.chains.get(MIDNIGHT_MAINNET)?.nonDerivedAddresses).toBeUndefined()
    })
  })

  describe('group creation', () => {
    it('auto-generates groupId when not provided', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Test',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
        }),
      )
      expect(group.groupId).toMatch(/^group-/)
    })

    it('uses provided groupId', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-custom-123' as WalletGroupId
      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Test',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )
      expect(group.groupId).toBe(groupId)
    })

    it('stores group-level metadata once', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-meta' as WalletGroupId

      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'MyWallet',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
          source: 'mnemonic',
        }),
      )

      expect(group.name).toBe('MyWallet')
      expect(group.source).toBe('mnemonic')
      expect(group.chains.get(MIDNIGHT_MAINNET)?.implementation).toBe('bip44')
      expect(group.chains.get(MIDNIGHT_MAINNET)?.accounts).toEqual([{index: 0, enabled: true}])
    })

    it('fails for chains without a derivation config', async () => {
      // Ethereum has an account xpub (eip155 secp256k1) but no first-class
      // derivation config here — it's a derive-only chain, not a group chain.
      const manager = await Effect.runPromise(createWalletManager())
      const result = await Effect.runPromise(
        Effect.either(
          manager.createFromMnemonic({
            name: 'Legacy',
            mnemonic: TEST_MNEMONIC,
            chainId: ETHEREUM_MAINNET,
          }),
        ),
      )
      expect(result._tag).toBe('Left')
    })
  })

  describe('group upgrade', () => {
    it('upgrades a keys-only group (imported-xpriv) in place when the seed is re-supplied', async () => {
      // Simulate a keys-only group landed via createFromXPub.
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-legacy' as WalletGroupId

      await Effect.runPromise(
        manager.createFromXPub({
          name: 'Imported Key',
          publicKey: new Uint8Array(33).fill(1),
          chainCode: new Uint8Array(32).fill(2),
          chainId: MIDNIGHT_MAINNET,
          groupId,
          source: 'imported-xpriv',
        }),
      )

      // User re-supplies the seed via the upgrade-in-place onboarding flow.
      const upgraded = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Imported Key',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      expect(upgraded.source).toBe('mnemonic')
      expect(upgraded.chains.has(MIDNIGHT_MAINNET)).toBe(true)
    })

    it('preserves multi-account ChainConfig when re-creating an existing chain', async () => {
      // Simulates the upgrade-in-place loop in preparing.tsx: it iterates every
      // default chain (including ones already present) and calls createWallet for
      // each. Without the guard in createFromMnemonic, addChainToGroup would
      // overwrite the existing ChainConfig with a fresh single-account default,
      // silently wiping any multi-account state.
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-multi-account' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Multi',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      // Materialise multi-account state: scan derives account entries 0..2,
      // then enableAccount flips index 1 on so the ChainConfig has non-default
      // `accounts`.
      await Effect.runPromise(manager.scanAccounts(groupId, MIDNIGHT_MAINNET, TEST_MNEMONIC, 3))
      await Effect.runPromise(manager.enableAccount(groupId, MIDNIGHT_MAINNET, 1))
      const beforeUpgrade = await Effect.runPromise(manager.getGroup(groupId))
      const beforeChain = beforeUpgrade.chains.get(MIDNIGHT_MAINNET)
      expect(beforeChain?.accounts.map((a) => a.index)).toEqual([0, 1, 2])
      expect(beforeChain?.accounts.find((a) => a.index === 1)?.enabled).toBe(true)

      // Re-run createFromMnemonic for the same chain (mirrors the preparing.tsx
      // chain loop hitting an already-present chain on upgrade).
      const upgraded = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Multi',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      const upgradedChain = upgraded.chains.get(MIDNIGHT_MAINNET)
      expect(upgradedChain?.accounts.map((a) => a.index)).toEqual([0, 1, 2])
      expect(upgradedChain?.accounts.find((a) => a.index === 1)?.enabled).toBe(true)
    })
  })

  describe('createFromDevice', () => {
    it('creates hardware wallet group with accounts', async () => {
      const manager = await Effect.runPromise(createWalletManager())

      const publicKeys = Array.from({length: 4}, (_, i) => ({
        publicKey: new Uint8Array(33).fill(i + 1),
        chainCode: new Uint8Array(32).fill(i + 100),
        accountIndex: i,
      }))

      const group = await Effect.runPromise(
        manager.createFromDevice({
          name: 'Device Wallet',
          publicKeys,
          chainId: MIDNIGHT_MAINNET,
          deviceType: 'hw-vendor',
        }),
      )

      expect(group.isHardware).toBe(true)
      expect(group.hardwareDeviceType).toBe('hw-vendor')

      const chain = group.chains.get(MIDNIGHT_MAINNET)
      expect(chain).toBeDefined()
      expect(chain?.accounts).toHaveLength(4)
      expect(chain?.accounts[0]).toEqual({index: 0, enabled: true})
      expect(chain?.accounts[1]).toEqual({index: 1, enabled: false})
    })

    it('stores all account xpubs', async () => {
      const manager = await Effect.runPromise(createWalletManager())

      const publicKeys = Array.from({length: 3}, (_, i) => ({
        publicKey: new Uint8Array(33).fill(i + 1),
        chainCode: new Uint8Array(32).fill(i + 100),
        accountIndex: i,
      }))

      const group = await Effect.runPromise(
        manager.createFromDevice({
          name: 'Device Wallet',
          publicKeys,
          chainId: MIDNIGHT_MAINNET,
          deviceType: 'hw-vendor',
        }),
      )

      for (let i = 0; i < 3; i++) {
        const xpub = await Effect.runPromise(manager.getXPub(group.groupId, MIDNIGHT_MAINNET, i))
        expect(xpub).toBeDefined()
        expect(xpub.length).toBe(65)
      }
    })

    // The array position used to be the account number, so importing the
    // device's account 2 on its own filed it under 0 — and every signing path
    // derives from the stored index, so the group's addresses came from one key
    // and its witnesses from another.
    it('files a single non-zero device account under its own index', async () => {
      const manager = await Effect.runPromise(createWalletManager())

      const group = await Effect.runPromise(
        manager.createFromDevice({
          name: 'Device Wallet',
          publicKeys: [{publicKey: new Uint8Array(33).fill(7), chainCode: new Uint8Array(32).fill(9), accountIndex: 2}],
          chainId: MIDNIGHT_MAINNET,
          deviceType: 'hw-vendor',
        }),
      )

      const chain = group.chains.get(MIDNIGHT_MAINNET)
      expect(chain?.accounts).toEqual([{index: 2, enabled: true}])
      expect(chain?.selectedAccountIndex).toBe(2)
      await expect(Effect.runPromise(manager.getXPub(group.groupId, MIDNIGHT_MAINNET, 2))).resolves.toBeDefined()
      await expect(Effect.runPromise(manager.getXPub(group.groupId, MIDNIGHT_MAINNET, 0))).rejects.toThrow()
    })
  })

  describe('createFromXPub', () => {
    it('uses provided groupId', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-xpub-test' as WalletGroupId

      const group = await Effect.runPromise(
        manager.createFromXPub({
          name: 'HW Wallet',
          publicKey: new Uint8Array(33).fill(1),
          chainCode: new Uint8Array(32).fill(2),
          chainId: MIDNIGHT_MAINNET,
          isHardware: true,
          hardwareDeviceType: 'hw-vendor',
          groupId,
        }),
      )

      expect(group.groupId).toBe(groupId)
      expect(group.chains.has(MIDNIGHT_MAINNET)).toBe(true)
    })

    it('rejects invalid key lengths', async () => {
      const manager = await Effect.runPromise(createWalletManager())

      const result = await Effect.runPromise(
        Effect.either(
          manager.createFromXPub({
            name: 'Bad',
            publicKey: new Uint8Array(16),
            chainCode: new Uint8Array(32),
            chainId: MIDNIGHT_MAINNET,
          }),
        ),
      )

      expect(result._tag).toBe('Left')
    })

    it('rejects 32-byte keys for midnight (secp256k1 needs 33)', async () => {
      const manager = await Effect.runPromise(createWalletManager())

      const result = await Effect.runPromise(
        Effect.either(
          manager.createFromXPub({
            name: 'Bad',
            publicKey: new Uint8Array(32).fill(1),
            chainCode: new Uint8Array(32).fill(2),
            chainId: MIDNIGHT_MAINNET,
          }),
        ),
      )

      expect(result._tag).toBe('Left')
    })
  })

  describe('cacheAccountXPub', () => {
    it('stores a legacy cardano xpub without adding the chain to the group', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-cache-xpub' as WalletGroupId
      // Cardano family: 32-byte Ed25519 public key + 32-byte chain code
      const publicKey = new Uint8Array(32).fill(3)
      const chainCode = new Uint8Array(32).fill(4)

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      await Effect.runPromise(
        manager.cacheAccountXPub({
          groupId,
          chainId: CARDANO_MAINNET,
          publicKey,
          chainCode,
        }),
      )

      const group = await Effect.runPromise(manager.getGroup(groupId))
      const xpub = await Effect.runPromise(manager.getXPub(groupId, CARDANO_MAINNET, 0))

      expect(group.chains.has(CARDANO_MAINNET)).toBe(false)
      expect(xpub).toEqual(new Uint8Array([...publicKey, ...chainCode]))
    })
  })

  describe('enableChain / disableChain', () => {
    it('re-enables a disabled chain from the cached xpub without a mnemonic', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-enable-chain' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      const disabled = await Effect.runPromise(manager.disableChain(groupId, MIDNIGHT_MAINNET))
      expect(disabled.chains.has(MIDNIGHT_MAINNET)).toBe(false)

      // The xpub survives in the store, so re-enabling needs no secret.
      const group = await Effect.runPromise(manager.enableChain(groupId, MIDNIGHT_MAINNET))

      expect(group.chains.has(MIDNIGHT_MAINNET)).toBe(true)
      expect(group.chains.size).toBe(1)
    })

    it('requires auth when no xpub is cached and no mnemonic is supplied', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-enable-auth' as WalletGroupId

      // Group exists but has no cardano xpub and cardano cannot derive.
      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      const result = await Effect.runPromise(Effect.either(manager.enableChain(groupId, CARDANO_MAINNET)))
      expect(result._tag).toBe('Left')
    })
  })

  describe('selection', () => {
    it('selects and deselects', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Test',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
        }),
      )

      await Effect.runPromise(manager.select({groupId: group.groupId, accountIndex: 0}))
      const sel = await Effect.runPromise(Ref.get(manager.selection))
      expect(sel).toEqual({groupId: group.groupId, accountIndex: 0})

      await Effect.runPromise(manager.deselect())
      const sel2 = await Effect.runPromise(Ref.get(manager.selection))
      expect(sel2).toBeNull()
    })
  })

  describe('deleteGroup', () => {
    it('removes the group and clears selection', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Test',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
        }),
      )

      await Effect.runPromise(manager.select({groupId: group.groupId, accountIndex: 0}))
      await Effect.runPromise(manager.deleteGroup(group.groupId))

      const map = await Effect.runPromise(Ref.get(manager.groups))
      expect(map.size).toBe(0)

      const sel = await Effect.runPromise(Ref.get(manager.selection))
      expect(sel).toBeNull()
    })
  })

  describe('scanAccounts', () => {
    it('derives xpubs for multiple accounts and populates accounts array', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-scan' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      const chain = await Effect.runPromise(manager.scanAccounts(groupId, MIDNIGHT_MAINNET, TEST_MNEMONIC, 3))

      expect(chain.accounts).toHaveLength(3)
      expect(chain.accounts[0]).toEqual({index: 0, enabled: true})
      expect(chain.accounts[1]).toEqual({index: 1, enabled: false})
      expect(chain.accounts[2]).toEqual({index: 2, enabled: false})
    })

    it('stores distinct xpubs for all scanned accounts', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-scan-xpubs' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      await Effect.runPromise(manager.scanAccounts(groupId, MIDNIGHT_MAINNET, TEST_MNEMONIC, 3))

      const xpub0 = await Effect.runPromise(manager.getXPub(groupId, MIDNIGHT_MAINNET, 0))
      const xpub1 = await Effect.runPromise(manager.getXPub(groupId, MIDNIGHT_MAINNET, 1))
      const xpub2 = await Effect.runPromise(manager.getXPub(groupId, MIDNIGHT_MAINNET, 2))

      expect(xpub0).toBeDefined()
      expect(xpub1).toBeDefined()
      expect(xpub2).toBeDefined()
      expect(xpub0).not.toEqual(xpub1)
      expect(xpub1).not.toEqual(xpub2)
    })

    it('preserves enabled state on re-scan', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-scan-preserve' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      await Effect.runPromise(manager.scanAccounts(groupId, MIDNIGHT_MAINNET, TEST_MNEMONIC, 3))
      await Effect.runPromise(manager.enableAccount(groupId, MIDNIGHT_MAINNET, 1))
      const chain = await Effect.runPromise(manager.scanAccounts(groupId, MIDNIGHT_MAINNET, TEST_MNEMONIC, 5))

      expect(chain.accounts).toHaveLength(5)
      expect(chain.accounts[0]?.enabled).toBe(true)
      expect(chain.accounts[1]?.enabled).toBe(true) // preserved from enable
      expect(chain.accounts[2]?.enabled).toBe(false)
    })
  })

  describe('enableAccount / disableAccount', () => {
    it('enables a disabled account', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const groupId = 'group-enable-acct' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      await Effect.runPromise(manager.scanAccounts(groupId, MIDNIGHT_MAINNET, TEST_MNEMONIC, 3))
      const chain = await Effect.runPromise(manager.enableAccount(groupId, MIDNIGHT_MAINNET, 1))
      expect(chain.accounts[1]?.enabled).toBe(true)
    })

    it('disableAccount is a no-op for account 0', async () => {
      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Main',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
        }),
      )

      const chain = await Effect.runPromise(manager.disableAccount(group.groupId, MIDNIGHT_MAINNET, 0))
      expect(chain.accounts[0]?.enabled).toBe(true)
    })
  })

  describe('save/load', () => {
    it('persists and restores groups, xpubs and selection', async () => {
      const storageLayer = Layer.succeed(Storage, createMemoryStorage())

      const manager = await Effect.runPromise(createWalletManager())
      const group = await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Persist Test',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
        }),
      )

      const originalXPub = await Effect.runPromise(manager.getXPub(group.groupId, MIDNIGHT_MAINNET, 0))

      await Effect.runPromise(manager.select({groupId: group.groupId, accountIndex: 0}))
      await Effect.runPromise(manager.save().pipe(Effect.provide(storageLayer)))

      // Create fresh manager and load
      const manager2 = await Effect.runPromise(createWalletManager())
      await Effect.runPromise(manager2.load().pipe(Effect.provide(storageLayer)))

      const loadedGroups = await Effect.runPromise(Ref.get(manager2.groups))
      expect(loadedGroups.size).toBe(1)

      const loadedGroup = loadedGroups.get(group.groupId)
      expect(loadedGroup).toBeDefined()
      expect(loadedGroup?.name).toBe('Persist Test')
      expect(loadedGroup?.chains.has(MIDNIGHT_MAINNET)).toBe(true)

      // xpub survives the hex round-trip byte-for-byte
      const loadedXPub = await Effect.runPromise(manager2.getXPub(group.groupId, MIDNIGHT_MAINNET, 0))
      expect(loadedXPub).toEqual(originalXPub)

      const sel = await Effect.runPromise(Ref.get(manager2.selection))
      expect(sel?.groupId).toBe(group.groupId)
      expect(sel?.accountIndex).toBe(0)
    })
  })

  describe('pre-derivation', () => {
    it('pre-derives xpubs for derivable chains and skips underivable ones', async () => {
      const manager = await Effect.runPromise(
        createWalletManager({allChainIds: [MIDNIGHT_MAINNET, CARDANO_MAINNET, SOLANA_MAINNET]}),
      )
      const groupId = 'group-pre-derive' as WalletGroupId

      await Effect.runPromise(
        manager.createFromMnemonic({
          name: 'Pre-derive',
          mnemonic: TEST_MNEMONIC,
          chainId: MIDNIGHT_MAINNET,
          groupId,
        }),
      )

      const midnightXPub = await Effect.runPromise(manager.getXPub(groupId, MIDNIGHT_MAINNET, 0))
      expect(midnightXPub).toHaveLength(65)

      // Cardano is derivable (BIP32-Ed25519) — pre-derivation now persists it.
      const cardanoXPub = await Effect.runPromise(manager.getXPub(groupId, CARDANO_MAINNET, 0))
      expect(cardanoXPub).toHaveLength(64)

      // Solana has no public-child derivation — pre-derivation must skip it gracefully.
      const solanaResult = await Effect.runPromise(Effect.either(manager.getXPub(groupId, SOLANA_MAINNET, 0)))
      expect(solanaResult._tag).toBe('Left')
    })
  })
})
