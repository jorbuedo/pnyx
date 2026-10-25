/**
 * Which of a shared wallet's co-signers this device can sign as, resolved
 * against every local wallet's cached CIP-1854 account xpub.
 *
 * Read-only and prompt-free: the xpubs are cached beside the CIP-1852 gov keys,
 * so asking "whose signature can I give?" never opens the vault and never wakes
 * a hardware device. A wallet whose keys have not been cached yet simply does
 * not match, and the roster's own `selfGroupId` covers the one case that used to
 * be the only case.
 *
 * Not to be confused with `useLocalWalletKeys`, which answers a different
 * question with a different key material — payment key *hashes*, for matching a
 * multiparty envelope's signers.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {useWalletList} from '../providers'
import {loadCardanoGovKeys} from '../services/cardano'
import type {EnvelopeSigner} from '../services/cardano/cosign/types'
import {type LocalCoSigner, type LocalWalletKey, localCoSignersOf} from '../services/cardano/multisig/local-cosigners'
import type {SharedWallet} from '../services/cardano/multisig/types'

/**
 * Every local wallet with its cached Cardano account keys.
 *
 * Exported because the own-wallet picker needs the same answer: whether a wallet
 * can contribute a co-signer key is now a question about the cache for hardware
 * wallets, and the picker and the roster matcher disagreeing about that would
 * mean offering a wallet that cannot be added, or hiding one that can.
 */
export const useLocalCoSignerKeys = (): readonly LocalWalletKey[] => {
  const {walletGroups} = useWalletList()
  const [keys, setKeys] = useState<readonly LocalWalletKey[]>([])

  useEffect(() => {
    let active = true
    void Promise.all(
      walletGroups.map(async (group) => ({
        groupId: group.groupId,
        name: group.name ?? group.primaryWallet?.source ?? group.groupId,
        source: group.primaryWallet?.source,
        govKeys: await Effect.runPromise(loadCardanoGovKeys(group.groupId).pipe(Effect.orElseSucceed(() => null))),
      })),
    ).then((loaded) => {
      if (active) setKeys(loaded)
    })
    return () => {
      active = false
    }
  }, [walletGroups])

  return keys
}

export const useLocalCoSigners = (
  wallet: SharedWallet | null,
  signers: readonly EnvelopeSigner[],
): readonly LocalCoSigner[] => {
  const keys = useLocalCoSignerKeys()
  if (wallet === null) return []
  return localCoSignersOf(wallet, keys, signers)
}
