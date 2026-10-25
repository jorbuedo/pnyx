/**
 * One swap order, fully expanded.
 *
 * The list is deliberately lean — `legs` and `route` are omitted there — so this
 * is where an order's executions become visible: which venues filled which part,
 * what the floor was, and why the last execution ended as it did.
 *
 * Both rails resolve here, by id:
 * - **Market** — `GET /api/v2/orders/{tx_hash}` always returns `legs` + `route`
 *   and takes no `expand`. ⚠️ It performs **no owner check** — the tx hash is
 *   public on chain — so this works for an order this wallet does not own.
 * - **Limit** — `GET /api/v2/atc/orders/{orderId}`, keyless.
 *
 * @module
 */

import {Effect} from 'effect'
import {useLocalSearchParams} from 'expo-router'
import {useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Card} from '../../../components/Card'
import {EmptyState} from '../../../components/EmptyState'
import {SkeletonBase} from '../../../components/Loaders/Skeleton'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {TokenIcon} from '../../../components/TokenIcon'
import {Typography} from '../../../components/Typography'
import {useDexNames} from '../../../hooks/useDexNames'
import {formatTimeOfDay} from '../../../i18n/date-format'
import type {TranslationKey} from '../../../i18n/types'
import {logger} from '../../../logger'
import {useFormat, useI18n} from '../../../providers'
import {activityDayLabel} from '../../../services/cardano/history-grouping'
import {useTokenInfos} from '../../../services/cardano-assets/hooks'
import {displayDecimals, type TokenInfo} from '../../../services/cardano-assets/token-metadata'
import {fetchAtcOrder} from '../../../services/cardano-swap/atc-client'
import {fetchOrder} from '../../../services/cardano-swap/client'
import {
  type NormalizedOrder,
  normalizeAmmOrder,
  normalizeAtcOrder,
  type OrderStatus,
} from '../../../services/cardano-swap/order-model'
import {swapUnitToAssetId} from '../../../services/cardano-swap/swap-asset'
import type {SwapLeg} from '../../../services/cardano-swap/types'

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

export const OrderDetailScreen = () => {
  const {t, locale} = useI18n()
  const format = useFormat()
  const dexName = useDexNames()
  const {id, rail} = useLocalSearchParams<{id?: string; rail?: string}>()

  const [order, setOrder] = useState<NormalizedOrder | null>(null)
  const [legs, setLegs] = useState<readonly SwapLeg[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (id === undefined) return
    let active = true
    setLoading(true)
    const onFailure = (reason: string) => {
      if (!active) return
      logger.warn('Could not load the order detail', {origin: 'OrderDetailScreen', id, error: reason})
      setFailed(true)
      setLoading(false)
    }
    // Two rails, two shapes — kept as separate branches rather than a union so
    // neither response is cast into the other's type.
    if (rail === 'limit') {
      void Effect.runPromise(Effect.either(fetchAtcOrder(id))).then((res) => {
        if (!active) return
        if (res._tag === 'Left') return onFailure(res.left.reason)
        setOrder(normalizeAtcOrder(res.right))
        setLegs([])
        setLoading(false)
      })
    } else {
      void Effect.runPromise(Effect.either(fetchOrder(id, Date.now()))).then((res) => {
        if (!active) return
        if (res._tag === 'Left') return onFailure(res.left.reason)
        setOrder(normalizeAmmOrder(res.right))
        setLegs(res.right.legs)
        setLoading(false)
      })
    }
    return () => {
      active = false
    }
  }, [id, rail])

  const unitIds = useMemo(() => {
    const ids = new Set<string>()
    const add = (unit: string) => {
      const a = swapUnitToAssetId(unit)
      if (a !== null) ids.add(a)
    }
    for (const a of [...(order?.offer ?? []), ...(order?.received ?? []), ...(order?.minReceive ?? [])]) add(a.unit)
    for (const l of legs) {
      if (l.input !== null) add(l.input.unit)
      if (l.output !== null) add(l.output.unit)
    }
    return [...ids]
  }, [order, legs])
  const {infos} = useTokenInfos(unitIds)

  const show = (a: {readonly unit: string; readonly amount: string}) => {
    const assetId = swapUnitToAssetId(a.unit)
    const info = assetId === null ? undefined : infos.get(assetId)
    return format(BigInt(a.amount), {
      preset: 'cryptoBalance',
      currency: info?.ticker ?? info?.name ?? '',
      decimals: displayDecimals(info?.decimals ?? null),
    })
  }

  if (loading) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
        <Card style={styles.card}>
          <SkeletonBase show width={110} height={16} radius={6} />
          <SkeletonBase show width={220} height={20} radius={6} />
          <SkeletonBase show width={160} height={12} radius={6} />
        </Card>
      </SafeAreaViewWrapper>
    )
  }

  if (order === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.empty}>
        <EmptyState
          icon="swap"
          title={t(failed ? 'swapOrders.loadFailed' : 'swapOrders.empty')}
          testID="order-detail-empty"
        />
      </SafeAreaViewWrapper>
    )
  }

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
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Card style={styles.card} testID="order-detail">
        <View style={styles.head}>
          <Typography variant="bodyXs_medium" style={styles.muted}>
            {t(order.rail === 'limit' ? 'swapOrders.railLimit' : 'swapOrders.railMarket')}
          </Typography>
          <Typography variant="bodyXs_medium" style={styles.muted}>
            {t(STATUS_KEY[order.status])}
          </Typography>
        </View>
        {order.offer[0] !== undefined && (
          <Row label={t('swap.youPay')} value={show(order.offer[0])} infos={infos} unit={order.offer[0].unit} />
        )}
        {order.received[0] !== undefined && (
          <Row
            label={t('swap.youReceive')}
            value={show(order.received[0])}
            infos={infos}
            unit={order.received[0].unit}
          />
        )}
        {order.minReceive[0] !== undefined && (
          <Row
            label={t('swap.minReceived')}
            value={show(order.minReceive[0])}
            infos={infos}
            unit={order.minReceive[0].unit}
          />
        )}
        {order.remaining[0] !== undefined && (
          <Row
            label={t('swapOrders.remaining')}
            value={show(order.remaining[0])}
            infos={infos}
            unit={order.remaining[0].unit}
          />
        )}
        {dateLabel !== null && <Detail label={t('swapOrders.placed')} value={dateLabel} />}
        <Detail label={t('swapOrders.orderId')} value={order.id} />
      </Card>

      {/* The executions. `legCount` can exceed what a single venue did — a split
          route fills in parts, and this is the only place that is visible. */}
      {legs.length > 0 && (
        <Card style={styles.card}>
          <Typography variant="bodyXs_medium" style={styles.muted}>
            {t('swapOrders.executions', {count: legs.length})}
          </Typography>
          {legs.map((leg, i) => (
            <View key={`${leg.dex}:${leg.poolId ?? i}`} style={styles.leg}>
              <Typography variant="bodySm_medium">{dexName(leg.dex)}</Typography>
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {[leg.input === null ? null : show(leg.input), leg.output === null ? null : show(leg.output)]
                  .filter((x) => x !== null)
                  .join('  →  ')}
              </Typography>
            </View>
          ))}
        </Card>
      )}
    </SafeAreaViewWrapper>
  )
}

const Row = ({
  label,
  value,
  unit,
  infos,
}: {
  readonly label: string
  readonly value: string
  readonly unit: string
  readonly infos: ReadonlyMap<string, TokenInfo>
}) => {
  const assetId = swapUnitToAssetId(unit)
  const info = assetId === null ? undefined : infos.get(assetId)
  return (
    <View style={styles.row}>
      <Typography variant="bodySm_regular" style={styles.muted}>
        {label}
      </Typography>
      <View style={styles.rowValue}>
        {assetId !== null && <TokenIcon assetId={assetId} label={info?.ticker ?? ''} size={18} />}
        <Typography variant="bodySm_medium">{value}</Typography>
      </View>
    </View>
  )
}

const Detail = ({label, value}: {readonly label: string; readonly value: string}) => (
  <View style={styles.row}>
    <Typography variant="bodySm_regular" style={styles.muted}>
      {label}
    </Typography>
    <Typography variant="bodyXs_regular" style={styles.detailValue} numberOfLines={1}>
      {value}
    </Typography>
  </View>
)

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing8},
  empty: {flex: 1, justifyContent: 'center', padding: spacing.spacing24},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  head: {flexDirection: 'row', justifyContent: 'space-between'},
  row: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.spacing12},
  rowValue: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8, flexShrink: 1},
  detailValue: {flexShrink: 1, textAlign: 'right', color: colors.textMuted},
  muted: {color: colors.textMuted},
  leg: {gap: 2, paddingVertical: spacing.spacing4},
}))
