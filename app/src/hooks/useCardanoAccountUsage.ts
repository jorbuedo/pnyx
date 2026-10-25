/**
 * Per-account on-chain usage signal for the Manage Accounts screen.
 *
 * For each derived account, build its reward (stake) address from the stored
 * account xpub and ask the provider's `/account_addresses` surface whether the
 * stake key has ever controlled an address on-chain — the cheapest "has been
 * used" probe (a fresh account has an empty address set). Reuses the active
 * rail's provider + codec so no per-account rail is built; results are cached
 * per reward address for the session so re-mounts don't re-hit Koios.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {useWalletAddress} from '../providers'
import type {CardanoRail} from '../services/cardano'
import {addressNetworkFor, fetchAllAccountAddresses} from '../services/cardano/discovery'
import {inFlight} from '../utils/in-flight'

export type AccountUsage = 'used' | 'fresh' | 'unknown'

export type AccountInfo = {
  readonly usage: AccountUsage
  /** The account's receive (external index 0) base address, bech32. */
  readonly address: string | null
}

const usageCache = new Map<string, Promise<boolean>>()

export const useCardanoAccountUsage = (
  rail: CardanoRail | null,
  accountIndices: readonly number[],
): ReadonlyMap<number, AccountInfo> => {
  const {getDeriveOnlyAddresses} = useWalletAddress()
  const [info, setInfo] = useState<ReadonlyMap<number, AccountInfo>>(new Map())

  const indicesKey = accountIndices.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: indicesKey is the stable string proxy for accountIndices (the array identity churns per render); re-run only when the set of indices actually changes.
  useEffect(() => {
    let active = true
    const accountAddresses = rail?.chain.getAccountAddresses
    if (!rail || accountAddresses === undefined) {
      setInfo(new Map())
      return
    }
    const net = addressNetworkFor(rail.config.network)
    void (async () => {
      const next = new Map<number, AccountInfo>()
      for (const index of accountIndices) {
        try {
          const derived = await getDeriveOnlyAddresses(index)
          const base = derived.cardano
          if (base === undefined) {
            next.set(index, {usage: 'unknown', address: null})
            continue
          }
          const inspected = Address.inspect(Address.fromBech32Sync(Bech32(base)))
          if (inspected.stakeCredHex === undefined) {
            next.set(index, {usage: 'unknown', address: base})
            continue
          }
          const reward = Address.toBech32Sync(Address.rewardHex(net, inspected.stakeCredHex))
          // Same reward address, several account indices, one render pass — coalesced so the probe
          // runs once rather than once per concurrent caller.
          const used = await inFlight(usageCache, reward, async () => {
            const addrs = await Effect.runPromise(fetchAllAccountAddresses(accountAddresses, reward))
            return addrs.length > 0
          })
          next.set(index, {usage: used ? 'used' : 'fresh', address: base})
        } catch (e: unknown) {
          // `unknown` is an honest state rather than a guess — but which account could not be
          // read, and why, is not recoverable from the screen.
          logger.warn('Account usage could not be determined', {
            origin: 'useCardanoAccountUsage',
            accountIndex: index,
            error: String(e),
          })
          next.set(index, {usage: 'unknown', address: null})
        }
        if (!active) return
      }
      if (active) setInfo(next)
    })()
    return () => {
      active = false
    }
  }, [rail, indicesKey, getDeriveOnlyAddresses])

  return info
}
