/**
 * Your own wallets, as payable recipients — one entry per wallet per chain it actually has.
 *
 * Paying yourself is a real and common thing (moving funds between your own wallets, consolidating a
 * rail), and it is the one recipient nobody should have to paste. The address book had no way to
 * express it, so it lived in the clipboard.
 *
 * Which chains a wallet offers is `ownWalletChains`, not a decision here: a hardware, read-only or
 * multisig wallet never derived a Midnight address, so it gets a Cardano entry only.
 *
 * An address that fails to read is **dropped with a warning**, never rendered as an empty row — a row
 * that fills the recipient field with nothing is worse than an absent one, and the difference between
 * "this wallet has no such address" and "the read failed" has to stay visible in the log.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {useEffect, useState} from 'react'

import {logger} from '../logger'
import {useWalletAddress, useWalletList} from '../providers'
import {ownWalletChains} from '../services/send/own-wallet-chains'

const ORIGIN = 'own-wallet-recipients'

export type OwnWalletRecipient = {
  readonly groupId: string
  readonly walletName: string
  readonly chain: ChainId
  readonly address: string
}

export type OwnWalletRecipientsState = {
  readonly recipients: readonly OwnWalletRecipient[]
  readonly loading: boolean
}

export const useOwnWalletRecipients = (enabled: boolean): OwnWalletRecipientsState => {
  const {walletGroups} = useWalletList()
  const {getReceiveAddress} = useWalletAddress()
  const [recipients, setRecipients] = useState<readonly OwnWalletRecipient[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Gated: this reads an address per wallet per chain, and the sheet it feeds is usually closed.
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      const found: OwnWalletRecipient[] = []
      for (const group of walletGroups) {
        for (const chain of ownWalletChains(group)) {
          // The group is passed explicitly — a wallet the app knows about is not necessarily the one
          // the service has been told to select, and relying on that selection is what made this read
          // fail silently on the Receive screen.
          // `null` is a read that failed and has already said so; `undefined` is a row that is simply
          // not there. Distinct so the log keeps them apart — reporting one row as both "unavailable"
          // and "absent" is how a real failure gets read as an empty wallet.
          const address = await getReceiveAddress({groupId: group.groupId, chainId: chain, addressIndex: 0}).catch(
            (error: unknown) => {
              logger.warn('own-wallet address unavailable', {
                origin: ORIGIN,
                groupId: group.groupId,
                chain,
                error: String(error),
              })
              return null
            },
          )
          if (address === null) continue
          if (address === undefined || address === '') {
            logger.debug('own-wallet address absent', {origin: ORIGIN, groupId: group.groupId, chain})
            continue
          }
          found.push({groupId: group.groupId, walletName: group.name, chain, address})
        }
      }
      if (cancelled) return
      logger.debug('own-wallet recipients resolved', {origin: ORIGIN, count: found.length})
      setRecipients(found)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, walletGroups, getReceiveAddress])

  return {recipients, loading}
}
