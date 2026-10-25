/**
 * Cardano activity list: the wallet's full transaction history, newest-first,
 * date-sectioned into a single virtualized list. Each row shows a type icon,
 * label, time, signed ADA amount + token count, and status; tap opens the
 * tx-detail screen (the review renderer in `mode="detail"`). Rows page in from
 * the local store as the background backfill populates it.
 *
 * @module
 */

import {MIDNIGHT_MAINNET} from '@pnyx/config'
import type {ReviewedTransaction} from '@pnyx/tx-review'
import {useNavigation, useRouter} from 'expo-router'
import {useCallback, useLayoutEffect, useMemo, useState} from 'react'
import {ActivityIndicator, FlatList, Pressable, RefreshControl, View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'
import {Card} from '../../components/Card'
import {ChainBadge} from '../../components/ChainBadge'
import {ChamferBackground} from '../../components/Chamfer'
import {CircleLoader} from '../../components/Loaders'
import {Skeleton} from '../../components/Loaders/Skeleton'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {Typography} from '../../components/Typography'
import {UniIcon, type UniIconName} from '../../components/UniIcon'
import {useCardanoHistory} from '../../hooks/useCardanoHistory'
import {type FiatAtTime, useActivityFiat} from '../../hooks/useCardanoPortfolioHistory'
import {useCardanoRail} from '../../hooks/useCardanoRail'
import {useCardanoTokenHistory} from '../../hooks/useCardanoTokenHistory'
import {useFormatDate} from '../../hooks/useFormatDate'
import {useMidnightActivity} from '../../hooks/useMidnightActivity'
import {useToast} from '../../hooks/useToast'
import {formatTimeOfDay} from '../../i18n/date-format'
import {logger} from '../../logger'
import {saveTextFile} from '../../platform/save-text-file'
import {useConfig, useFormat, useI18n} from '../../providers'
import {buildActivityCsv} from '../../services/cardano/activity-csv'
import {activeCip113Marks} from '../../services/cardano/cip113/deployment-selection'
import {
  type ActivityType,
  activityDayLabel,
  activityType,
  groupActivity,
  primaryMovement,
} from '../../services/cardano/history-grouping'
import {metadataProtocol, protocolTitle} from '../../services/cardano/metadata/protocol'
import {
  adaTokenInfo,
  amountUnitFor,
  type TokenInfo,
  unknownTokenInfo,
  useTokenInfos,
} from '../../services/cardano-assets'
import {displayDecimals} from '../../services/cardano-assets/token-metadata'
import type {MidnightActivity} from '../../services/midnight/wallet/midnight-activity'
import {NIGHT_DISPLAY_DECIMALS} from '../../services/midnight/wallet/midnight-portfolio'
import {NIGHT_TOKEN_TYPE} from '../../services/midnight/wallet/unshielded-utxo-set'

const SKELETON_KEYS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']

/**
 * One row's worth of activity, from either chain. `timestamp` is hoisted so the date grouper can read it
 * without knowing which chain it came from.
 */
type MergedActivityEntry =
  | {readonly chain: 'cardano'; readonly timestamp?: string | undefined; readonly tx: ReviewedTransaction}
  | {readonly chain: 'midnight'; readonly timestamp?: string | undefined; readonly tx: MidnightActivity}

/** Converter the screen threads into each row: asset id (undefined = ADA) → display info. */
type InfoFor = (assetId: string | undefined) => TokenInfo
/** Fiat-at-time converter (raw quantity + tx timestamp → {value, currency}); null while prices load. */
type FiatOf = FiatAtTime | null

/** Per-type icon (drives the leading badge glyph). */
const TYPE_ICON: Record<ActivityType, UniIconName> = {
  sent: 'arrowUpRight',
  received: 'arrowLineDown',
  self: 'arrows',
  rewards: 'coins',
  mint: 'coins',
  staking: 'growthStaking',
  governance: 'document',
  smartContract: 'fileText',
  programmableRegistry: 'document',
  programmableIssue: 'coins',
  programmableTransfer: 'arrows',
  programmableToken: 'coins',
  nightClaim: 'midnight',
}

/**
 * Badge tint per direction. `backgroundDefault` is deliberately absent: that
 * token is the app canvas, so filling with it painted the page colour onto the
 * page and the badge disappeared — which is what made a Sent row read as a bare
 * icon on nothing.
 */
const BADGE_FILL = {in: 'successMuted', out: 'primaryMuted', none: 'backgroundLayer1'} as const
const BADGE_ICON = {in: 'successDefault', out: 'primaryDefault', none: 'textDefault'} as const

const useTypeLabel = () => {
  const {t} = useI18n()
  return (type: ActivityType): string =>
    t(
      (
        {
          sent: 'cardanoActivity.sent',
          received: 'cardanoActivity.received',
          self: 'cardanoActivity.self',
          rewards: 'cardanoActivity.rewards',
          nightClaim: 'cardanoActivity.nightClaim',
          mint: 'cardanoActivity.mint',
          staking: 'cardanoActivity.staking',
          governance: 'cardanoActivity.governance',
          smartContract: 'cardanoActivity.smartContract',
          programmableRegistry: 'cardanoActivity.programmableRegistry',
          programmableIssue: 'cardanoActivity.programmableIssue',
          programmableTransfer: 'cardanoActivity.programmableTransfer',
          programmableToken: 'cardanoActivity.programmableToken',
        } as const
      )[type],
    )
}

export const ActivityRow = ({
  tx,
  isFirst,
  isLast,
  onPress,
  infoFor,
  fiatOf,
  showDate = false,
  nowMs,
}: {
  tx: ReviewedTransaction
  isFirst: boolean
  isLast: boolean
  onPress: () => void
  infoFor: InfoFor
  fiatOf: FiatOf
  /** Standalone rows (home/token widgets) prepend the date; the grouped Activity
   * screen leaves this off since its section headers carry the date. */
  showDate?: boolean
  /** Reference "now" for the relative date label; required when `showDate`. */
  nowMs?: number
}) => {
  const {t, locale} = useI18n()
  const format = useFormat()
  const typeLabel = useTypeLabel()
  // Read here rather than threaded as a prop: this row renders from several screens, and a prop
  // every caller must remember is a prop some caller will forget — leaving the generic label.
  const {rail} = useCardanoRail()
  const cip113 = activeCip113Marks(rail?.config.protocolMagic ?? 0)

  const primary = primaryMovement(tx)
  const baseType = activityType(tx, cip113)
  const isTransfer = baseType === 'sent' || baseType === 'received' || baseType === 'self'
  // Direction follows the HEADLINE asset's sign, not the ADA flow — a token send
  // whose ADA change returns still reads as "Sent". Special ops keep their type.
  const type: ActivityType = isTransfer
    ? primary.quantity < 0n
      ? 'sent'
      : primary.quantity > 0n
        ? 'received'
        : 'self'
    : baseType
  const inflow = primary.quantity > 0n
  // The badge carries the direction: green in, brand out, and a plain raised tile
  // when nothing moved on balance (an internal transfer, or an operation whose
  // only cost was the fee). Three states, because the two-state version painted
  // the no-movement case with the same neutral as an outright send.
  const flow: keyof typeof BADGE_FILL = primary.quantity > 0n ? 'in' : primary.quantity < 0n ? 'out' : 'none'

  const info = infoFor(primary.assetId)
  const unit = amountUnitFor(info)
  const absQty = primary.quantity < 0n ? -primary.quantity : primary.quantity
  const sign = primary.quantity > 0n ? '+' : primary.quantity < 0n ? '-' : ''
  // No unit when the only name we have is the fingerprint: the row already shows it, and
  // "1 asset1cxcws8…vhl3g35s" buries the quantity in a repeat of the identifier.
  const amount = `${sign}${format(absQty, {preset: 'cryptoActivity', ...(unit === undefined ? {} : {currency: unit}), decimals: displayDecimals(info.decimals)})}`
  // Value at the tx's time (not the current rate); `null` ts (pending) → no fiat.
  const txMs = tx.timestamp !== undefined ? Date.parse(tx.timestamp) : Number.NaN
  const txSec = Number.isFinite(txMs) ? Math.floor(txMs / 1000) : null
  // No scale ⇒ no fiat: the same raw quantity could be worth any multiple of ten.
  const fiat = fiatOf && info.decimals !== null ? fiatOf(primary.assetId ?? '', absQty, info.decimals, txSec) : null
  const fiatText = fiat ? format(fiat.value, {preset: 'fiatBalance', currency: fiat.currency}) : null

  // A pending row has no timestamp. It is rendered as its own element rather than
  // folded into `sub` below, so it can carry the warning colour and the spinner —
  // "in flight" is a state, not just another metadata segment.
  const isPending = tx.timestamp === undefined
  const time = isPending ? null : formatTimeOfDay(tx.timestamp as string)
  const dateLabel =
    showDate && tx.timestamp !== undefined
      ? activityDayLabel(
          Date.parse(tx.timestamp),
          nowMs ?? Date.now(),
          locale,
          t('cardanoActivity.today'),
          t('cardanoActivity.yesterday'),
        )
      : null
  // Chain is omitted — Cardano is the only wallet chain today, so labelling every
  // row "Cardano" is noise. Re-add a chain segment here if activity spans chains.
  const sub = [dateLabel, time, tx.status === 'failed' ? t('cardanoActivity.failed') : null].filter(Boolean).join(' · ')

  styles.useVariants({inflow})

  return (
    <Pressable onPress={onPress} style={styles.row(isFirst, isLast)} testID={`activity-row-${tx.hash}`}>
      <View style={styles.badge}>
        <ChamferBackground size="auto" fillToken={BADGE_FILL[flow]} />
        <UniIcon
          name={TYPE_ICON[type]}
          width={18}
          height={18}
          uniProps={(theme) => ({color: theme.colors[BADGE_ICON[flow]]})}
        />
      </View>
      <View style={styles.rowMid}>
        <Typography variant="bodyMd_medium" singleLine>
          {protocolTitle(typeLabel(type), metadataProtocol(tx))}
        </Typography>
        {isPending ? (
          <View style={styles.pendingRow}>
            <PendingSpinner size="xs" testID="transactions-pending-spinner" />
            <Typography variant="bodySm_regular" style={styles.pending} singleLine>
              {t('cardanoActivity.pending')}
            </Typography>
          </View>
        ) : (
          <Typography variant="bodySm_regular" style={styles.muted} singleLine>
            {sub}
          </Typography>
        )}
      </View>
      <View style={styles.amountCol}>
        <Typography variant="bodyMd_medium" style={styles.amount} singleLine>
          {amount}
        </Typography>
        {fiatText !== null ? (
          <Typography variant="bodyXs_regular" style={styles.muted} singleLine>
            {fiatText}
          </Typography>
        ) : null}
        {primary.additionalCount > 0 ? (
          <Typography variant="bodyXs_regular" style={styles.muted} singleLine>
            {t('cardanoActivity.moreAssets', {count: primary.additionalCount})}
          </Typography>
        ) : null}
      </View>
    </Pressable>
  )
}

/**
 * One unshielded Midnight transaction, in the same list and the same chrome.
 *
 * ⚠️ **It lives here, beside `ActivityRow`, to share that row's styles.** Two visually different rows in
 * one activity list read as a bug, and Midnight cannot use `ActivityRow` itself: that renders a
 * `ReviewedTransaction`, and pushing a Midnight transaction through it would mean fabricating a Cardano
 * review — inputs, outputs, certificates and metadata this chain does not have.
 *
 * The direction labels are the Cardano keys on purpose. "Sent" is the same word on every chain, and a
 * second key holding the same English would be translated twice, independently, and drift.
 *
 * ⚠️ No fiat: there is no Midnight price source, and a zero would read as "worth nothing".
 */
export const MidnightActivityRow = ({
  item,
  isFirst,
  isLast,
  showDate = false,
  nowMs,
  onPress,
}: {
  item: MidnightActivity
  isFirst: boolean
  isLast: boolean
  showDate?: boolean
  nowMs?: number
  /**
   * Absent leaves the row inert. Callers must omit it for a `pending` row: its `hash` is an
   * identifier rather than a transaction hash (a pre-binding transaction has none), so the detail
   * screen's lookup would find nothing and open on an empty state.
   */
  onPress?: (hash: string) => void
}) => {
  const {t, locale} = useI18n()
  const format = useFormat()

  const night = item.netByToken.get(NIGHT_TOKEN_TYPE)
  const others = [...item.netByToken.keys()].filter((token) => token !== NIGHT_TOKEN_TYPE).length
  const flow: keyof typeof BADGE_FILL =
    item.direction === 'received' ? 'in' : item.direction === 'sent' ? 'out' : 'none'
  const typeIcon: UniIconName = TYPE_ICON[item.direction]
  const label = t(
    ({sent: 'cardanoActivity.sent', received: 'cardanoActivity.received', self: 'cardanoActivity.self'} as const)[
      item.direction
    ],
  )

  const absolute = night === undefined ? null : night < 0n ? -night : night
  const sign = night === undefined || night === 0n ? '' : night > 0n ? '+' : '-'
  const amount =
    absolute === null
      ? null
      : `${sign}${format(absolute, {preset: 'cryptoActivity', currency: 'NIGHT', decimals: NIGHT_DISPLAY_DECIMALS})}`

  const isPending = item.timestamp === undefined
  const time = isPending ? null : formatTimeOfDay(item.timestamp as string)
  const dateLabel =
    showDate && item.timestamp !== undefined
      ? activityDayLabel(
          Date.parse(item.timestamp),
          nowMs ?? Date.now(),
          locale,
          t('cardanoActivity.today'),
          t('cardanoActivity.yesterday'),
        )
      : null
  const sub = [dateLabel, time].filter(Boolean).join(' · ')

  styles.useVariants({inflow: item.direction === 'received'})

  const Container = onPress === undefined ? View : Pressable
  return (
    <Container
      style={styles.row(isFirst, isLast)}
      testID={`midnight-activity-${item.hash}`}
      {...(onPress === undefined ? {} : {onPress: () => onPress(item.hash)})}
    >
      <ChainBadge chain={MIDNIGHT_MAINNET} testID={`midnight-activity-badge-${item.hash}`}>
        <View style={styles.badge}>
          <ChamferBackground size="auto" fillToken={BADGE_FILL[flow]} />
          <UniIcon
            name={typeIcon}
            width={18}
            height={18}
            uniProps={(theme) => ({color: theme.colors[BADGE_ICON[flow]]})}
          />
        </View>
      </ChainBadge>
      <View style={styles.rowMid}>
        <Typography variant="bodyMd_medium" singleLine>
          {label}
        </Typography>
        {isPending ? (
          <View style={styles.pendingRow}>
            <PendingSpinner size="xs" />
            <Typography variant="bodySm_regular" style={styles.pending} singleLine>
              {t('cardanoActivity.pending')}
            </Typography>
          </View>
        ) : (
          <Typography variant="bodySm_regular" style={styles.muted} singleLine>
            {sub}
          </Typography>
        )}
      </View>
      <View style={styles.amountCol}>
        {amount !== null ? (
          <Typography variant="bodyMd_medium" style={styles.amount} singleLine>
            {amount}
          </Typography>
        ) : null}
        {others > 0 ? (
          <Typography variant="bodyXs_regular" style={styles.muted} singleLine>
            {t('cardanoActivity.moreAssets', {count: others})}
          </Typography>
        ) : null}
      </View>
    </Container>
  )
}

/**
 * The spinner beside a pending row. `CircleLoader` takes a raw colour string on a
 * prop, so the theme value arrives via `uniProps` — reading it with
 * `useUnistyles()` would opt every row out of the native shadow-tree update.
 */
const PendingSpinner = withUnistyles(CircleLoader, (theme) => ({color: theme.colors.warningDefault}))

/** Build the id→info resolver from a batched infos map. */
const makeInfoFor =
  (infos: ReadonlyMap<string, TokenInfo>, adaInfo: TokenInfo): InfoFor =>
  (assetId) =>
    assetId === undefined ? adaInfo : (infos.get(assetId) ?? unknownTokenInfo(assetId))

/** Every non-ADA asset id a tx touched (for batched metadata + price fetches). */
export const assetIdsOf = (tx: ReviewedTransaction): string[] =>
  tx.ownDelta.map((a) => a.assetId).filter((id): id is string => id !== undefined)

/**
 * Row for embedding (home widget) — resolves its own metadata/prices for its
 * single tx and renders the SAME grouped-card chrome as the Activity screen, so
 * `isFirst`/`isLast` round the group's corners and the full-width row divider
 * matches. The embedder stacks these directly (no extra Card/divider).
 */
export const HistoryRow = ({
  tx,
  onPress,
  isFirst = true,
  isLast = true,
}: {
  tx: ReviewedTransaction
  onPress: () => void
  isFirst?: boolean
  isLast?: boolean
}) => {
  const ids = useMemo(() => assetIdsOf(tx), [tx])
  const {infos} = useTokenInfos(ids)
  const {network} = useConfig()
  const [now] = useState(() => Date.now())
  const oneTx = useMemo(() => [tx], [tx])
  const fiatOf = useActivityFiat(oneTx)
  const infoFor = useMemo(() => makeInfoFor(infos, adaTokenInfo(network)), [infos, network])
  return (
    <ActivityRow
      tx={tx}
      isFirst={isFirst}
      isLast={isLast}
      onPress={onPress}
      infoFor={infoFor}
      fiatOf={fiatOf}
      showDate
      nowMs={now}
    />
  )
}

export const HistoryScreen = () => {
  const {t, locale} = useI18n()
  const router = useRouter()
  const navigation = useNavigation()
  const {currency, network} = useConfig()
  const {formatDateTime} = useFormatDate()
  const {showToast} = useToast()
  const {items, loading, error, unavailable, refresh, loadMore, hasMore} = useCardanoHistory()
  // Read from the same cache the Midnight balance uses — the subscription that yields the UTxO set carries
  // the transactions that produced it, so this costs no extra network work.
  const midnight = useMidnightActivity()
  // Full persisted history — drives the CSV export and the fiat/info resolvers
  // (a superset of the paged `items` the list renders).
  const {txs: allTxs} = useCardanoTokenHistory('', true)

  const openDetail = useCallback((hash: string) => router.push(`/wallet/tx/${hash}` as never), [router])
  /**
   * A Midnight row opens Midnight's own detail screen — it renders the same view model the send
   * review does, so it is not a repeat of the row it was opened from. The explorer link lives on that
   * screen, which is why this no longer leaves the app.
   */
  const openMidnightTx = useCallback(
    (hash: string) => router.push({pathname: '/wallet/midnight/tx/[hash]', params: {hash}}),
    [router],
  )

  // Batch metadata + prices for every asset the wallet has touched (one fetch
  // each), then thread resolvers into the rows instead of fetching per-row.
  const assetIds = useMemo(() => [...new Set(allTxs.flatMap(assetIdsOf))], [allTxs])
  const {infos} = useTokenInfos(assetIds)
  const [now] = useState(() => Date.now())
  const {rail: exportRail} = useCardanoRail()
  const exportMarks = activeCip113Marks(exportRail?.config.protocolMagic ?? 0)
  const fiatOf = useActivityFiat(allTxs)
  const infoFor = useMemo(() => makeInfoFor(infos, adaTokenInfo(network)), [infos, network])

  const onExport = useCallback(async () => {
    if (allTxs.length === 0) {
      showToast({variant: 'error', message: t('cardanoActivity.exportEmpty')})
      return
    }
    try {
      const csv = buildActivityCsv(allTxs, {
        infoOf: (id) => {
          const i = infoFor(id)
          return {ticker: i.ticker ?? i.label, decimals: displayDecimals(i.decimals)}
        },
        fiatOf,
        currency,
        cip113: exportMarks,
        formatDate: (ms) => formatDateTime(ms),
      })
      await saveTextFile({
        fileName: `pnyx-activity-${new Date().toISOString().slice(0, 10)}.csv`,
        text: csv,
        mimeType: 'text/csv',
        uti: 'public.comma-separated-values-text',
      })
    } catch (e: unknown) {
      logger.warn('Activity CSV export failed', {origin: 'HistoryScreen', error: String(e)})
      showToast({variant: 'error', message: t('cardanoActivity.exportError')})
    }
  }, [allTxs, infoFor, fiatOf, currency, formatDateTime, showToast, t, exportMarks])

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={onExport}
          hitSlop={8}
          style={styles.exportButton}
          accessibilityRole="button"
          accessibilityLabel={t('cardanoActivity.export')}
          testID="transactions-export"
        >
          <UniIcon name="share" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
        </Pressable>
      ),
    })
  }, [navigation, onExport, t])

  // Both chains in one date-sectioned list. Sorted newest-first across chains before grouping, because
  // the grouper walks in order and would otherwise open a second section for a day it had already closed.
  //
  // ⚠️ Midnight's *shielded* transfers are absent, and not because nothing happened: a shielded coin has
  // no address, so there is no by-address history to read (see `midnight-activity`).
  const entries = useMemo<readonly MergedActivityEntry[]>(() => {
    const merged: MergedActivityEntry[] = [
      ...items.map((tx) => ({chain: 'cardano' as const, timestamp: tx.timestamp, tx})),
      ...(midnight.items ?? []).map((tx) => ({chain: 'midnight' as const, timestamp: tx.timestamp, tx})),
    ]
    const at = (entry: MergedActivityEntry) => {
      const ms = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp)
      // Undated rows are pending and lead the list, which is where the grouper puts their section too.
      return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
    }
    return merged.sort((a, b) => at(b) - at(a))
  }, [items, midnight.items])

  const listData = useMemo(
    () =>
      groupActivity(entries, {
        nowMs: now,
        locale,
        today: t('cardanoActivity.today'),
        yesterday: t('cardanoActivity.yesterday'),
        pending: t('cardanoActivity.pending'),
      }),
    [entries, locale, t, now],
  )

  const renderItem = useCallback(
    ({item}: {item: {readonly id: string; readonly label: string; readonly txs: readonly MergedActivityEntry[]}}) => (
      <View>
        <Typography variant="bodyXs_medium" style={styles.header}>
          {item.label.toUpperCase()}
        </Typography>
        {/* The day's rows share one card — the row paints no surface of its own, so
            without this they sat on the bare canvas. */}
        <Card>
          {item.txs.map((entry, index) => {
            const isFirst = index === 0
            const isLast = index === item.txs.length - 1
            if (entry.chain === 'midnight') {
              return (
                <MidnightActivityRow
                  key={`m:${entry.tx.hash}`}
                  item={entry.tx}
                  isFirst={isFirst}
                  isLast={isLast}
                  onPress={openMidnightTx}
                />
              )
            }
            return (
              <ActivityRow
                key={entry.tx.hash ?? `${item.id}:${index}`}
                tx={entry.tx}
                isFirst={isFirst}
                isLast={isLast}
                onPress={() => entry.tx.hash !== undefined && openDetail(entry.tx.hash)}
                infoFor={infoFor}
                fiatOf={fiatOf}
              />
            )
          })}
        </Card>
      </View>
    ),
    [openDetail, openMidnightTx, infoFor, fiatOf],
  )

  if (unavailable) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <Typography variant="bodyMd_regular" style={styles.muted}>
          {t('cardanoActivity.unavailable')}
        </Typography>
      </SafeAreaViewWrapper>
    )
  }

  // Cold load with nothing stored yet → skeleton rows, not a blank screen.
  if (loading && items.length === 0) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
        {SKELETON_KEYS.map((k) => (
          <View key={k} style={styles.skelRow}>
            <Skeleton show width={40} height={40} shape="circle">
              {null}
            </Skeleton>
            <View style={styles.skelMid}>
              <Skeleton show width={90} height={14} radius={6}>
                {null}
              </Skeleton>
              <Skeleton show width={140} height={12} radius={6}>
                {null}
              </Skeleton>
            </View>
            <Skeleton show width={72} height={14} radius={6}>
              {null}
            </Skeleton>
          </View>
        ))}
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']} style={styles.safeArea}>
      <FlatList
        data={listData}
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        contentContainerStyle={listData.length === 0 ? styles.center : styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
        onEndReached={hasMore ? loadMore : undefined}
        onEndReachedThreshold={0.6}
        ListFooterComponent={
          hasMore ? (
            <View style={styles.footer}>
              <ActivityIndicator />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Typography variant="bodyMd_regular" style={styles.muted}>
              {error !== null ? t('cardanoActivity.loadError') : t('cardanoActivity.empty')}
            </Typography>
          </View>
        }
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  exportButton: {paddingRight: theme.spacing.spacing12},
  content: {paddingHorizontal: theme.spacing.spacing16, paddingVertical: theme.spacing.spacing8},
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing24,
  },
  header: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: theme.spacing.spacing16,
    marginBottom: theme.spacing.spacing8,
  },
  // Layout and divider only. The surface and the corner belong to the Card this
  // row sits in — repainting them here covered the Card's chamfer with a rounded
  // rectangle, which is why the activity list stopped matching the asset list.
  row: (_isFirst: boolean, isLast: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    paddingHorizontal: theme.spacing.spacing16,
    // Full-width divider between rows (edge to edge of the grouped card).
    borderBottomWidth: isLast ? 0 : 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  }),
  badge: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMid: {flex: 1, gap: theme.spacing.spacing4},
  muted: {color: theme.colors.textAlternative},
  pendingRow: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing4},
  pending: {color: theme.colors.warningDefault},
  amountCol: {alignItems: 'flex-end', gap: theme.spacing.spacing2, flexShrink: 0},
  amount: {
    variants: {
      inflow: {true: {color: theme.colors.successDefault}, false: {color: theme.colors.textDefault}},
    },
  },
  footer: {paddingVertical: theme.spacing.spacing16, alignItems: 'center'},
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    paddingHorizontal: theme.spacing.spacing16,
  },
  skelMid: {flex: 1, gap: theme.spacing.spacing8},
}))
