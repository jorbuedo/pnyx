/**
 * Permits held across every wallet on this device, for the name storefront.
 *
 * Enumerates through {@link enabledAccountsOn} rather than its own loop, so this and the background
 * sync scheduler cannot drift into two different ideas of "every wallet" — and so neither of them
 * pins account 0.
 *
 * Reads caches, not the chain: {@link readPermitBalances} says why, and what an unsynced wallet
 * reports instead of zero.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {Effect, Either} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {midnightPaymentAddress} from '../config/env'
import {logger} from '../logger'
import {useWalletList} from '../providers/WalletProvider'
import {isMidnightChainId} from '../services/midnight/scheduled-sync'
import {type PermitBalances, type PermitWallet, readPermitBalances} from '../services/permit-balances'

const ORIGIN = 'usePermitBalances'

export type PermitBalancesState =
  /** Still reading, or no read attempted yet. */
  | {readonly kind: 'loading'}
  /** This build has no payment contract, so there is no namespace and no permit to hold. */
  | {readonly kind: 'no-namespace'}
  | {readonly kind: 'balances'; readonly balances: PermitBalances}

/**
 * Permits per wallet, plus a `refresh` for a pull-to-refresh gesture.
 *
 * The wallet list is read from the group store, so a wallet added while this screen is open appears on
 * the next refresh rather than never.
 */
export const usePermitBalances = (): {
  readonly state: PermitBalancesState
  readonly refresh: () => void
} => {
  const {allWallets} = useWalletList()
  const [state, setState] = useState<PermitBalancesState>({kind: 'loading'})
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the re-run key `refresh` bumps; it is deliberately unread inside.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const payment = midnightPaymentAddress()
      if (payment === undefined) {
        logger.debug('no payment contract configured, so no wallet can hold a permit', {origin: ORIGIN})
        if (!cancelled) setState({kind: 'no-namespace'})
        return
      }
      // `allWallets` is the provider's documented cross-group surface, and each entry already carries
      // its own `accounts`. ⚠️ Every *enabled* account, never index 0: a permit sits in one account,
      // and a pinned index reports the wrong one with nothing failing.
      const wallets: PermitWallet[] = allWallets
        .filter((wallet) => isMidnightChainId(wallet.chainId))
        .flatMap((wallet) =>
          wallet.accounts
            .filter((account) => account.enabled)
            .map((account) => ({
              groupId: String(wallet.groupId),
              accountIndex: account.index,
              label: wallet.name,
            })),
        )
      if (wallets.length === 0) {
        logger.debug('no wallet on this device has a Midnight account, so there is nowhere to hold a permit', {
          origin: ORIGIN,
        })
      }

      // A misconfigured address is a build fault, not an empty wallet — `no-namespace` would claim the
      // build has no namespace, which is a different and wrong statement.
      const decoded = hex.decode(payment)
      if (Either.isLeft(decoded) || decoded.right.length !== 32) {
        logger.error('the configured payment address is not 32 bytes of hex, so no permit colour exists', {
          origin: ORIGIN,
        })
        if (!cancelled) setState({kind: 'balances', balances: {wallets: [], totalByTier: new Map(), incomplete: true}})
        return
      }

      const balances = await Effect.runPromise(readPermitBalances(wallets, decoded.right))
      if (!cancelled) setState({kind: 'balances', balances})
    })()
    return () => {
      cancelled = true
    }
  }, [allWallets, nonce])

  return {state, refresh}
}
