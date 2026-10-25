/**
 * The selected funds group's Midnight holdings, as portfolio rows for the shared asset list.
 *
 * Joins the two rails — the unshielded subscription and the shielded wallet state — into the one row shape
 * both asset surfaces already render, so a Midnight holding sits beside a Cardano one under a network
 * badge instead of on a screen of its own.
 *
 * ⚠️ A wallet with no Midnight address — hardware, read-only, shared — yields no rows at all, which is
 * the ordinary answer for it rather than a failure.
 *
 * @module
 */

import {useEffect, useMemo} from 'react'

import {logger} from '../logger'
import {useI18n} from '../providers'
import type {PortfolioAsset} from '../services/cardano-assets/portfolio'
import {midnightPortfolioAssets} from '../services/midnight/wallet/midnight-portfolio'
import {useMidnightShieldedBalance} from './useMidnightShieldedBalance'
import {useMidnightUnshieldedAddress} from './useMidnightUnshieldedAddress'
import {useMidnightUnshieldedBalance} from './useMidnightUnshieldedBalance'

const ORIGIN = 'midnight-assets'

export type MidnightAssetsState = {
  readonly assets: readonly PortfolioAsset[]
  /** True while either rail is still resolving, so a caller can hold a spinner rather than show nothing. */
  readonly loading: boolean
  /** Re-read the unshielded rail. Needs no key material, so a screen may call it on focus. */
  readonly refresh: () => Promise<void>
}

export const useMidnightAssets = (): MidnightAssetsState => {
  const {t} = useI18n()
  const unshieldedAddress = useMidnightUnshieldedAddress()
  const shielded = useMidnightShieldedBalance()
  const unshielded = useMidnightUnshieldedBalance(unshieldedAddress)

  // Read the chain as soon as the address is known. This rail needs no key material and shows no prompt,
  // so it does not wait to be asked — and nothing else would ask: a fresh wallet has no cache, so without
  // this the list would sit empty until some other surface happened to sync.
  useEffect(() => {
    if (unshieldedAddress === undefined) return
    void unshielded.refresh()
  }, [unshieldedAddress, unshielded.refresh])

  const assets = useMemo(
    () =>
      midnightPortfolioAssets({
        unshieldedTotals: unshielded.totals,
        shieldedBalances: shielded.balances,
        labels: {unshielded: t('receive.midnightUnshielded'), shielded: t('receive.midnightShielded')},
      }),
    [shielded.balances, t, unshielded.totals],
  )

  // A row count, once per change. "No Midnight rows" has three very different causes — no address, an
  // unread rail, or a genuinely empty wallet — and they are indistinguishable on screen.
  useEffect(() => {
    logger.debug('midnight assets', {
      origin: ORIGIN,
      address: unshieldedAddress === undefined ? 'none' : 'present',
      unshieldedTokens: unshielded.totals?.size ?? null,
      shieldedTokens: shielded.balances?.length ?? null,
      rows: assets.length,
    })
  }, [assets.length, shielded.balances?.length, unshielded.totals?.size, unshieldedAddress])

  return {assets, loading: shielded.loading || unshielded.syncing, refresh: unshielded.refresh}
}
