/**
 * One portfolio holding row: icon · label · **7-day price sparkline** · balance
 * (+ fiat). The sparkline loads the token's 1-week series (ADA via Kraken, other
 * tokens via SteelSwap); NFTs / unpriceable assets simply render no sparkline.
 * Extracted from the list so each row can own its price-series hook.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {memo, useMemo} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AssetIcon} from '../../components/AssetIcon'
import {Sparkline} from '../../components/chart/Sparkline'
import {Row} from '../../components/Row'
import {SensitiveTypography} from '../../components/SensitiveTypography'
import {Typography} from '../../components/Typography'
import {chartAssetFor, useCardanoAssetPriceHistory} from '../../hooks/useCardanoPortfolioHistory'
import {useConfig, useFormat} from '../../providers'
import type {PortfolioAsset} from '../../services/cardano-assets/portfolio'
import {displayDecimals} from '../../services/cardano-assets/token-metadata'

export type PortfolioTokenRowProps = {
  readonly item: PortfolioAsset
  readonly withBorder: boolean
  readonly onPress: () => void
  /**
   * Shown instead of the balance. For a position that was exited the balance is `0`, which reads as a
   * broken row rather than as "you no longer hold this" — so the past-holdings section passes when it
   * was last held. The sparkline stays either way: the price history is the point of the row.
   */
  readonly note?: string | undefined
}

/**
 * ⚠️ **Memoised, and it needs stable props to be worth anything.** Every row owns a price-series
 * hook and paints a chamfer layer, so a list re-render that recreates rows repaints the whole
 * viewport. A caller passing an inline `onPress` defeats this entirely — see `PortfolioScreen`.
 */
export const PortfolioTokenRow = memo(({item, withBorder, onPress, note}: PortfolioTokenRowProps) => {
  const format = useFormat()
  const {currency} = useConfig()
  // No sparkline for a chain we have no price source for — `chartAssetFor` would build a Cardano/SteelSwap
  // series id from a Midnight asset id and fetch nothing.
  const priceable = item.chainId === undefined || item.chainId === CARDANO_MAINNET
  const chartAsset = useMemo(
    () => (item.isNft || !priceable ? null : chartAssetFor(item.id, item.isAda)),
    [item.id, item.isAda, item.isNft, priceable],
  )
  const {series} = useCardanoAssetPriceHistory(chartAsset, '1W')

  return (
    <Row
      leftContent={
        <AssetIcon
          assetId={item.id}
          label={item.label}
          chainId={item.chainId}
          isChainNative={item.isChainNative}
          {...(item.isNft ? {isNft: true} : {})}
          size={36}
          testID={`portfolio-chain-badge-${item.id}`}
        />
      }
      label={item.label}
      {...(item.subtitle !== undefined ? {subtitle: item.subtitle} : {})}
      withBorder={withBorder}
      onPress={onPress}
      testID={`portfolio-token-${item.id || 'ada'}`}
      midContent={series.length > 1 ? <Sparkline series={series} /> : undefined}
      rightContent={
        note !== undefined ? (
          <Typography variant="bodyXs_regular" style={styles.note}>
            {note}
          </Typography>
        ) : (
          <View style={styles.rowValue}>
            <SensitiveTypography variant="bodySm_medium">
              {/* The row label already names it; an NFT has no ticker to append. */}
              {format(item.quantity, {
                preset: 'cryptoBalance',
                ...(item.isNft ? {} : {currency: item.label}),
                decimals: displayDecimals(item.decimals),
              })}
            </SensitiveTypography>
            {item.fiatValue !== null && (
              <SensitiveTypography variant="bodyXs_regular" style={styles.fiat}>
                {format(item.fiatValue, {preset: 'fiatBalance', currency})}
              </SensitiveTypography>
            )}
          </View>
        )
      }
    />
  )
})

const styles = StyleSheet.create((theme) => ({
  rowValue: {alignItems: 'flex-end'},
  note: {color: theme.colors.textMuted},
  fiat: {color: theme.colors.textAlternative},
}))
