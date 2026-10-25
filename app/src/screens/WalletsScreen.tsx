/**
 * Wallets tab — the multi-chain wallet vertical home.
 *
 * Holds only separately-imported funds wallets — the identity wallet (SIWM /
 * app auth) lives in the Id tab and never appears here (identity/wallet split).
 * Top-to-bottom: a light wallet selector (switch + manage), the Balance hero
 * (with a privacy/hide toggle), a Send / Receive action row, a conditional
 * Pending-reviews widget, a Portfolio section (top assets + see-all), and a
 * Recent-activity widget (last few txs + see-all). Cardano is the only
 * full-wallet chain today (balance + fiat via the asset hooks). With no
 * imported wallets the tab renders an add-wallet empty state
 * (product/STATUS.md → "Wallets-home layout review").
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {useFocusEffect, useRouter} from 'expo-router'
import {useCallback, useMemo, useState} from 'react'
import {Pressable, RefreshControl, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AssetIcon} from '../components/AssetIcon'
import {Card} from '../components/Card'
import {ChamferBackground} from '../components/Chamfer'
import {EmptyState} from '../components/EmptyState'
import {SkeletonBase} from '../components/Loaders/Skeleton'
import {NetworkNotice} from '../components/NetworkNotice'
import {QuickActions} from '../components/QuickAction'
import {RemoteBanners} from '../components/RemoteBanners'
import {Row} from '../components/Row'
import {SafeAreaViewWrapper} from '../components/SafeAreaViewWrapper'
import {SectionHeader} from '../components/SectionHeader'
import {SensitiveTypography} from '../components/SensitiveTypography'
import {Typography} from '../components/Typography'
import {UniIcon} from '../components/UniIcon'
import {WalletBalanceHero} from '../components/WalletBalanceHero'
import {WalletIdenticon} from '../components/WalletIdenticon'
import {WalletMoreSheet} from '../components/WalletMoreSheet'
import {useCardanoHistory} from '../hooks/useCardanoHistory'
import {useCardanoPortfolio} from '../hooks/useCardanoPortfolio'
import {useFeatureFlag} from '../hooks/useFeatureFlag'
import {useMidnightActivity} from '../hooks/useMidnightActivity'
import {useMidnightAssets} from '../hooks/useMidnightAssets'
import {useNetworkCapabilities} from '../hooks/useNetworkCapabilities'
import {usePendingReviews} from '../hooks/usePendingReviews'
import {useProgrammableHoldings} from '../hooks/useProgrammableHoldings'
import {useShowUnverified} from '../hooks/useShowUnverified'
import {useVerifiedTokens} from '../hooks/useVerifiedTokens'
import {NoticeDot} from '../notices'
import {useConfig, useCopy, useFormat, useI18n, useWalletAddress, useWalletList} from '../providers'
import {withProgrammable} from '../services/cardano/cip113/programmable-rows'
import {filterPortfolioAssets, sortPortfolioAssets} from '../services/cardano-assets/portfolio'
import {displayDecimals} from '../services/cardano-assets/token-metadata'
import {accountDisplayName, accountIdenticonSeed} from '../utils/account-display'
import {HistoryRow, MidnightActivityRow} from './cardano/HistoryScreen'

const PORTFOLIO_TOP_N = 3
const ACTIVITY_TOP_N = 3

export function WalletsScreen() {
  const {t} = useI18n()
  const router = useRouter()
  const format = useFormat()
  const {currency} = useConfig()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {receiveAddresses} = useWalletAddress()
  const {copy} = useCopy()
  const {swapEnabled} = useNetworkCapabilities()
  const {verifiedIds} = useVerifiedTokens()
  const [moreOpen, setMoreOpen] = useState(false)
  const isReadOnly = selectedWalletGroup?.primaryWallet?.implementation === 'readOnly'
  const addWalletEnabled = useFeatureFlag('addWallet')
  const swapFlagEnabled = useFeatureFlag('swap')
  const {items: pendingItems} = usePendingReviews(selectedWalletGroup?.groupId ?? null)

  // `/wallet/*` routes are cast through one helper (not all in the generated
  // expo-router types yet).
  const go = useCallback((route: string) => router.push(route as Parameters<typeof router.push>[0]), [router])

  // ── Cardano portfolio (the only full-wallet chain today) ──
  const {
    assets,
    totalFiat,
    adaQuantity,
    loading: portfolioLoading,
    refreshing: portfolioRefreshing,
    busy: portfolioBusy,
    refresh: refreshPortfolio,
    unavailable: railUnavailable,
  } = useCardanoPortfolio()

  // The Wallets tab stays mounted, so its portfolio hook wouldn't re-fetch on
  // its own — refetch whenever the tab regains focus (e.g. returning from
  // Portfolio) so the balance is never stale/blank.
  //
  // Explicitly a background refetch: sharing the pull flag put the scroll view into
  // RefreshControl's refreshing state on every focus, which is what made the screen feel
  // held while it loaded.
  useFocusEffect(
    useCallback(() => {
      refreshPortfolio('background')
    }, [refreshPortfolio]),
  )

  const {
    items: history,
    loading: historyLoading,
    busy: historyBusy,
    refresh: refreshHistory,
  } = useCardanoHistory(ACTIVITY_TOP_N)
  // Midnight activity belongs in this widget too, not only in the full list: a widget showing Cardano-only
  // recent activity while `/wallet/transactions` shows both is the same wallet disagreeing with itself.
  const midnightActivity = useMidnightActivity()

  // Read separately from the portfolio: the wallet's ordinary fetch paths cannot see these,
  // because a smart-wallet address is not one this account derives.
  const programmable = useProgrammableHoldings()

  // Midnight holdings sit in the same widget as Cardano's, distinguished by the row's network badge.
  const {assets: midnightAssets} = useMidnightAssets()

  // Same filter the portfolio screen applies, from the same persisted preference: a
  // holding the registry has not verified is invisible here otherwise, which is exactly
  // the token its holder turned the filter off to see.
  const [showUnverified] = useShowUnverified()

  // Portfolio widget: shared sort (chain-native first), top N. The sort is applied *here* rather than
  // relied upon from the Cardano hook, because appending another chain's rows to an already-sorted list
  // puts them after everything — and `PORTFOLIO_TOP_N` then cuts them off entirely.
  const portfolio = useMemo(
    () =>
      filterPortfolioAssets(sortPortfolioAssets([...withProgrammable(assets, programmable), ...midnightAssets]), {
        verifiedIds,
        showUnverified,
        type: 'all',
        query: '',
      })
        .slice(0, PORTFOLIO_TOP_N)
        .map((a) => ({
          id: a.id,
          chainId: a.chainId,
          isChainNative: a.isChainNative,
          isNft: a.isNft,
          label: a.isAda ? t('wallets.chains.cardano') : a.label,
          amount: format(a.quantity, {
            preset: 'cryptoBalance',
            // Same rule as `PortfolioTokenRow`: the row label already names it, and an
            // NFT has no ticker to append.
            ...(a.isNft ? {} : {currency: a.label}),
            decimals: displayDecimals(a.decimals),
          }),
          fiat: a.fiatValue !== null ? format(a.fiatValue, {preset: 'fiatBalance', currency}) : null,
        })),
    [assets, verifiedIds, showUnverified, format, currency, t, programmable, midnightAssets],
  )

  /**
   * The newest few from both chains. Sorted across chains *before* the slice — taking the top N from each
   * and concatenating would show three Cardano rows and drop a Midnight transaction that is newer than all
   * of them, which is exactly what the full list does not do.
   */
  const recentActivity = useMemo(() => {
    const at = (timestamp: string | undefined) => {
      const ms = timestamp === undefined ? Number.NaN : Date.parse(timestamp)
      // Undated rows are pending, and lead.
      return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
    }
    return [
      ...history.map((tx) => ({chain: 'cardano' as const, timestamp: tx.timestamp, tx})),
      ...(midnightActivity.items ?? []).map((tx) => ({chain: 'midnight' as const, timestamp: tx.timestamp, tx})),
    ]
      .sort((a, b) => at(b.timestamp) - at(a.timestamp))
      .slice(0, ACTIVITY_TOP_N)
  }, [history, midnightActivity.items])

  // In-app detail rather than straight out to the explorer: the explorer link lives on that screen,
  // one tap further, so a row press no longer leaves the app to answer "what was this?".
  const openMidnightTx = useCallback(
    (hash: string) => {
      router.push({pathname: '/wallet/midnight/tx/[hash]', params: {hash}})
    },
    [router],
  )

  // No imported wallets yet: the identity wallet deliberately does not appear
  // here (identity/wallet split). This tab holds only imported funds wallets.
  if (selectedWalletGroup === null) {
    return (
      <SafeAreaViewWrapper style={styles.safeArea} edges={[]} hasBottomMenu contentContainerStyle={styles.emptyBody}>
        <EmptyState
          icon="wallet"
          title={t('wallets.empty.title')}
          description={t('wallets.empty.description')}
          action={
            addWalletEnabled
              ? {label: t('wallets.addWallet'), onPress: () => router.push('/onboarding/add-wallet')}
              : undefined
          }
          testID="wallets-empty"
        />
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={[]}
      scrollable
      hasBottomMenu
      contentContainerStyle={styles.body}
      // The line covers every other fetch — cold boot, wallet switch, network switch, focus —
      // without taking touches, so the wallet selector stays usable while one runs.
      progress={portfolioBusy || historyBusy}
      refreshControl={
        <RefreshControl
          refreshing={portfolioRefreshing}
          // ⚠️ **Both widgets, because a pull is the user saying "you are showing me something
          // stale".** This refreshed the portfolio alone, so the balance updated while the activity
          // widget beside it kept whatever it had read at mount — including a Pending row for a
          // transaction that had already confirmed, which no amount of pulling could clear.
          onRefresh={() => {
            refreshPortfolio('pull')
            refreshHistory()
          }}
        />
      }
    >
      {/* Testnet banner lives here, not on Community: it says tokens have no real value,
          which is a statement about funds. It was on Community only because that tab still
          renders the old HomeScreen, where it was placed when Community was the Home tab. */}
      <NetworkNotice />

      <RemoteBanners slot="home" />

      {/* Wallet selector (switch) + manage — light, no add-wallet (that lives in the switcher). */}
      <View style={styles.selectorRow}>
        <Pressable
          style={({pressed}) => [styles.selector, pressed && styles.pressed]}
          onPress={() => router.push('/settings/wallet-selection')}
          testID="wallets-active-wallet-card"
        >
          <ChamferBackground size="auto" fillToken="backgroundAlternative" />
          <WalletIdenticon
            size={28}
            iconStyle="blockies"
            seed={accountIdenticonSeed(
              selectedWalletGroup.primaryWallet.checksum?.seed ?? selectedWalletGroup.groupId,
              selectedAccountIndex,
            )}
          />
          <Typography variant="bodyMd_medium" numberOfLines={1} style={styles.selectorName}>
            {accountDisplayName(
              selectedWalletGroup.name,
              selectedAccountIndex,
              selectedWalletGroup.primaryWallet.accounts.length,
            )}
          </Typography>
          <UniIcon name="rightThin" width={14} height={14} uniProps={(theme) => ({color: theme.colors.textMuted})} />
        </Pressable>
        <Pressable
          hitSlop={8}
          style={({pressed}) => [styles.manageBtn, pressed && styles.pressed]}
          onPress={() =>
            router.push({pathname: '/settings/wallet-settings', params: {groupId: selectedWalletGroup.groupId}})
          }
          testID="wallets-manage"
        >
          <ChamferBackground size="auto" fillToken="backgroundAlternative" />
          <UniIcon name="settings" width={20} height={20} uniProps={(theme) => ({color: theme.colors.textDefault})} />
          {/* The only way into Wallet Management, so the only place a pending backup can be pointed at. */}
          <NoticeDot
            route="/settings/wallet-settings"
            size={7}
            style={styles.manageDot}
            testID="wallets-manage-notice"
          />
        </Pressable>
      </View>

      <WalletBalanceHero
        label={t('wallets.balanceTitle')}
        totalFiat={totalFiat}
        adaQuantity={adaQuantity}
        loading={portfolioLoading}
        unavailable={railUnavailable}
        unavailableText={t('wallets.portfolioUnavailable')}
        onPress={() => go('/wallet/assets')}
        testID="wallets-assets-summary"
      />

      {/* Watch-only wallets can't sign — the whole action row is hidden (don't
          lie to the user). */}
      {!isReadOnly && (
        <QuickActions
          actions={[
            {
              key: 'send',
              icon: 'send',
              label: t('wallets.actions.send'),
              onPress: () => go('/wallet/send'),
              testID: 'wallets-action-send',
            },
            {
              key: 'receive',
              icon: 'receive',
              label: t('wallets.actions.receive'),
              onPress: () => go('/wallet/receive'),
              // Long-press copies the Cardano receive address without opening the sheet.
              onLongPress: () => {
                const address = receiveAddresses.get(CARDANO_MAINNET)
                if (address !== undefined) copy({text: address, feedback: t('receive.addressCopied')})
              },
              testID: 'wallets-action-receive',
            },
            // Hidden, not dimmed, where swap has no provider (testnets) or where the build does not
            // ship it: an affordance the user cannot use is noise, and the route still guards itself
            // for deep links. Two independent reasons to hide, so both are checked.
            ...(swapEnabled && swapFlagEnabled
              ? [
                  {
                    key: 'swap',
                    icon: 'swap' as const,
                    label: t('wallets.actions.swap'),
                    onPress: () => go('/wallet/swap'),
                    testID: 'wallets-action-swap',
                  },
                ]
              : []),
            {
              key: 'more',
              icon: 'moreHorizontal',
              label: t('wallets.actions.more'),
              onPress: () => setMoreOpen(true),
              testID: 'wallets-action-more',
            },
          ]}
        />
      )}
      <WalletMoreSheet visible={moreOpen} onClose={() => setMoreOpen(false)} />

      {/* Pending co-sign reviews — only when there are any (the standing
          co-sign entry point lives in the Menu tab). */}
      {pendingItems.length > 0 && (
        <Card
          fillToken="primaryMuted"
          style={styles.pendingCard}
          onPress={() => go('/wallet/pending')}
          testID="wallets-pending"
        >
          <View style={styles.pendingIcon}>
            <UniIcon
              name="pending"
              width={18}
              height={18}
              uniProps={(theme) => ({color: theme.colors.primaryDefault})}
            />
          </View>
          <Typography variant="bodySm_medium" style={styles.pendingText}>
            {t('wallets.pendingReviews', {count: pendingItems.length})}
          </Typography>
          <UniIcon name="rightThin" width={14} height={14} uniProps={(theme) => ({color: theme.colors.textMuted})} />
        </Card>
      )}

      {/* Portfolio — top assets + see all */}
      <View style={styles.section}>
        <SectionHeader
          title={t('wallets.portfolioTitle')}
          link={{
            label: t('wallets.seeAll'),
            onPress: () => go('/wallet/assets'),
            testID: 'wallets-assets-see-all',
          }}
        />
        {/* Same rule as the activity widget below, written the same way on purpose: a skeleton
            means "nothing is known for this wallet yet", never "a refresh is running". The two had
            drifted, so a switch blanked this one while that one kept the old wallet's rows. */}
        {portfolioLoading && portfolio.length === 0 ? (
          <Card>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.skelRow, i < 2 && styles.skelRowBorder]}>
                <SkeletonBase show width={36} height={36} radius={18} />
                <View style={styles.skelText}>
                  <SkeletonBase show width={96} height={14} radius={6} />
                  <SkeletonBase show width={60} height={12} radius={6} />
                </View>
                <SkeletonBase show width={72} height={14} radius={6} />
              </View>
            ))}
          </Card>
        ) : portfolio.length === 0 ? (
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('wallets.noAssets')}
          </Typography>
        ) : (
          <Card>
            {portfolio.map((row, i) => (
              <Row
                key={row.id}
                withBorder={i < portfolio.length - 1}
                onPress={() => go('/wallet/assets')}
                testID={`wallets-asset-${row.id}`}
                leftContent={
                  <AssetIcon
                    assetId={row.id}
                    label={row.label}
                    chainId={row.chainId}
                    isChainNative={row.isChainNative}
                    {...(row.isNft ? {isNft: true} : {})}
                    size={36}
                    testID={`wallets-asset-badge-${row.id}`}
                  />
                }
                label={row.label}
                rightContent={
                  <View style={styles.amountCol}>
                    <SensitiveTypography variant="bodyMd_medium" numberOfLines={1}>
                      {row.amount}
                    </SensitiveTypography>
                    {row.fiat !== null && (
                      <SensitiveTypography variant="bodyXs_regular" style={styles.amountFiat} numberOfLines={1}>
                        {row.fiat}
                      </SensitiveTypography>
                    )}
                  </View>
                }
              />
            ))}
          </Card>
        )}
      </View>

      {/* Recent activity — last few txs + see all */}
      <View style={styles.section}>
        <SectionHeader
          title={t('wallets.activityTitle')}
          link={{
            label: t('wallets.seeAll'),
            onPress: () => go('/wallet/transactions'),
            testID: 'wallets-transactions-see-all',
          }}
        />
        {/* Gated on **both** chains. These two conditions used to test `history` alone — the Cardano
            list — while the rows below render the merged one, so a wallet with Midnight transactions and
            no Cardano history sat on skeletons for ever and a wallet whose Cardano history had settled
            empty was told it had no activity at all. Neither had anything to do with the Midnight data,
            which was loaded and correct the whole time. */}
        {historyLoading && history.length === 0 && midnightActivity.items === null ? (
          <Card>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.skelRow, i < 2 && styles.skelRowBorder]}>
                <SkeletonBase show width={36} height={36} radius={12} />
                <View style={styles.skelText}>
                  <SkeletonBase show width={110} height={14} radius={6} />
                  <SkeletonBase show width={80} height={12} radius={6} />
                </View>
                <View style={styles.skelRight}>
                  <SkeletonBase show width={72} height={14} radius={6} />
                  <SkeletonBase show width={44} height={12} radius={6} />
                </View>
              </View>
            ))}
          </Card>
        ) : recentActivity.length === 0 ? (
          <Card style={styles.emptyActivityCard}>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('wallets.noActivity')}
            </Typography>
          </Card>
        ) : (
          <Card>
            {recentActivity.map((entry, i, arr) =>
              entry.chain === 'midnight' ? (
                <MidnightActivityRow
                  key={`m:${entry.tx.hash}`}
                  item={entry.tx}
                  isFirst={i === 0}
                  isLast={i === arr.length - 1}
                  showDate
                  nowMs={Date.now()}
                  {...(entry.tx.pending === true ? {} : {onPress: openMidnightTx})}
                />
              ) : (
                <HistoryRow
                  key={entry.tx.hash ?? entry.tx.timestamp}
                  tx={entry.tx}
                  isFirst={i === 0}
                  isLast={i === arr.length - 1}
                  onPress={() => entry.tx.hash !== undefined && go(`/wallet/tx/${entry.tx.hash}`)}
                />
              ),
            )}
          </Card>
        )}
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  body: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing20},
  emptyBody: {flexGrow: 1, justifyContent: 'center', padding: theme.spacing.spacing16},
  pressed: {opacity: 0.7},

  selectorRow: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing8},
  selector: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingVertical: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing12,
  },
  selectorName: {flex: 1, color: theme.colors.textDefault},
  manageDot: {
    top: 4,
    right: 4,
  },
  manageBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },

  pendingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    padding: theme.spacing.spacing12,
  },
  pendingIcon: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundDefault,
  },
  pendingText: {flex: 1, color: theme.colors.textDefault},

  // No gap: the header's band reads as the section's own tab, so it has to meet it.
  section: {},

  amountCol: {alignItems: 'flex-end'},
  amountFiat: {color: theme.colors.textMuted},

  muted: {color: theme.colors.textMuted},
  emptyActivityCard: {minHeight: 132, alignItems: 'center', justifyContent: 'center'},
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    paddingHorizontal: theme.spacing.spacing16,
  },
  skelRowBorder: {borderBottomWidth: 1, borderBottomColor: theme.colors.borderDefaultWeak},
  skelText: {flex: 1, gap: theme.spacing.spacing6},
  skelRight: {alignItems: 'flex-end', gap: theme.spacing.spacing6},
}))
