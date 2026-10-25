/**
 * Swap orders — one list over SteelSwap's TWO order books.
 *
 * Market (AMM aggregator) and limit (ATC) orders live in separate stores and
 * never appear in each other's listing, so they are fetched separately and
 * merged by `order-model.ts`. Each row is badged with its rail; the filter chips
 * apply to the merged list.
 *
 * Cancelling routes to the shared review → signing ceremony like every other
 * signature in the app. A market cancel can produce TWO transactions (one per
 * Plutus-version bucket), which the ceremony takes as two legs.
 *
 * @module
 */

import {useNavigation, useRouter} from 'expo-router'
import {useLayoutEffect, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {Card} from '../../../components/Card'
import {EmptyState} from '../../../components/EmptyState'
import {SkeletonBase} from '../../../components/Loaders/Skeleton'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {TabsWrapper} from '../../../components/Tabs'
import {TokenIcon} from '../../../components/TokenIcon'
import {Typography} from '../../../components/Typography'
import {UniIcon} from '../../../components/UniIcon'
import {useDexNames} from '../../../hooks/useDexNames'
import {useOrderCancel} from '../../../hooks/useOrderCancel'
import {useSwapOrders} from '../../../hooks/useSwapOrders'
import {useToast} from '../../../hooks/useToast'
import {formatTimeOfDay} from '../../../i18n/date-format'
import type {TranslationKey} from '../../../i18n/types'
import {useFormat, useI18n} from '../../../providers'
import {activityDayLabel} from '../../../services/cardano/history-grouping'
import {useTokenInfos} from '../../../services/cardano-assets/hooks'
import {displayDecimals, type TokenInfo} from '../../../services/cardano-assets/token-metadata'
import {
  filterOrders,
  type NormalizedOrder,
  type OrderFilter,
  type OrderStatus,
} from '../../../services/cardano-swap/order-model'
import {swapUnitToAssetId} from '../../../services/cardano-swap/swap-asset'

const FILTERS: readonly {readonly key: OrderFilter; readonly label: TranslationKey}[] = [
  {key: 'all', label: 'swapOrders.filterAll'},
  {key: 'open', label: 'swapOrders.filterOpen'},
  {key: 'filled', label: 'swapOrders.filterFilled'},
  {key: 'cancelled', label: 'swapOrders.filterCancelled'},
]

const STATUS_KEY: Record<OrderStatus, TranslationKey> = {
  mempool: 'swapOrders.status.mempool',
  open: 'swapOrders.status.open',
  partiallyFilled: 'swapOrders.status.partiallyFilled',
  filled: 'swapOrders.status.filled',
  cancelled: 'swapOrders.status.cancelled',
  partiallyCancelled: 'swapOrders.status.partiallyCancelled',
  error: 'swapOrders.status.error',
  mixed: 'swapOrders.status.mixed',
  rolledBack: 'swapOrders.status.rolledBack',
  unknown: 'swapOrders.status.unknown',
}

export const OrdersScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const navigation = useNavigation()
  const {showToast} = useToast()
  const {orders, loading, ammError, limitError, reload} = useSwapOrders()
  const {cancel, busyId} = useOrderCancel()
  const [filter, setFilter] = useState<OrderFilter>('all')

  const shown = useMemo(() => filterOrders(orders, filter, 'both'), [orders, filter])
  // Every unit named by any row, so a row can render "30,000 NIGHT" instead of
  // a base-unit count with no ticker.
  const unitIds = useMemo(() => {
    const ids = new Set<string>()
    for (const o of shown)
      for (const a of [...o.offer, ...o.received]) {
        const id = swapUnitToAssetId(a.unit)
        if (id !== null) ids.add(id)
      }
    return [...ids]
  }, [shown])
  const {infos} = useTokenInfos(unitIds)
  const openCount = useMemo(() => filterOrders(orders, 'open', 'both').length, [orders])

  // An order's state lives on chain and moves without us — a fill or a
  // settlement between loads is exactly what makes a cancel answer
  // `already_executed`. So refreshing is a first-class action, not a pull-down.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={reload}
          hitSlop={8}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel={t('common.buttons.refresh')}
          testID="orders-refresh"
        >
          <UniIcon
            name="refresh"
            size="md"
            uniProps={(theme) => ({color: loading ? theme.colors.textMuted : theme.colors.textDefault})}
          />
        </Pressable>
      ),
    })
  }, [navigation, reload, loading, t])

  const onCancel = async (order: NormalizedOrder) => {
    const outcome = await cancel(order)
    if (outcome === null) return

    // Every non-cancel outcome is stated. An all-skipped batch is a 200 with no
    // transactions, so saying nothing here would read as "the tap did nothing".
    for (const s of outcome.skipped) {
      const key = `swapOrders.skipped.${s.reason}` as TranslationKey
      showToast({variant: 'error', message: t(key)})
    }
    for (const r of outcome.refundSkipped) {
      const key = `swapOrders.refundSkipped.${r.reason}` as TranslationKey
      showToast({variant: 'error', message: t(key)})
    }
    if (outcome.ticketId === null) {
      if (outcome.skipped.length === 0) showToast({variant: 'error', message: t('swapOrders.cancelNothing')})
      // Nothing was cancellable, so what this screen shows is out of date — the
      // order settled between the list load and the tap.
      reload()
      return
    }
    router.push(`/wallet/review-tx?ticket=${outcome.ticketId}` as never)
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      {/* Tabs, not chips: these are mutually-exclusive views of one list, which
          is what a tab bar means. Open carries a count, because "how many need
          me" is the reason to come here. */}
      <TabsWrapper
        tabs={FILTERS.map((f) => ({
          key: f.key,
          label: t(f.label),
          ...(f.key === 'open' && openCount > 0 ? {badge: openCount} : {}),
        }))}
        activeTab={filter}
        onTabChange={(k) => setFilter(k as OrderFilter)}
        testID="orders-filter"
      />

      {/* One rail failing must not blank the other's orders — each says so. */}
      {ammError !== null && (
        <Typography variant="bodySm_regular" style={styles.railError}>
          {t('swapOrders.loadFailed')}
        </Typography>
      )}
      {limitError === 'noStakeAddress' && (
        <Typography variant="bodySm_regular" style={styles.railError}>
          {t('swapOrders.limitOwnerUnavailable')}
        </Typography>
      )}

      {/* "No orders" while still loading is a different claim from "no orders",
          and the first one is a lie that resolves itself a second later. */}
      {loading && shown.length === 0 ? (
        [0, 1, 2].map((i) => (
          <Card key={i} style={styles.row}>
            <View style={styles.rowHead}>
              <SkeletonBase show width={72} height={12} radius={6} />
              <SkeletonBase show width={48} height={12} radius={6} />
            </View>
            <View style={styles.pair}>
              <SkeletonBase show width={20} height={20} radius={10} />
              <SkeletonBase show width={110} height={16} radius={6} />
              <View style={styles.skelSpacer} />
              <SkeletonBase show width={20} height={20} radius={10} />
              <SkeletonBase show width={110} height={16} radius={6} />
            </View>
            <SkeletonBase show width={180} height={12} radius={6} />
          </Card>
        ))
      ) : shown.length === 0 ? (
        <View style={styles.emptyWrap}>
          {/* No retry action — the header's refresh is the one way to reload,
              and two buttons for one job is two things to keep in sync. */}
          <EmptyState
            icon="swap"
            title={t(filter === 'all' ? 'swapOrders.empty' : 'swapOrders.emptyFiltered')}
            testID="orders-empty"
          />
        </View>
      ) : (
        shown.map((o) => (
          <OrderRow
            key={`${o.rail}:${o.id}`}
            order={o}
            infos={infos}
            busy={busyId === o.id}
            // A cancel already running elsewhere must not look tappable here.
            disabled={busyId !== null}
            onCancel={() => void onCancel(o)}
            onOpen={() => router.push(`/wallet/order?id=${encodeURIComponent(o.id)}&rail=${o.rail}` as never)}
          />
        ))
      )}
    </SafeAreaViewWrapper>
  )
}

/**
 * ONE row component with a rail variant, not one per rail — the two rails differ only
 * in the badge and whether a limit price is shown.
 */
const OrderRow = ({
  order,
  infos,
  busy,
  disabled,
  onCancel,
  onOpen,
}: {
  readonly order: NormalizedOrder
  readonly infos: ReadonlyMap<string, TokenInfo>
  readonly busy: boolean
  readonly disabled: boolean
  readonly onCancel: () => void
  readonly onOpen: () => void
}) => {
  const {t, locale} = useI18n()
  const format = useFormat()
  const dexName = useDexNames()
  styles.useVariants({status: order.status})

  /**
   * ⚠️ `decimals` may be `null` — no source stated them. `displayDecimals`
   * renders that as no scale (a raw base-unit count) rather than assuming 0,
   * which would misprint every quantity of an unresolved token.
   */
  const show = (a: {readonly unit: string; readonly amount: string}) => {
    const id = swapUnitToAssetId(a.unit)
    const info = id === null ? undefined : infos.get(id)
    return format(BigInt(a.amount), {
      preset: 'cryptoBalance',
      currency: info?.ticker ?? info?.name ?? '',
      decimals: displayDecimals(info?.decimals ?? null),
    })
  }

  const offer = order.offer[0]
  const received = order.received[0]
  /** Nothing has come back yet, so show what the order is ASKING for. */
  const expected = order.minReceive[0]

  const dateLabel =
    order.timeSec === null
      ? null
      : `${activityDayLabel(
          order.timeSec * 1000,
          Date.now(),
          locale,
          t('cardanoActivity.today'),
          t('cardanoActivity.yesterday'),
        )} · ${formatTimeOfDay(order.timeSec * 1000, locale)}`

  return (
    <Card style={styles.row} testID={`order-${order.id}`} onPress={onOpen}>
      <View style={styles.rowHead}>
        <Typography variant="bodyXs_medium" style={styles.rail}>
          {t(order.rail === 'limit' ? 'swapOrders.railLimit' : 'swapOrders.railMarket')}
        </Typography>
        <Typography variant="bodyXs_medium" style={styles.status}>
          {t(STATUS_KEY[order.status])}
        </Typography>
      </View>

      {/* The trade itself: what went out → what came back. A row that shows one
          side is a row you cannot read. */}
      <View style={styles.pair}>
        <Side amount={offer} infos={infos} render={show} />
        <UniIcon name="rightThin" width={12} height={12} uniProps={(theme) => ({color: theme.colors.textMuted})} />
        <Side amount={received ?? expected} infos={infos} render={show} align="end" />
      </View>

      <View style={styles.metaRow}>
        {/* A venue and a date are what tell two similar orders apart. */}
        <Typography variant="bodyXs_regular" style={styles.muted} numberOfLines={1}>
          {[order.venue === null ? null : dexName(order.venue), dateLabel].filter((x) => x !== null).join(' · ')}
        </Typography>
        {/* `received` is documented as a LOWER BOUND. On a settled order that
            caveat is noise on every row; while work is still outstanding it is
            the whole point, because more can still arrive. */}
        {received !== undefined && order.status !== 'filled' && order.status !== 'cancelled' && (
          <Typography variant="bodyXs_regular" style={styles.muted}>
            {t('swapOrders.receivedIsLowerBound')}
          </Typography>
        )}
      </View>

      {order.cancellable && (
        <Button
          label={t('swapOrders.cancelCta')}
          variant="secondary"
          size="sm"
          onPress={onCancel}
          isDisabled={disabled}
          isLoading={busy}
          testID={`order-cancel-${order.id}`}
        />
      )}
    </Card>
  )
}

/** One side of the pair: its token icon and the amount. */
const Side = ({
  amount,
  infos,
  render,
  align,
}: {
  readonly amount: {readonly unit: string; readonly amount: string} | undefined
  readonly infos: ReadonlyMap<string, TokenInfo>
  readonly render: (a: {readonly unit: string; readonly amount: string}) => string
  readonly align?: 'end'
}) => {
  if (amount === undefined) {
    return (
      <Typography variant="bodyMd_medium" style={align === 'end' ? styles.pairSideEnd : styles.pairSide}>
        —
      </Typography>
    )
  }
  const assetId = swapUnitToAssetId(amount.unit)
  const info = assetId === null ? undefined : infos.get(assetId)
  return (
    <View style={align === 'end' ? styles.sideEnd : styles.side}>
      {assetId !== null && <TokenIcon assetId={assetId} label={info?.ticker ?? info?.name ?? ''} size={20} />}
      <Typography variant="bodyMd_medium" numberOfLines={1} style={styles.pairSide}>
        {render(amount)}
      </Typography>
    </View>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing8, flexGrow: 1},
  // Centred, because an empty list clinging to the tab bar reads as a broken
  // list rather than an empty one.
  emptyWrap: {flexGrow: 1, justifyContent: 'center'},
  filters: {flexDirection: 'row', gap: spacing.spacing8},
  filterBtn: {flex: 1},
  row: {padding: spacing.spacing16, gap: spacing.spacing8},
  rowHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  rail: {color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.9},
  muted: {color: colors.textMuted},
  pair: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
  side: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8, flexShrink: 1},
  sideEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing8,
    flexShrink: 1,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  pairSide: {flexShrink: 1},
  pairSideEnd: {flexShrink: 1, flexGrow: 1, textAlign: 'right'},
  metaRow: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.spacing8},
  skelSpacer: {flexGrow: 1},
  railError: {color: colors.textAlternative, textAlign: 'center', paddingVertical: spacing.spacing8},
  // Status colour is state, so it is a Unistyles variant rather than a
  // `useUnistyles()` read — which would opt this row out of the native
  // shadow-tree update and re-render it in JS on every theme change.
  status: {
    variants: {
      status: {
        mempool: {color: colors.textMuted},
        open: {color: colors.primaryDefault},
        partiallyFilled: {color: colors.primaryDefault},
        filled: {color: colors.successDefault},
        cancelled: {color: colors.textMuted},
        partiallyCancelled: {color: colors.textMuted},
        error: {color: colors.errorDefault},
        mixed: {color: colors.textMuted},
        rolledBack: {color: colors.errorDefault},
        unknown: {color: colors.textMuted},
      },
    },
  },
}))
