/**
 * The selected funds group's unshielded Midnight address, from the address table.
 *
 * The `single`/0 slot, persisted at create/restore (`MIDNIGHT_RECEIVE_ADDRESS_SLOTS.night`). Read here
 * rather than in each screen so the unshielded rail has one way to find its address — and so the failure
 * is reported once, in one place.
 *
 * ⚠️ Only seed-backed wallets have one. Hardware, read-only and shared wallets never derived Midnight
 * addresses, so `undefined` is the ordinary answer for them, not a fault.
 *
 * @module
 */

import {MIDNIGHT_MAINNET} from '@pnyx/config'
import {useEffect, useState} from 'react'

import {logger} from '../logger'
import {useWalletAddress, useWalletList} from '../providers'
import {addressForGroup, type ResolvedAddress} from './midnight-unshielded-address'

// Re-exported so callers keep one import site while the rule stays testable — the hook itself reaches
// `../providers`, which pulls in expo-router and cannot load under vitest.
export {addressForGroup, type ResolvedAddress} from './midnight-unshielded-address'

const ORIGIN = 'midnight-unshielded-address'

/** The night-slot address, or `undefined` while unknown / for a wallet that has none. */
export const useMidnightUnshieldedAddress = (): string | undefined => {
  const {getReceiveAddress} = useWalletAddress()
  const {selectedWalletGroup} = useWalletList()
  const groupId = selectedWalletGroup?.groupId
  const primary = selectedWalletGroup?.primaryWallet
  const seedBacked =
    primary !== undefined &&
    primary.isHardware !== true &&
    primary.implementation !== 'readOnly' &&
    primary.source !== 'multisig'
  /**
   * ⚠️ **Stamped with the group it was read for.** Holding a bare address meant that on a wallet
   * *switch* — as opposed to a deselect — this kept returning the previous wallet's address until the
   * async read resolved, while `groupId` had already moved. Every consumer pairs the two, and the
   * unshielded one-shot writes its cache by `groupId`: so wallet A's UTxO set was written under wallet
   * B's key. Observed on device, switching Abandon 12 → Pnyx sponsor, as 8 UTxOs and 38 activity rows
   * landing under the sponsor's group. The stamp makes the stale pairing unrepresentable — during the
   * gap this answers `undefined`, which every caller already treats as "not known yet".
   */
  const [resolved, setResolved] = useState<ResolvedAddress | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    if (groupId === undefined || !seedBacked) {
      setResolved(undefined)
      return
    }
    void (async () => {
      // The group is passed explicitly: a wallet the app knows about is not necessarily one the service
      // has been told to *select*, and relying on that selection is what made this read fail silently on
      // the Receive screen.
      const next = await getReceiveAddress({groupId, chainId: MIDNIGHT_MAINNET, addressIndex: 0}).catch(
        (error: unknown) => {
          logger.warn('unshielded Midnight address unavailable', {origin: ORIGIN, groupId, error: String(error)})
          return undefined
        },
      )
      if (!cancelled) setResolved({groupId, address: next})
    })()
    return () => {
      cancelled = true
    }
  }, [getReceiveAddress, groupId, seedBacked])

  return addressForGroup(resolved, groupId)
}
