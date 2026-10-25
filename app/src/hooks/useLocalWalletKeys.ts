/**
 * Every wallet on this device, with the payment key hashes it controls.
 *
 * Shared by the two surfaces that have to answer "is this transaction waiting on me?" — the
 * co-sign screen, which offers the signature, and the pending inbox, which has to list the
 * transaction in the first place. One lookup, because they must agree: an inbox that says a
 * transaction is yours and a screen that will not sign it is worse than either alone.
 *
 * ⚠️ **`Address.inspect` parses hex, not bech32**, so the bech32 the wallet store holds is
 * converted first. Handed the bech32 directly it decodes the characters as bytes and reads a
 * header out of nonsense — silently, which here would mean no wallet ever matches.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {CARDANO_MAINNET} from '@pnyx/config'
import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {useWalletData, useWalletList} from '../providers'
import type {LocalWallet} from '../services/cardano/multiparty/local-signers'

/**
 * The payment key hash behind an address, or `null` when it has none we can use.
 *
 * A script credential is not a key hash and cannot be signed for, so it is dropped rather
 * than recorded as a hash that would never match.
 */
const paymentKeyHashOf = (bech32: string): string | null => {
  try {
    const addressHex = Effect.runSync(Address.fromBech32(Bech32(bech32)))
    const info = Address.inspect(addressHex)
    return info.paymentCredHex !== undefined && info.paymentIsScript !== true ? info.paymentCredHex : null
  } catch (e: unknown) {
    // `null` is also "this is a script address", the branch above — so an address we failed to
    // read and one we deliberately exclude are the same answer.
    logger.warn('Address could not be inspected for a payment credential', {
      origin: 'useLocalWalletKeys',
      error: String(e),
    })
    return null
  }
}

export const useLocalWalletKeys = (): readonly LocalWallet[] => {
  const {walletGroups} = useWalletList()
  const {listAddressesForWallet} = useWalletData()
  const [wallets, setWallets] = useState<readonly LocalWallet[]>([])

  useEffect(() => {
    let active = true
    void (async () => {
      const built: LocalWallet[] = []
      for (const group of walletGroups ?? []) {
        // The chain id is the address *family*, not the network — `listAddressesForWallet`
        // partitions on it and every Cardano address lives under the mainnet id here.
        const rows = await listAddressesForWallet(group.groupId, CARDANO_MAINNET).catch((e) => {
          logger.warn('Address read failed; that wallet offers no local signing keys', {
            origin: 'useLocalWalletKeys',
            groupId: group.groupId,
            error: String(e),
          })
          return []
        })
        const hashes = rows.map((row) => paymentKeyHashOf(row.human)).filter((h): h is string => h !== null)
        if (hashes.length === 0) continue
        built.push({
          groupId: group.groupId,
          name: group.name ?? group.primaryWallet?.source ?? group.groupId,
          paymentKeyHashes: hashes,
          // Read-only wallets are listed rather than filtered: they recognise a roster row
          // and can never satisfy it, and that distinction belongs to the matcher.
          canSign: group.primaryWallet?.source !== 'read-only',
          ...(group.primaryWallet?.source === undefined ? {} : {source: group.primaryWallet.source}),
        })
      }
      if (active) setWallets(built)
    })()
    return () => {
      active = false
    }
  }, [walletGroups, listAddressesForWallet])

  return wallets
}
