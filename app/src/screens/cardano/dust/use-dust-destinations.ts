/**
 * The DUST destinations this user can pick from, and the names to show for them.
 *
 * Every wallet in the app has its own derived `mn_dust` address, so "send my DUST to my
 * other wallet" needs no typing. Pnyx's address joins the list when this build has one
 * configured — and is simply absent otherwise, rather than appearing as a dead option.
 *
 * @module
 */

import {MIDNIGHT_MAINNET} from '@pnyx/config'
import {decodeDustAddressPayload} from '@pnyx/wallet'
import {useEffect, useState} from 'react'
import {logger} from '../../../logger'
import {useWalletAddress, useWalletList} from '../../../providers'
import {type DestinationChoice, pnyxDustAddress} from '../../../services/midnight-dust'

const DUST_ADDRESS_SLOT = 1

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** The payload inside an `mn_dust` address, or `null` when it will not decode. */
export const dustPayloadOf = (address: string): string | null => {
  try {
    return toHex(decodeDustAddressPayload(address))
  } catch (e: unknown) {
    logger.debug('DUST address payload would not decode', {
      origin: 'use-dust-destinations',
      error: String(e),
    })
    return null
  }
}

export type DustDestinationsState = {
  readonly choices: readonly DestinationChoice[]
  readonly loading: boolean
}

export const useDustDestinations = (): DustDestinationsState => {
  const {getReceiveAddress} = useWalletAddress()
  const {walletGroups, selectedWalletGroup} = useWalletList()
  const [choices, setChoices] = useState<readonly DestinationChoice[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    void (async () => {
      const out: DestinationChoice[] = []
      for (const group of walletGroups) {
        // Seed-derived, so hardware and watch-only groups have no DUST address at all.
        const wallet = group.primaryWallet
        if (wallet.isHardware === true || wallet.implementation === 'readOnly') continue
        const address = await getReceiveAddress({
          groupId: group.groupId,
          chainId: MIDNIGHT_MAINNET,
          addressIndex: DUST_ADDRESS_SLOT,
        }).catch((e) => {
          logger.warn('Dust address read failed; that wallet is not offered as a destination', {
            origin: 'useDustDestinations',
            groupId: group.groupId,
            error: String(e),
          })
          return undefined
        })
        if (address === undefined) continue
        const payload = dustPayloadOf(address)
        if (payload === null) continue
        out.push({
          payload,
          address,
          owner:
            group.groupId === selectedWalletGroup?.groupId
              ? {kind: 'self'}
              : {kind: 'ownWallet', walletName: group.name},
        })
      }

      const pnyx = pnyxDustAddress()
      if (pnyx !== null) {
        const payload = dustPayloadOf(pnyx)
        // A misconfigured donation address is dropped rather than offered: sending a user's
        // DUST generation to an address nobody controls is unrecoverable.
        if (payload !== null) out.push({payload, address: pnyx, owner: {kind: 'pnyx'}})
      }

      if (!active) return
      // One payload is one destination. Two entries for the same address would render two
      // selected radios and let the user pick the less meaningful label for it. Own wallets
      // are added first, so an address that is both mine and the donation target reads as
      // mine — which is the more useful thing to know about an address I control.
      const seen = new Set<string>()
      const deduped: DestinationChoice[] = []
      for (const choice of out) {
        if (seen.has(choice.payload)) continue
        seen.add(choice.payload)
        deduped.push(choice)
      }
      setChoices(deduped)
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [walletGroups, selectedWalletGroup, getReceiveAddress])

  return {choices, loading}
}
