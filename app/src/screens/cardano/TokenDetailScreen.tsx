/**
 * Token detail — tapped from the portfolio list. Shows the asset's icon, label,
 * held balance (+ fiat), a small info card (verified status, policy id, decimals)
 * and its Activity: the wallet history filtered to transactions that move this
 * token. ADA has no policy id and its activity is the full history (every tx
 * moves ADA for fees).
 *
 * @module
 */

import {useLocalSearchParams, useRouter} from 'expo-router'
import {useMemo} from 'react'
import {FlatList, Linking, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AssetMedia} from '../../components/AssetMedia'
import {Button} from '../../components/Buttons'
import {Card} from '../../components/Card'
import {AssetPriceChart} from '../../components/chart/PortfolioValueChart'
import {DataRow} from '../../components/Row'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {SensitiveTypography} from '../../components/SensitiveTypography'
import {Tag} from '../../components/Tag'
import {TokenIcon} from '../../components/TokenIcon'
import {Typography} from '../../components/Typography'
import {useCardanoPortfolio} from '../../hooks/useCardanoPortfolio'
import {chartAssetFor} from '../../hooks/useCardanoPortfolioHistory'
import {useCardanoTokenHistory} from '../../hooks/useCardanoTokenHistory'
import {useExplorerPreference} from '../../hooks/useExplorerPreference'
import {useFeatureFlag} from '../../hooks/useFeatureFlag'
import {useNetworkCapabilities} from '../../hooks/useNetworkCapabilities'
import {useProgrammableHoldings} from '../../hooks/useProgrammableHoldings'
import {useVerifiedTokens} from '../../hooks/useVerifiedTokens'
import {useConfig, useFormat, useI18n} from '../../providers'
import {withProgrammable} from '../../services/cardano/cip113/programmable-rows'
import {ADA_ASSET_IDS, adaTokenInfo, displayDecimals} from '../../services/cardano-assets'
import {useAssetDetailInfo, useTokenInfos} from '../../services/cardano-assets/hooks'
import {tokenDisplayNames} from '../../services/cardano-assets/token-display'
import {isVerifiedId} from '../../services/cardano-assets/verified-tokens'
import {truncateCompact} from '../../utils/truncate'
import {HistoryRow} from './HistoryScreen'

const ADA_DECIMALS = 6

export const TokenDetailScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker, priceHistory} = useNetworkCapabilities()
  const router = useRouter()
  const {currency, network} = useConfig()
  const {getTokenUrl} = useExplorerPreference()
  const {id} = useLocalSearchParams<{id?: string}>()
  const assetId = id === undefined || id === 'ada' ? '' : decodeURIComponent(id)
  const isAda = ADA_ASSET_IDS.has(assetId)

  const {infos} = useTokenInfos(isAda ? [] : [assetId])
  const baseInfo = isAda ? adaTokenInfo(network) : infos.get(assetId)
  // Detail-only: one `/asset_info` call for this asset, for its media and the
  // NFT answer that a DEX listing cannot give.
  const info = useAssetDetailInfo(isAda ? '' : assetId, baseInfo)
  const {assets: ownAssets} = useCardanoPortfolio()
  // ⚠️ Programmable holdings are NOT in the portfolio's own list — they live at the deployment's
  // smart wallet, an address this wallet never derives. The two list screens that can reach this
  // one both merge them, so without the same merge here a CIP-113 token could be tapped from the
  // list and then render `0`: the lookup missed, and `?? 0n` reported that as "you hold none".
  const programmable = useProgrammableHoldings()
  const assets = useMemo(() => withProgrammable(ownAssets, programmable), [ownAssets, programmable])
  const {verifiedIds} = useVerifiedTokens()
  // Full local history filtered to this token (ADA keeps everything) — all
  // persisted, no paging or network.
  const {txs, loading} = useCardanoTokenHistory(assetId, isAda)

  const asset = useMemo(() => assets.find((a) => a.id === assetId || (isAda && a.isAda)), [assets, assetId, isAda])
  const isNft = info?.isNft === true
  // The portfolio row's label normally wins (it is the same resolution the list
  // shows, so the heading matches what was tapped) — except for an NFT, where the
  // enriched on-chain name beats the DEX ticker the list had to settle for.
  const label =
    (isNft ? info?.label : undefined) ?? asset?.label ?? info?.label ?? (isAda ? adaTicker : assetId.slice(0, 12))
  const decimals = asset?.decimals ?? info?.decimals ?? (isAda ? ADA_DECIMALS : null)
  const quantity = asset?.quantity ?? 0n
  const fiatValue = asset?.fiatValue ?? null
  const verified = isVerifiedId(verifiedIds, assetId)
  const policyId: string | null = isAda ? null : (assetId.split('.')[0] ?? '')
  const chartEnabled = useFeatureFlag('portfolioChart')
  const fullName = tokenDisplayNames(info).secondary
  const hasMedia = info?.image !== undefined
  // Any asset with a resolvable unit and no media of its own gets a price chart
  // (ADA via Kraken, tokens via SteelSwap token→ADA).
  const chartAsset = hasMedia ? null : chartAssetFor(assetId, isAda)
  // Null for ADA (no token page) and for an id we cannot fingerprint.
  const explorerUrl = isAda ? null : getTokenUrl(assetId)

  const openDetail = (hash: string) => router.push(`/wallet/tx/${hash}` as never)

  const header = (
    <View style={styles.headerWrap}>
      <View style={styles.hero}>
        {/* The thumbnail only stands in for an image; when the asset's own media
            renders right below, it is the same picture twice. */}
        {hasMedia ? null : <TokenIcon assetId={assetId} label={label} size={56} />}
        <View style={styles.heroText}>
          <View style={styles.titleRow}>
            <Typography variant="headingMd">{label}</Typography>
            <Tag
              size="sm"
              label={verified ? t('cardanoPortfolio.verified') : t('cardanoPortfolio.unverified')}
              variant={verified ? 'success' : 'secondary'}
            />
          </View>
          {/* The fuller name, when the heading is a ticker that does not say it. */}
          {fullName !== undefined ? (
            <Typography variant="bodySm_regular" style={styles.fiat}>
              {fullName}
            </Typography>
          ) : null}
          {/* A held NFT is one of one, so "1 Lil Sappys #942" only repeats the
              heading. The count is shown when it is actually information: more than
              one unit, which means a fractional (444) or an oddly-minted asset. */}
          {isNft && quantity === 1n ? null : (
            <SensitiveTypography variant="bodyLg_semibold" style={styles.balance}>
              {format(quantity, {
                preset: 'cryptoBalance',
                ...(isNft ? {} : {currency: label}),
                decimals: displayDecimals(decimals),
              })}
            </SensitiveTypography>
          )}
          {fiatValue !== null ? (
            <SensitiveTypography variant="bodySm_regular" style={styles.fiat}>
              {format(fiatValue, {preset: 'fiatBalance', currency})}
            </SensitiveTypography>
          ) : null}
        </View>
      </View>

      {/* Media, when the asset declares any — a collectible's picture is the point
          of it, whether or not it happens to be one-of-one. The chart is for assets
          that have a market instead. */}
      {hasMedia ? (
        <AssetMedia image={info?.image} testID="token-media" />
      ) : chartEnabled && priceHistory && chartAsset !== null ? (
        <AssetPriceChart asset={chartAsset} />
      ) : null}

      {policyId !== null ? (
        <Card style={styles.infoCard}>
          <DataRow label={t('cardanoPortfolio.policyId')} value={truncateCompact(policyId)} />
          {/* An NFT's "0" is implied by its CIP-68 class, not read from data, so the
              row carries nothing. Otherwise: "0" would be a claim; an unstated scale
              is stated as unknown. */}
          {isNft ? null : (
            <DataRow
              label={t('cardanoPortfolio.decimalsLabel')}
              value={decimals === null ? t('cardanoPortfolio.decimalsUnknown') : String(decimals)}
            />
          )}
          {explorerUrl !== null ? (
            <Button
              variant="nakedDefault"
              size="sm"
              label={t('cardanoActivity.viewOnExplorer')}
              rightIcon="arrowUpRight"
              onPress={() => Linking.openURL(explorerUrl)}
              testID="token-explorer-link"
            />
          ) : null}
        </Card>
      ) : null}

      <View style={styles.activityHeader}>
        <SectionHeader title={t('cardanoPortfolio.activity')} />
      </View>
    </View>
  )

  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
      <FlatList
        data={txs}
        style={styles.list}
        keyExtractor={(tx, i) => tx.hash ?? String(i)}
        ListHeaderComponent={header}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({item, index}) => (
          <HistoryRow
            tx={item}
            onPress={() => item.hash !== undefined && openDetail(item.hash)}
            isFirst={index === 0}
            isLast={index === txs.length - 1}
          />
        )}
        ListEmptyComponent={
          loading ? null : (
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('cardanoPortfolio.noActivity')}
            </Typography>
          )
        }
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {flex: 1, padding: spacing.spacing16},
  list: {flex: 1},
  headerWrap: {gap: spacing.spacing16, paddingBottom: spacing.spacing8},
  hero: {alignItems: 'center', gap: spacing.spacing8, paddingTop: spacing.spacing8},
  heroText: {alignItems: 'center', gap: spacing.spacing4},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
  balance: {color: colors.textDefault},
  fiat: {color: colors.textAlternative},
  infoCard: {padding: spacing.spacing16, gap: spacing.spacing8},
  activityHeader: {paddingTop: spacing.spacing8},
  muted: {color: colors.textAlternative, paddingVertical: spacing.spacing8},
}))
