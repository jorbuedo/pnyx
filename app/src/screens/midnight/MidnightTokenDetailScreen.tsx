/**
 * Detail for one Midnight holding, reached by tapping its row in the asset list.
 *
 * ⚠️ **Separate from `TokenDetailScreen` on purpose.** That screen is Cardano end to end — it resolves the
 * asset from `useCardanoPortfolio`, its metadata from Cardano token infos, its activity from
 * `useCardanoTokenHistory`, and shows a verified tag, a policy id, an explorer link and a price chart.
 * A Midnight id matches none of that, which is why tapping a NIGHT row produced a screen with the wrong
 * icon, the wrong name and no transactions. Threading a second chain through those branches would have
 * made both paths harder to read than two screens are.
 *
 * What is deliberately *not* here: no verified tag (no registry exists to verify against), no fiat and no
 * price chart (no price source — an absence stated, not a zero), and **no Send button**. Sending is the
 * wallet's Send action, which opens one funnel for every rail and takes the rail from the recipient's
 * address; a per-asset button here would be a second door to the same screen, and Cardano's asset detail
 * has never had one.
 *
 * The unshielded rail *does* get an explorer link — an address is public there, so there is something to
 * link to. The shielded rail has no address and gets none.
 *
 * @module
 */

import {MIDNIGHT_MAINNET} from '@pnyx/config'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useMemo} from 'react'
import {FlatList, Linking, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {AssetIcon} from '../../components/AssetIcon'
import {Button} from '../../components/Buttons'
import {Card} from '../../components/Card'
import {DataRow} from '../../components/Row'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {SensitiveTypography} from '../../components/SensitiveTypography'
import {Typography} from '../../components/Typography'
import {useMidnightActivity} from '../../hooks/useMidnightActivity'
import {useMidnightAssets} from '../../hooks/useMidnightAssets'
import {useConfig, useFormat, useI18n} from '../../providers'
import {midnightExplorerAddressUrl} from '../../services/midnight/explorer'
import {midnightFundsNetwork} from '../../services/midnight/networks'
import {parseMidnightAssetId} from '../../services/midnight/wallet/midnight-asset-id'
import {NIGHT_DISPLAY_DECIMALS} from '../../services/midnight/wallet/midnight-portfolio'
import {midnightTokenActivity} from '../../services/midnight/wallet/midnight-token-activity'
import {truncateCompact} from '../../utils/truncate'
import {MidnightActivityRow} from '../cardano/HistoryScreen'

export const MidnightTokenDetailScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {network} = useConfig()
  const format = useFormat()
  const {id} = useLocalSearchParams<{id?: string}>()
  const assetId = id === undefined ? '' : decodeURIComponent(id)
  const ref = useMemo(() => parseMidnightAssetId(assetId), [assetId])

  const {assets} = useMidnightAssets()
  const activity = useMidnightActivity()
  const asset = useMemo(() => assets.find((a) => a.id === assetId), [assets, assetId])

  const railLabel = ref?.rail === 'shielded' ? t('receive.midnightShielded') : t('receive.midnightUnshielded')
  /** A token type worth printing: the chain-native one is 32 zero bytes and identifies nothing. */
  const showTokenType = asset?.isChainNative !== true
  // The label the list showed, so the heading matches what was tapped. Falling back to the id keeps the
  // screen honest for a holding that has since gone to zero (no row to read a label from).
  const label = asset?.label ?? (ref === null ? assetId : truncateCompact(ref.tokenType))
  const quantity = asset?.quantity ?? null

  const explorerUrl =
    ref?.rail === 'unshielded' && activity.address !== undefined
      ? midnightExplorerAddressUrl(midnightFundsNetwork(network), activity.address)
      : null

  const section = midnightTokenActivity({
    rail: ref?.rail ?? 'unshielded',
    tokenType: ref?.tokenType ?? '',
    items: activity.items,
  })

  const header = (
    <View style={styles.headerWrap}>
      <View style={styles.hero}>
        <AssetIcon
          assetId={assetId}
          label={label}
          chainId={MIDNIGHT_MAINNET}
          isChainNative={asset?.isChainNative}
          size={56}
          testID="midnight-token-icon"
        />
        <View style={styles.heroText}>
          <Typography variant="headingMd">{label}</Typography>
          <Typography variant="bodySm_regular" style={styles.muted}>
            {railLabel}
          </Typography>
          {/* Absent, not zero: a holding we have not read is not a holding of nothing. */}
          {quantity !== null ? (
            <SensitiveTypography variant="bodyLg_semibold">
              {format(quantity, {
                preset: 'cryptoBalance',
                currency: label,
                decimals: asset?.decimals ?? NIGHT_DISPLAY_DECIMALS,
              })}
            </SensitiveTypography>
          ) : null}
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('receive.midnightNoPriceSource')}
          </Typography>
        </View>
      </View>

      {/* No rail row: the rail is already the subtitle under the token's name, and stating it twice in
          one screen makes the card look like it has something to add when it does not. Rendered only
          when something is left to put in it — for the chain-native token on the shielded rail, that is
          nothing at all, and an empty card is a box that promises detail it does not have. */}
      {ref !== null && (showTokenType || explorerUrl !== null) ? (
        <Card style={styles.infoCard}>
          {/* The native token's type is 32 zero bytes — 64 zeros truncated says nothing the heading has
              not already said. Shown only for a token whose type identifies it. */}
          {showTokenType ? (
            <DataRow label={t('receive.midnightTokenType')} value={truncateCompact(ref.tokenType)} />
          ) : null}
          {/* The explorer has address, transaction, contract and block pages — no per-token page — so the
              link points at the wallet's own unshielded address, which is where this holding is visible.
              Nothing to point at on the shielded rail. */}
          {explorerUrl !== null ? (
            <Button
              variant="nakedDefault"
              size="sm"
              label={t('cardanoActivity.viewOnExplorer')}
              rightIcon="arrowUpRight"
              onPress={() => void Linking.openURL(explorerUrl)}
              testID="midnight-token-explorer-link"
            />
          ) : null}
        </Card>
      ) : null}

      <View style={styles.activityHeader}>
        <SectionHeader title={t('cardanoPortfolio.activity')} />
        {section.kind === 'unavailable' ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('receive.midnightShieldedActivityUnavailable')}
          </Typography>
        ) : null}
        {section.kind === 'empty' ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('cardanoPortfolio.noActivity')}
          </Typography>
        ) : null}
      </View>
    </View>
  )

  const items = section.kind === 'list' ? section.items : []

  /**
   * A row opens the transaction on the explorer. Cardano opens its own tx-detail screen, which renders a
   * `ReviewedTransaction`; Midnight has no such review, so the explorer is the honest equivalent rather
   * than a screen that would repeat the row.
   */
  // In-app detail; the explorer link lives on that screen rather than being the only way to look.
  const openTx = (hash: string) => {
    router.push({pathname: '/wallet/midnight/tx/[hash]', params: {hash}})
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
      <FlatList
        data={items}
        style={styles.list}
        keyExtractor={(item) => item.hash}
        ListHeaderComponent={header}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({item, index}) => (
          <MidnightActivityRow
            item={item}
            isFirst={index === 0}
            isLast={index === items.length - 1}
            showDate
            nowMs={Date.now()}
            {...(item.pending === true ? {} : {onPress: openTx})}
          />
        )}
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
  infoCard: {padding: spacing.spacing16, gap: spacing.spacing8},
  activityHeader: {paddingTop: spacing.spacing8, gap: spacing.spacing8},
  muted: {color: colors.textAlternative},
}))
