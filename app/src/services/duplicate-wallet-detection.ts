import {CARDANO_MAINNET, type ChainId} from '@pnyx/config'
import {type ChainWallet, deriveAccountXPub} from '@pnyx/wallet'
import {Effect} from 'effect'
import {logger} from '../logger'
import {spendingAuthorityOf} from './cardano/multisig'
import {signerKindOf, signsAlone} from './cardano/signer-kind'

/**
 * Resolve the stored account-level xpub for a `(groupId, chainId)` pair.
 *
 * Returns the raw `publicKey | chainCode` bytes the wallet-manager persists
 * at import time, or `null` when no xpub is on file (read-only-only group,
 * or chain hasn't been derived yet).
 *
 * Used by the duplicate-detection helpers below so they don't depend on
 * `wallet.checksum`, which is attached asynchronously after first load and
 * can lag behind the React-state wallet list during extension popup
 * cold-open. Comparing stored xpub bytes directly is race-free.
 */
export type GetStoredXpub = (groupId: string, chainId: ChainId) => Promise<Uint8Array | null>

type WalletDuplicateDetectionParams = {
  mnemonic: string
  wallets: readonly ChainWallet[]
  enabledChains: readonly ChainId[]
  getStoredXpub: GetStoredXpub
}

type XPubDuplicateDetectionParams = {
  publicKey: Uint8Array
  chainCode: Uint8Array
  chainId: ChainId
  wallets: readonly ChainWallet[]
  getStoredXpub: GetStoredXpub
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Which chain's account xpub identifies a seed.
 *
 * **Cardano**, because it is the primary funds chain: `FUNDS_CHAINS` creates every group with it, and
 * its account xpub has to be stored anyway for multisig rosters, hardware pairing and air-gap export.
 *
 * ⚠️ **This used to prefer Midnight, and that was a fossil, not a decision.** It dates from the initial
 * commit, when the app was a Midnight-only identity wallet and Cardano did not exist in it. Midnight's
 * xpub is incidental parity — nothing derives from it, because Midnight addresses come from role
 * *secret* keys and no xpub-only path exists. Preferring it meant the one chain whose xpub has no other
 * purpose was the only thing keeping it load-bearing.
 *
 * The fallback stays positional but is now only reached when Cardano is disabled, where any answer is a
 * guess; before this it could pick EVM ahead of Cardano purely on array order.
 */
export function getDetectionChain(enabledChains: readonly ChainId[]): ChainId | null {
  if (enabledChains.length === 0) return null
  const chainId = enabledChains.includes(CARDANO_MAINNET) ? CARDANO_MAINNET : (enabledChains[0] ?? null)
  logger.info('Selected chain for wallet duplicate detection', {
    origin: 'wallet-duplicate-detection',
    enabledChains,
    chainId,
  })
  return chainId
}

const fetchStoredXpub = async (
  getStoredXpub: GetStoredXpub,
  groupId: string,
  chainId: ChainId,
): Promise<Uint8Array | null> => {
  try {
    return await getStoredXpub(groupId, chainId)
  } catch (e) {
    logger.debug('No stored xpub for candidate; treating as non-match', {
      origin: 'wallet-duplicate-detection',
      groupId,
      chainId,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/**
 * Find an existing wallet whose stored account-0 xpub matches the one
 * derived from the supplied mnemonic.
 *
 * Compares xpub bytes directly rather than `wallet.checksum?.seed` — the
 * checksum is attached asynchronously after first load (see
 * `WalletProvider.attachChecksumAndProfile` retroactive loop), and the
 * extension popup can navigate into the activation flow before that loop
 * completes. Filtering on `wallet.checksum != null` would silently exclude
 * the legacy group and the upgrade-in-place delete branch in
 * `preparing.tsx` would never fire — the surfaced onboarding-hang symptom.
 */
export async function findExistingWalletForMnemonic({
  mnemonic,
  wallets,
  enabledChains,
  getStoredXpub,
}: WalletDuplicateDetectionParams): Promise<ChainWallet | null> {
  const chainId = getDetectionChain(enabledChains)
  if (!chainId) {
    logger.info('Skipping wallet duplicate detection because no chain is enabled', {
      origin: 'wallet-duplicate-detection',
    })
    return null
  }

  // Exclude `read-only` (intentional watch-only, distinct mode) and `hardware`
  // (device-paired groups — replacing them with a seed-based group would silently
  // sever the device pairing).
  // Only wallets that hold a key of their own can duplicate a seed. A script
  // wallet has no xpub to compare — it is defined by other people's keys.
  const candidates = wallets.filter(
    (wallet) => wallet.chainId === chainId && signsAlone(signerKindOf(wallet.source)) && wallet.source !== 'hardware',
  )
  if (candidates.length === 0) {
    logger.info('No candidate wallets for duplicate detection', {
      origin: 'wallet-duplicate-detection',
      chainId,
      walletCount: wallets.length,
    })
    return null
  }

  const derivedXpub = await Effect.runPromise(deriveAccountXPub(mnemonic, chainId, 0))

  for (const candidate of candidates) {
    const storedXpub = await fetchStoredXpub(getStoredXpub, candidate.groupId, candidate.chainId)
    if (storedXpub && bytesEqual(storedXpub, derivedXpub)) {
      logger.info('Completed wallet duplicate detection', {
        origin: 'wallet-duplicate-detection',
        chainId,
        comparedWalletCount: candidates.length,
        foundMatch: true,
        existingWalletId: candidate.groupId,
      })
      return candidate
    }
  }

  logger.info('Completed wallet duplicate detection', {
    origin: 'wallet-duplicate-detection',
    chainId,
    comparedWalletCount: candidates.length,
    foundMatch: false,
  })
  return null
}

/**
 * Find an existing wallet whose stored account-0 xpub for `chainId` matches
 * the supplied `(publicKey, chainCode)` pair (e.g. derived from a hardware
 * device on import).
 *
 * Same race-free shape as `findExistingWalletForMnemonic` — compares stored
 * xpub bytes directly instead of relying on the asynchronously-attached
 * `wallet.checksum`.
 */
export async function findExistingWalletForXPub({
  publicKey,
  chainCode,
  chainId,
  wallets,
  getStoredXpub,
}: XPubDuplicateDetectionParams): Promise<ChainWallet | null> {
  const candidates = wallets.filter(
    (wallet) => wallet.chainId === chainId && spendingAuthorityOf(wallet.source) === 'key',
  )
  if (candidates.length === 0) {
    logger.info('No candidate wallets for hardware duplicate detection', {
      origin: 'wallet-duplicate-detection',
      chainId,
      walletCount: wallets.length,
    })
    return null
  }

  // wallet-manager stores xpubs as publicKey | chainCode concatenated
  const targetXpub = new Uint8Array(publicKey.length + chainCode.length)
  targetXpub.set(publicKey, 0)
  targetXpub.set(chainCode, publicKey.length)

  for (const candidate of candidates) {
    const storedXpub = await fetchStoredXpub(getStoredXpub, candidate.groupId, candidate.chainId)
    if (storedXpub && bytesEqual(storedXpub, targetXpub)) {
      logger.info('Completed hardware wallet duplicate detection', {
        origin: 'wallet-duplicate-detection',
        chainId,
        comparedWalletCount: candidates.length,
        foundMatch: true,
        existingWalletGroupId: candidate.groupId,
      })
      return candidate
    }
  }

  logger.info('Completed hardware wallet duplicate detection', {
    origin: 'wallet-duplicate-detection',
    chainId,
    comparedWalletCount: candidates.length,
    foundMatch: false,
  })
  return null
}
