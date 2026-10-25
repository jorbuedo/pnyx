import {CARDANO_MAINNET, type ChainId, ETHEREUM_MAINNET, MIDNIGHT_MAINNET} from '@pnyx/config'
import {deriveAccountXPub} from '@pnyx/wallet'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import {findExistingWalletForMnemonic, getDetectionChain} from './duplicate-wallet-detection'

describe('duplicate-wallet-detection', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  // Build a stored-xpub lookup that returns the seed-derived xpub for the
  // given (groupId, chainId) so tests don't depend on a real wallet manager.
  const makeStoredXpub = (entries: ReadonlyMap<string, Uint8Array>) => {
    return async (groupId: string, chainId: ChainId): Promise<Uint8Array | null> =>
      entries.get(`${groupId}:${chainId}`) ?? null
  }

  it('prefers cardano when enabled for duplicate detection', () => {
    // Cardano wins wherever it is enabled, whatever the order — it is the primary funds chain and the
    // only one of these whose xpub has a purpose beyond this comparison.
    expect(getDetectionChain([ETHEREUM_MAINNET, CARDANO_MAINNET])).toBe(CARDANO_MAINNET)
    expect(getDetectionChain([CARDANO_MAINNET, MIDNIGHT_MAINNET])).toBe(CARDANO_MAINNET)
    // ⚠️ Not Midnight any more. Preferring it was a fossil of the Midnight-only shell, and it kept the
    // one xpub nothing else needs load-bearing — see the note on `getDetectionChain`.
    expect(getDetectionChain([ETHEREUM_MAINNET, MIDNIGHT_MAINNET])).toBe(ETHEREUM_MAINNET)
    expect(getDetectionChain([])).toBeNull()
  })

  it('finds an existing wallet by stored xpub', async () => {
    const xpub = await Effect.runPromise(deriveAccountXPub(mnemonic, MIDNIGHT_MAINNET, 0))

    const existing = await findExistingWalletForMnemonic({
      mnemonic,
      enabledChains: [MIDNIGHT_MAINNET],
      wallets: [
        {
          groupId: 'group-1' as never,
          name: 'Existing Wallet',
          implementation: 'cip1852',
          chainId: MIDNIGHT_MAINNET,
          createdAt: new Date(),
          source: 'mnemonic',
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
          // Intentionally no checksum — the legacy case where the
          // retroactive checksum-attachment loop hasn't completed yet but the
          // wallet still has a stored xpub. Detection must work regardless.
        },
      ],
      getStoredXpub: makeStoredXpub(new Map([[`group-1:${MIDNIGHT_MAINNET}`, xpub]])),
    })

    expect(existing?.groupId).toBe('group-1')
  })

  it('returns null when no candidate has a matching xpub', async () => {
    const otherXpub = new Uint8Array(64).fill(0xff)

    const existing = await findExistingWalletForMnemonic({
      mnemonic,
      enabledChains: [MIDNIGHT_MAINNET],
      wallets: [
        {
          groupId: 'group-1' as never,
          name: 'Different Wallet',
          implementation: 'cip1852',
          chainId: MIDNIGHT_MAINNET,
          createdAt: new Date(),
          source: 'mnemonic',
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
        },
      ],
      getStoredXpub: makeStoredXpub(new Map([[`group-1:${MIDNIGHT_MAINNET}`, otherXpub]])),
    })

    expect(existing).toBeNull()
  })

  it('skips read-only candidates', async () => {
    const xpub = await Effect.runPromise(deriveAccountXPub(mnemonic, MIDNIGHT_MAINNET, 0))

    const existing = await findExistingWalletForMnemonic({
      mnemonic,
      enabledChains: [MIDNIGHT_MAINNET],
      wallets: [
        {
          groupId: 'group-1' as never,
          name: 'Read Only',
          implementation: 'cip1852',
          chainId: MIDNIGHT_MAINNET,
          createdAt: new Date(),
          source: 'read-only',
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
        },
      ],
      getStoredXpub: makeStoredXpub(new Map([[`group-1:${MIDNIGHT_MAINNET}`, xpub]])),
    })

    expect(existing).toBeNull()
  })

  it('skips hardware candidates so a seed import never severs device pairing', async () => {
    const xpub = await Effect.runPromise(deriveAccountXPub(mnemonic, MIDNIGHT_MAINNET, 0))

    const existing = await findExistingWalletForMnemonic({
      mnemonic,
      enabledChains: [MIDNIGHT_MAINNET],
      wallets: [
        {
          groupId: 'group-1' as never,
          name: 'Hardware Wallet',
          implementation: 'cip1852',
          chainId: MIDNIGHT_MAINNET,
          createdAt: new Date(),
          source: 'hardware',
          isHardware: true,
          hardwareDeviceType: 'hw-vendor',
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
        },
      ],
      getStoredXpub: makeStoredXpub(new Map([[`group-1:${MIDNIGHT_MAINNET}`, xpub]])),
    })

    expect(existing).toBeNull()
  })
})
