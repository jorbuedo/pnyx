/**
 * The wallet balance hero — one shared instance so the Wallets-home and the
 * Portfolio screen render the balance section identically: the fiat aggregate,
 * plus the privacy (hide-numbers) eye toggle wired to the global
 * `usePrivacyMode`. The ADA amount is deliberately NOT shown alongside it — it
 * already appears in the portfolio widget / asset list, and mixing it in caused
 * an ADA→fiat flicker on load. The loading gap is preserved rather than
 * rendering a fake 0 or an interim ADA figure.
 *
 * On a testnet there is no fiat at all, so the hero shows the **tADA balance**
 * instead — the alternative is a gap that never fills, since the fiat total is
 * permanently null there.
 *
 * Takes the portfolio values as props (rather than calling `useCardanoPortfolio`
 * itself) so a screen that already reads the hook — the Wallets home, which also
 * needs the asset list — doesn't run a second copy.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {useNetworkCapabilities} from '../hooks/useNetworkCapabilities'
import {usePrivacyMode} from '../hooks/usePrivacyMode'
import {useFormat, useI18n} from '../providers'
import {BalanceBlock} from './BalanceBlock'

/** ADA/tADA base-unit exponent. */
const ADA_DECIMALS = 6

export type WalletBalanceHeroProps = {
  readonly label: string
  /** Aggregate fiat total (active currency), or `null` when nothing is priced. */
  readonly totalFiat: {readonly value: number; readonly currency: string} | null
  /** ADA base units — the hero figure on a testnet, where there is no fiat. */
  readonly adaQuantity?: bigint | null | undefined
  readonly loading: boolean
  readonly unavailable?: boolean | undefined
  readonly unavailableText?: string | undefined
  /** Tap handler on the amount (e.g. Wallets home → open Portfolio). */
  readonly onPress?: (() => void) | undefined
  readonly testID?: string | undefined
}

export const WalletBalanceHero = ({
  label,
  totalFiat,
  adaQuantity,
  loading,
  unavailable,
  unavailableText,
  onPress,
  testID,
}: WalletBalanceHeroProps): ReactElement => {
  const {t} = useI18n()
  const format = useFormat()
  const {showFiat, adaTicker} = useNetworkCapabilities()
  const {isEnabled: isPrivate, toggle} = usePrivacyMode()

  const fiatText =
    totalFiat !== null ? format(totalFiat.value, {preset: 'fiatBalance', currency: totalFiat.currency}) : null
  const adaText =
    adaQuantity === null || adaQuantity === undefined
      ? null
      : format(adaQuantity, {preset: 'cryptoBalance', currency: adaTicker, decimals: ADA_DECIMALS})
  // `null` while loading or unresolved → BalanceBlock shows the loading gap
  // rather than a fake 0 or a transient figure.
  const amount = loading ? null : showFiat ? fiatText : adaText

  return (
    <BalanceBlock
      label={label}
      amount={amount}
      unavailable={unavailable}
      unavailableText={unavailableText}
      onPress={onPress}
      onTogglePrivacy={toggle}
      togglePrivacyLabel={t(isPrivate ? 'wallets.showBalance' : 'wallets.hideBalance')}
      togglePrivacyTestID="balance-privacy-toggle"
      testID={testID}
    />
  )
}
