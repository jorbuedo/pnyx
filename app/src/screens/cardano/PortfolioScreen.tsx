/**
 * Cardano wallet portfolio: the shared balance hero, Send / Receive / Swap / More
 * quick actions, and the native-token list. Filters (search, Tokens / NFTs type,
 * verified-only) live in a bottom sheet behind the header's filter icon; the
 * list is filtered to the verified-token registry by default (hides spam dust).
 * Dragging the value chart turns the hero into a value-at-time readout. ADA is
 * always shown.
 *
 * @module
 */

import {useNavigation, useRouter} from 'expo-router'
import {memo, useCallback, useLayoutEffect, useMemo, useState} from 'react'
import {FlatList, Pressable, RefreshControl, StyleSheet as RNStyleSheet, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Card} from '../../components/Card'
import type {ChamferCut} from '../../components/Chamfer'
import {ChamferBackground} from '../../components/Chamfer'
import {type PortfolioScrub, PortfolioValueChart} from '../../components/chart/PortfolioValueChart'
import {EmptyState} from '../../components/EmptyState'
import {SkeletonBase} from '../../components/Loaders/Skeleton'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {WalletBalanceHero} from '../../components/WalletBalanceHero'
import {useCardanoPastTokens} from '../../hooks/useCardanoPastTokens'
import {useCardanoPortfolio} from '../../hooks/useCardanoPortfolio'
import {useFeatureFlag} from '../../hooks/useFeatureFlag'
import {useFormatDate} from '../../hooks/useFormatDate'
import {useMidnightAssets} from '../../hooks/useMidnightAssets'
import {useNetworkCapabilities} from '../../hooks/useNetworkCapabilities'
import {useProgrammableHoldings} from '../../hooks/useProgrammableHoldings'
import {useShowUnverified} from '../../hooks/useShowUnverified'
import {useVerifiedTokens} from '../../hooks/useVerifiedTokens'
import {useConfig, useI18n} from '../../providers'
import {withProgrammable} from '../../services/cardano/cip113/programmable-rows'
import {
  filterPortfolioAssets,
  type PortfolioAsset,
  type PortfolioAssetType,
} from '../../services/cardano-assets/portfolio'
import {PortfolioFiltersSheet} from './PortfolioFiltersSheet'
import {PortfolioTokenRow} from './PortfolioTokenRow'

/**
 * Which corners a row cuts, so a stack of rows reads as one grouped card: the house
 * diagonal when it is the only row, otherwise its own half of it. Middle rows cut
 * nothing and their fills abut, which is what makes the group continuous.
 */
/**
 * ⚠️ **Why the list's `windowSize` is 3 and not the default 21 (or the 7 it was).**
 *
 * A `React.Profiler` around the list, scrolling a wallet with hundreds of holdings, measured
 * **67–103ms per commit** with a ~300ms base duration — four to six dropped frames each, which is
 * exactly what a long list feels like. Few commits, each enormous: `windowSize` keeps that many
 * viewport-fulls of rows mounted, and every scroll update re-renders the lot.
 *
 * At 3 the same scroll measured **49ms per commit and a ~65ms base**. `baseDuration` falling ~4.6×
 * is the part that matters: that is the un-memoised cost of the subtree, so this is rendering less,
 * not just memoising better.
 *
 * The trade is blank space when flinging faster than rows can render. Lower it further only with the
 * profiler open, and watch for blanks on a real device.
 */
const groupCut = (index: number, count: number): ChamferCut =>
  count === 1 ? 'diagonal' : index === 0 ? 'topRight' : index === count - 1 ? 'bottomLeft' : 'none'

export const PortfolioScreen = () => {
  const {t} = useI18n()
  const {formatDate, formatDateTime} = useFormatDate()
  const router = useRouter()
  const navigation = useNavigation()
  const {currency} = useConfig()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const {assets, totalFiat, adaQuantity, loading, refreshing, refresh, unavailable} = useCardanoPortfolio()
  const programmable = useProgrammableHoldings()
  const {verifiedIds} = useVerifiedTokens()
  const chartEnabled = useFeatureFlag('portfolioChart')
  const {priceHistory} = useNetworkCapabilities()

  const [query, setQuery] = useState('')
  const [type, setType] = useState<PortfolioAssetType>('all')
  const [showUnverified, setShowUnverified] = useShowUnverified()
  // Collapsed by default: a past holding is reference material, not part of what you own.
  const [pastOpen, setPastOpen] = useState(false)
  // While the chart is being scrubbed, the hero becomes the value-at-time readout and the list below
  // shows the portfolio as it stood then.
  const [scrub, setScrub] = useState<PortfolioScrub | null>(null)

  // The scrubbed snapshot replaces the live holdings, so a token held then but not now appears and
  // one acquired later drops out. Filtering and sorting are unchanged — the same rules over a
  // different instant. An unresolved snapshot (empty) keeps the live list rather than blanking it.
  // Folded in here rather than in the hook: `scrub` is a historical snapshot, and a holding read
  // from chain *now* has no business appearing in a past-dated view of the portfolio.
  // Midnight holdings join the same list. They carry `chainId`, so the row shows a network badge, the
  // verified gate lets them through (no registry exists to check them against) and no fiat is claimed.
  const {assets: midnightAssets} = useMidnightAssets()
  const live = [...withProgrammable(assets, programmable), ...midnightAssets]
  const rows = scrub !== null && scrub.assets.length > 0 ? scrub.assets : live
  const shown = useMemo(
    () => filterPortfolioAssets(rows, {verifiedIds, showUnverified, type, query}),
    [rows, verifiedIds, showUnverified, type, query],
  )

  // Past holdings go through the same filter as the live list, so the verified-only default keeps
  // spam dust out of here too rather than dumping every token that ever touched the wallet.
  const {assets: pastAssets, lastHeldById} = useCardanoPastTokens()
  const pastShown = useMemo(
    () => filterPortfolioAssets(pastAssets, {verifiedIds, showUnverified, type, query}),
    [pastAssets, verifiedIds, showUnverified, type, query],
  )

  // Filter affordance moves to the header's top-right icon (opens the sheet).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => setFiltersOpen(true)}
          hitSlop={8}
          style={styles.filterButton}
          accessibilityRole="button"
          accessibilityLabel={t('cardanoPortfolio.filtersTitle')}
          testID="assets-filters-open"
        >
          <UniIcon name="filter" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
        </Pressable>
      ),
    })
  }, [navigation, t])

  /**
   * ⚠️ Stable, because the row is memoised. An inline `renderItem` (and an inline `onPress` inside
   * it) hands every row new props on every list render, which makes the memo a no-op and repaints
   * each row's chamfer layer.
   *
   * ⚠️ **Above the `unavailable` early return, and it has to stay there.** These are hooks, so
   * skipping them on the renders that return early changes the hook order the moment `unavailable`
   * flips — which is what `useHookAtTopLevel` was reporting.
   */
  const openToken = useCallback(
    (assetId: string, isAda: boolean) =>
      router.push(`/wallet/token/${isAda ? 'ada' : encodeURIComponent(assetId)}` as never),
    [router],
  )
  const shownCount = shown.length
  const renderRow = useCallback(
    ({item, index}: {readonly item: PortfolioAsset; readonly index: number}) => (
      <PortfolioListRow item={item} index={index} count={shownCount} onOpen={openToken} />
    ),
    [shownCount, openToken],
  )

  if (unavailable) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <EmptyState icon="wallet" title={t('cardanoPortfolio.unavailable')} />
      </SafeAreaViewWrapper>
    )
  }

  // Header lives inside the list (whole screen scrolls as one FlatList, so the
  // token card hugs its content instead of stretching to the screen bottom).
  const header = (
    <View style={styles.header}>
      {/* Collapse the balance + chart while filtering so the list rises to the
          top and matches update live behind the filter sheet. */}
      {!filtersOpen ? (
        <>
          <WalletBalanceHero
            // While scrubbing the chart, the hero shows the value at the touched
            // time and its date label; on release it reverts to the live total.
            label={scrub !== null ? formatDateTime(scrub.point.ts * 1000) : t('wallets.balanceTitle')}
            totalFiat={scrub !== null ? {value: scrub.point.value, currency} : totalFiat}
            adaQuantity={adaQuantity}
            loading={scrub !== null ? false : loading}
            testID="assets-balance"
          />

          {chartEnabled && priceHistory ? <PortfolioValueChart onScrubChange={setScrub} /> : null}
        </>
      ) : null}

      <SectionHeader
        title={t('cardanoPortfolio.holdings')}
        trailingText={t('cardanoPortfolio.assetsCount', {count: shown.length})}
      />
    </View>
  )

  // Below the holdings, folded away. Rows navigate to the token's detail screen, which works with no
  // holding at all — its label and scale come from fetched metadata, its activity from the tx store
  // and its chart from the asset id — so this is how a sold position's history stays reachable.
  // Hidden entirely while filtering, matching the hero and chart, and absent when there is nothing
  // past to show rather than an empty fold.
  const pastSection =
    filtersOpen || pastShown.length === 0 ? null : (
      <View style={styles.pastSection}>
        <SectionHeader
          title={t('cardanoPortfolio.pastHoldings')}
          trailingText={t('cardanoPortfolio.assetsCount', {count: pastShown.length})}
          collapse={{
            isCollapsed: !pastOpen,
            onToggle: () => setPastOpen((open) => !open),
            accessibilityLabel: t('cardanoPortfolio.pastHoldingsHint'),
            testID: 'assets-past-toggle',
          }}
        />
        {pastOpen ? (
          <View style={styles.pastRows}>
            <ChamferBackground size="auto" fillToken="backgroundLayer1" borderToken="borderDefaultWeak" />
            {pastShown.map((item, index) => {
              const lastHeld = lastHeldById.get(item.id)
              return (
                <PortfolioTokenRow
                  key={item.id}
                  item={item}
                  withBorder={index < pastShown.length - 1}
                  {...(lastHeld === undefined
                    ? {}
                    : {note: t('cardanoPortfolio.lastHeld', {date: formatDate(lastHeld * 1000)})})}
                  onPress={() => router.push(`/wallet/token/${encodeURIComponent(item.id)}` as never)}
                />
              )
            })}
          </View>
        ) : null}
      </View>
    )

  return (
    <SafeAreaViewWrapper edges={['bottom']}>
      {/* ⚠️ The window size is measured, not guessed — see the note above `groupCut`. */}
      <FlatList
        data={shown}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        keyExtractor={(a) => a.id || 'ada'}
        initialNumToRender={8}
        windowSize={3}
        maxToRenderPerBatch={5}
        updateCellsBatchingPeriod={60}
        removeClippedSubviews
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => refresh('pull')} />}
        renderItem={renderRow}
        ListEmptyComponent={
          loading ? (
            <Card style={styles.emptyCard}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={[styles.skelRow, i < 2 && styles.skelRowBorder]}>
                  <SkeletonBase show width={96} height={14} radius={6} />
                  <SkeletonBase show width={72} height={14} radius={6} />
                </View>
              ))}
            </Card>
          ) : (
            <Typography variant="bodySm_regular" style={styles.muted}>
              {assets.length > 0 ? t('cardanoPortfolio.noMatches') : t('cardanoPortfolio.noTokens')}
            </Typography>
          )
        }
        ListFooterComponent={pastSection}
      />
      <PortfolioFiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        query={query}
        onQueryChange={setQuery}
        type={type}
        onTypeChange={setType}
        showUnverified={showUnverified}
        onShowUnverifiedChange={setShowUnverified}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  // Nudge the header filter icon in from the screen edge.
  filterButton: {paddingRight: spacing.spacing12},
  pastSection: {paddingTop: spacing.spacing24},
  pastRows: {},
  /** A middle row's fill: the same colour the chamfer would paint, without the SVG layer. */
  plainRowFill: {...RNStyleSheet.absoluteFillObject, backgroundColor: colors.backgroundLayer1},

  // The FlatList is the whole-screen scroll container; content-sized rows let
  // the token card hug its content instead of stretching to the screen bottom.
  // `flex: 1` bounds the list to the viewport so long lists scroll (not clip);
  // short lists leave transparent space below, not an empty card.
  list: {flex: 1},
  listContent: {paddingHorizontal: spacing.spacing16},
  // No bottom margin: the section band reads as the card's own tab, so it sits on it.
  header: {gap: spacing.spacing16},
  // Per-row card group: each row paints its own segment of one continuous surface, so
  // every row stays a virtualized cell. Layout only — the fill and the corner belong to
  // the paint layer. A `backgroundColor` here filled the corners the cut removed and the
  // side borders drew a rectangle around it, which is what made the card read as an
  // outlined box with a chamfer stuck to it.
  rowGroup: {},
  emptyCard: {paddingHorizontal: spacing.spacing16},
  muted: {color: colors.textAlternative, paddingVertical: spacing.spacing8},
  fiat: {color: colors.textAlternative},
  rowValue: {alignItems: 'flex-end'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.spacing12,
  },
  skelRowBorder: {borderBottomWidth: 1, borderBottomColor: colors.borderDefaultWeak},
}))

/**
 * One list row, memoised as a unit.
 *
 * ⚠️ **The chamfer is why this matters more than a usual row memo.** Each row paints its own
 * `ChamferBackground` — a react-native-svg layer — so re-creating rows repaints every visible one.
 * Built inline in `renderItem`, that happened on every list render, and scrolling the whale's
 * ~hundreds of holdings measured 26.9% janky frames with a 29ms median.
 */
const PortfolioListRow = memo(
  ({
    item,
    index,
    count,
    onOpen,
  }: {
    readonly item: PortfolioAsset
    readonly index: number
    readonly count: number
    readonly onOpen: (assetId: string, isAda: boolean) => void
  }) => {
    const onPress = useCallback(() => onOpen(item.id, item.isAda), [onOpen, item.id, item.isAda])
    const cut = groupCut(index, count)
    return (
      <View style={styles.rowGroup}>
        {/* One paint layer per row, cut for its position in the group. A single-asset
            list is both first and last, which used to render two overlapping layers
            each drawing its own outline.

            ⚠️ A middle row cuts nothing, so its "chamfer" is a plain rectangle — and painting one
            costs an SVG layer per row. On a wallet with hundreds of holdings that is every row but
            two, and it measured 26.9% janky frames at a 29ms median while scrolling. A middle row
            takes a plain themed `View` instead; the cut rows still paint. */}
        {cut === 'none' ? (
          <View style={styles.plainRowFill} pointerEvents="none" />
        ) : (
          <ChamferBackground size="auto" cut={cut} fillToken="backgroundLayer1" />
        )}
        <PortfolioTokenRow item={item} withBorder={index < count - 1} onPress={onPress} />
      </View>
    )
  },
)
