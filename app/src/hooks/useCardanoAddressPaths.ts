/**
 * `bech32 → CIP-1852 derivation path` for the active wallet group's Cardano
 * addresses, read from the persisted address rows (the same partition
 * {@link useCardanoRail} seeds itself from). Lets a screen holding only
 * addresses — a UTxO list, a review row — say which of ours it is looking at.
 *
 * Empty until the rows load, and for any address that is not ours.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {useWalletData, useWalletList} from '../providers'
import {derivationPathsByAddress} from '../services/cardano/address-paths'

const EMPTY: ReadonlyMap<string, string> = new Map()

export const useCardanoAddressPaths = (): ReadonlyMap<string, string> => {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {listAddressesForWallet} = useWalletData()
  const groupId = selectedWalletGroup?.groupId ?? null
  const [paths, setPaths] = useState<ReadonlyMap<string, string>>(EMPTY)

  useEffect(() => {
    if (groupId === null) {
      setPaths(EMPTY)
      return
    }
    let active = true
    void listAddressesForWallet(groupId, CARDANO_MAINNET, {accountIndex: selectedAccountIndex})
      .then((rows) => {
        if (active) setPaths(derivationPathsByAddress(rows))
      })
      .catch((e) => {
        logger.warn('Address path read failed; paths render empty', {
          origin: 'useCardanoAddressPaths',
          groupId,
          error: String(e),
        })
        if (active) setPaths(EMPTY)
      })
    return () => {
      active = false
    }
  }, [groupId, selectedAccountIndex, listAddressesForWallet])

  return paths
}
