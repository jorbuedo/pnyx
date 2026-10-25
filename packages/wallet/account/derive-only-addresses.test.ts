import {BITCOIN_MAINNET, CARDANO_MAINNET, type ChainId, ETHEREUM_MAINNET} from '@pnyx/config'
import {HDKey, secp256k1AccountXpub} from '@pnyx/crypto'
import type {AddressRef, AddressRow} from '@pnyx/store/address-table'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {deriveCardanoAccountXpub} from './derivation/cardano.js'
import {
  DERIVE_ONLY_CHAIN_IDS,
  type DeriveOnlyAddressStore,
  getStoredDeriveOnlyAddresses,
  persistDeriveOnlyAddresses,
  resolveDeriveOnlyAddresses,
} from './derive-only-addresses.js'
import {mnemonicToSeed} from './seed.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const GROUP = 'group-test'

const keyOf = (ref: AddressRef, branch: string, index: number): string =>
  `${ref.groupId}|${ref.chainId}|${ref.accountIndex}|${branch}|${index}`

const makeStore = (): DeriveOnlyAddressStore & {rows: Map<string, AddressRow>} => {
  const rows = new Map<string, AddressRow>()
  return {
    rows,
    getAddress: (ref, branch, index) => Effect.succeed(rows.get(keyOf(ref, branch, index)) ?? null),
    upsertAddresses: (rs) =>
      Effect.sync(() => {
        for (const r of rs) rows.set(keyOf(r, r.branch, r.index), r)
      }),
  }
}

describe('persistDeriveOnlyAddresses', () => {
  it('persists only the Solana row (its sole copy) — no BTC/EVM/ADA rows at import', async () => {
    const store = makeStore()
    const result = await Effect.runPromise(
      persistDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, mnemonic: MNEMONIC}),
    )
    expect(result).toBe('stored')
    // Solana is the only non-xpub-derivable chain → exactly one row written.
    expect(store.rows.size).toBe(1)

    const stored = await Effect.runPromise(getStoredDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0}))
    expect(stored.solana).toBeDefined()
    expect(stored.bitcoin).toBeUndefined()
    expect(stored.evm).toBeUndefined()
    expect(stored.cardano).toBeUndefined()
  })

  it('writes no single row for the xpub-derivable chains (BTC/EVM/ADA)', async () => {
    const store = makeStore()
    await Effect.runPromise(persistDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, mnemonic: MNEMONIC}))
    for (const chain of ['bitcoin', 'evm', 'cardano'] as const) {
      const ref: AddressRef = {groupId: GROUP, chainId: DERIVE_ONLY_CHAIN_IDS[chain], accountIndex: 0}
      expect(await Effect.runPromise(store.getAddress(ref, 'single', 0))).toBeNull()
    }
    const solRef: AddressRef = {groupId: GROUP, chainId: DERIVE_ONLY_CHAIN_IDS.solana, accountIndex: 0}
    expect((await Effect.runPromise(store.getAddress(solRef, 'single', 0)))?.human).toBeDefined()
  })

  it('is idempotent — a second persist skips derivation', async () => {
    const store = makeStore()
    await Effect.runPromise(persistDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, mnemonic: MNEMONIC}))
    const second = await Effect.runPromise(
      persistDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, mnemonic: MNEMONIC}),
    )
    expect(second).toBe('already-stored')
  })

  it('getStored returns empty before anything is derived', async () => {
    const store = makeStore()
    const stored = await Effect.runPromise(getStoredDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0}))
    expect(stored).toEqual({})
  })
})

const BTC_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const EVM_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const ADA_0 = 'addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv'

/** The persisted secp256k1 account-xpub bytes (33 pub ‖ 32 cc), as wallet-manager stores them. */
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

describe('resolveDeriveOnlyAddresses', () => {
  it('derives BTC/EVM/Cardano from the stored xpub — no seed, no vault read', async () => {
    const store = makeStore()
    const xpubs = new Map<ChainId, Uint8Array>([
      [BITCOIN_MAINNET, await secp256k1XpubBytes("m/84'/0'/0'")],
      [ETHEREUM_MAINNET, await secp256k1XpubBytes("m/44'/60'/0'")],
      [
        CARDANO_MAINNET,
        Uint8Array.from(Buffer.from(await Effect.runPromise(deriveCardanoAccountXpub(MNEMONIC)), 'hex')),
      ],
    ])

    // The only secret-material seam is `getXpub` (PUBLIC keys). There is no
    // mnemonic / vault parameter, so a biometric prompt is structurally
    // impossible — `asked` records that only the xpub was ever consulted.
    const asked: ChainId[] = []
    const getXpub = (chainId: ChainId) => {
      asked.push(chainId)
      return Effect.succeed(xpubs.get(chainId) ?? null)
    }

    const {addresses, needsBackfill} = await Effect.runPromise(
      resolveDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, network: 'mainnet', getXpub}),
    )

    expect(addresses.bitcoin).toBe(BTC_0)
    expect(addresses.evm).toBe(EVM_0)
    expect(addresses.cardano).toBe(ADA_0)
    expect(asked).toEqual([BITCOIN_MAINNET, ETHEREUM_MAINNET, CARDANO_MAINNET])
    // Solana has no xpub (SLIP-0010, no public child) and no stored row → backfill flagged.
    expect(addresses.solana).toBeUndefined()
    expect(needsBackfill).toBe(true)

    // Xpub-derived addresses are NOT written back: import owns no BTC/EVM row and
    // Cardano rows belong to discovery, so resolution stays a pure read+derive.
    const btcRef: AddressRef = {groupId: GROUP, chainId: BITCOIN_MAINNET, accountIndex: 0}
    expect(await Effect.runPromise(store.getAddress(btcRef, 'single', 0))).toBeNull()
    const adaRef: AddressRef = {groupId: GROUP, chainId: CARDANO_MAINNET, accountIndex: 0}
    expect(await Effect.runPromise(store.getAddress(adaRef, 'single', 0))).toBeNull()
    expect(await Effect.runPromise(store.getAddress(adaRef, 'external', 0))).toBeNull()
  })

  it('reads Cardano from the discovered external[0] row and never asks for the xpub', async () => {
    const store = makeStore()
    const adaRef: AddressRef = {groupId: GROUP, chainId: CARDANO_MAINNET, accountIndex: 0}
    // Discovery persists external rows with the payment-key-hash as `hash`.
    await Effect.runPromise(
      store.upsertAddresses([
        {...adaRef, branch: 'external', index: 0, human: ADA_0, hash: 'a'.repeat(56), isUsed: false},
      ]),
    )

    const asked: ChainId[] = []
    const getXpub = (chainId: ChainId) => {
      asked.push(chainId)
      return Effect.succeed<Uint8Array | null>(null)
    }

    const {addresses} = await Effect.runPromise(
      resolveDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, network: 'mainnet', getXpub}),
    )
    expect(addresses.cardano).toBe(ADA_0)
    expect(asked).not.toContain(CARDANO_MAINNET)
  })

  it('uses the stored row and never asks for the xpub when a row already exists', async () => {
    const store = makeStore()
    const btcRef: AddressRef = {groupId: GROUP, chainId: BITCOIN_MAINNET, accountIndex: 0}
    await Effect.runPromise(
      store.upsertAddresses([{...btcRef, branch: 'single', index: 0, human: BTC_0, hash: BTC_0, isUsed: false}]),
    )

    const asked: ChainId[] = []
    const getXpub = (chainId: ChainId) => {
      asked.push(chainId)
      return Effect.succeed<Uint8Array | null>(null)
    }

    const {addresses} = await Effect.runPromise(
      resolveDeriveOnlyAddresses({store, groupId: GROUP, accountIndex: 0, network: 'mainnet', getXpub}),
    )
    expect(addresses.bitcoin).toBe(BTC_0)
    expect(asked).not.toContain(BITCOIN_MAINNET)
  })

  it('flags backfill when neither a row nor an xpub is available', async () => {
    const store = makeStore()
    const {addresses, needsBackfill} = await Effect.runPromise(
      resolveDeriveOnlyAddresses({
        store,
        groupId: GROUP,
        accountIndex: 0,
        network: 'mainnet',
        getXpub: () => Effect.succeed<Uint8Array | null>(null),
      }),
    )
    expect(addresses).toEqual({})
    expect(needsBackfill).toBe(true)
  })
})
