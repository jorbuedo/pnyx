/**
 * Detail for one Midnight transaction, reached by tapping its row in an activity list.
 *
 * ⚠️ **Separate from `TxDetailScreen` on purpose**, for the same reason `MidnightTokenDetailScreen` is
 * separate from `TokenDetailScreen`: that screen renders a `ReviewedTransaction` through a six-tab
 * surface built for UTxO graphs, certificates, scripts and signature ceremonies. A Midnight transfer
 * has none of them. Four empty tabs would be worse than one honest screen.
 *
 * What the chain gives us here is narrower than Cardano's, and the screen says so rather than
 * inventing it: the indexer reports a transaction's net effect per token and the addresses on the
 * other side, not a resolved input set. So there is no inputs/outputs breakdown — that is an absence
 * of data, not a screen that forgot.
 *
 * Renders `MidnightDetailView` from `@pnyx/tx-review`, the same view model the send review builds in
 * its `confirm` mode, so the two cannot drift in what a transfer is said to be. The id block and
 * explorer link deliberately mirror `TxDetailScreen`'s footer — the chain differs, the affordance
 * should not.
 *
 * @module
 */

import {viewMidnightActivity} from '@pnyx/tx-review'
import {useLocalSearchParams} from 'expo-router'
import {useMemo} from 'react'
import {ActivityIndicator, Linking, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../../components/Buttons'
import {Card} from '../../components/Card'
import {Copiable} from '../../components/Copiable'
import {EmptyState} from '../../components/EmptyState'
import {DataRow} from '../../components/Row'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {Typography} from '../../components/Typography'
import {useMidnightActivity} from '../../hooks/useMidnightActivity'
import {formatGroupedInteger} from '../../i18n/number-format'
import {useConfig, useFormat, useI18n, useNumberLocale} from '../../providers'
import {midnightExplorerTxUrl} from '../../services/midnight/explorer'
import {midnightFeeDisplay} from '../../services/midnight/fee-display'
import {midnightFundsNetwork} from '../../services/midnight/networks'
import {NIGHT_DISPLAY_DECIMALS} from '../../services/midnight/wallet/midnight-portfolio'
import {NIGHT_TOKEN_TYPE} from '../../services/midnight/wallet/unshielded-utxo-set'
import {truncateCompact, truncateWide} from '../../utils/truncate'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {paddingHorizontal: spacing.spacing16, paddingBottom: spacing.spacing16, gap: spacing.spacing16},
  // No gap: the chamfered section header is a tab that sits *on* the card it labels.
  section: {gap: 0},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  footer: {gap: spacing.spacing12},
  idBlock: {gap: spacing.spacing4},
  hash: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
  muted: {color: colors.textAlternative},
}))

export const MidnightTxDetailScreen = () => {
  const {t} = useI18n()
  const {network} = useConfig()
  const format = useFormat()
  // The resolved number locale, not the BCP-47 tag: formatGroupedInteger wants the probed model.
  const numberLocale = useNumberLocale()
  const {hash} = useLocalSearchParams<{hash?: string}>()
  const {items} = useMidnightActivity()

  const midnightNetwork = midnightFundsNetwork(network)
  // `items === null` is "the list has not been read yet", which is not the same as "this transaction
  // is not in it" — collapsing the two rendered "not in this list" for a moment on every open, and
  // permanently for anyone whose read is slow.
  const loading = items === null
  const activity = useMemo(() => items?.find((item) => item.hash === hash), [items, hash])

  const view = useMemo(
    () =>
      activity === undefined || midnightNetwork === null
        ? null
        : // Every Midnight activity row we can currently build comes from the unshielded
          // subscription — a shielded transfer has no by-address history to read (see
          // MIDNIGHT_WALLET_ARCHITECTURE). Naming the rail rather than inferring it keeps that
          // honest for the day a shielded journal exists.
          viewMidnightActivity({tx: activity, rail: 'unshielded', network: midnightNetwork}),
    [activity, midnightNetwork],
  )

  if (loading) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <ActivityIndicator />
      </SafeAreaViewWrapper>
    )
  }

  if (view === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']}>
        <EmptyState
          title={t('midnightTx.notFoundTitle')}
          // Not "this transaction does not exist": the activity list is what we searched, and it holds
          // only what this address's subscription has replayed.
          description={t('midnightTx.notFoundBody')}
        />
      </SafeAreaViewWrapper>
    )
  }

  const explorerUrl = midnightExplorerTxUrl(view.network, view.hash)
  const night = view.netByToken.get(NIGHT_TOKEN_TYPE)
  const others = [...view.netByToken.entries()].filter(([token]) => token !== NIGHT_TOKEN_TYPE)

  const directionLabel = t(
    ({sent: 'cardanoActivity.sent', received: 'cardanoActivity.received', self: 'cardanoActivity.self'} as const)[
      view.direction
    ],
  )

  // The unit follows the magnitude: a one-speck fee rendered as DUST reads "0 DUST", which says the
  // transaction was free. See fee-display.
  const feeLabel = (specks: bigint): string => {
    const {amount, unit, decimals} = midnightFeeDisplay(specks)
    return format(amount, {preset: 'cryptoFee', currency: unit, decimals})
  }

  const signed = (amount: bigint): string =>
    `${amount > 0n ? '+' : amount < 0n ? '-' : ''}${format(amount < 0n ? -amount : amount, {
      preset: 'cryptoTxDetail',
      currency: 'NIGHT',
      decimals: NIGHT_DISPLAY_DECIMALS,
    })}`

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <SectionHeader title={directionLabel} />
        <Card style={styles.card}>
          {night === undefined ? null : <DataRow label={t('midnightTx.amount')} value={signed(night)} size="md" />}
          {others.map(([token, amount]) => (
            <DataRow key={token} label={truncateCompact(token)} value={signed(amount)} />
          ))}
          <DataRow
            label={t('midnightTx.status')}
            // Pending is a real state here, not a spinner: the indexer has the transaction but no
            // block for it. Saying "failed" or showing nothing would both be wrong.
            value={view.confirmed ? t('midnightTx.confirmed') : t('midnightTx.pending')}
          />
          {view.blockHeight === undefined ? null : (
            // A block height is a count, not money: the fiat presets want an ISO 4217 currency and
            // Hermes throws `Malformed currency code` without one. formatGroupedInteger is the
            // Hermes-safe integer path (CLAUDE.md).
            <DataRow label={t('midnightTx.block')} value={formatGroupedInteger(view.blockHeight, numberLocale)} />
          )}
          {view.timestamp === undefined ? null : (
            <DataRow label={t('midnightTx.time')} value={new Date(view.timestamp).toLocaleString()} />
          )}
          <DataRow
            label={t('midnightTx.fee')}
            // An absent fee is "the indexer did not say", never "free" — and on a sponsored send it
            // was never the sender's to begin with.
            //
            // ⚠️ SPECK, the atomic unit of **DUST**, in the indexer's own words
            // (`RegularTransaction.fee`). Midnight fees are DUST-only, so rendering this as NIGHT
            // named the wrong token at 10⁹ times the wrong scale.
            value={view.fee === undefined ? t('midnightTx.feeUnknown') : feeLabel(view.fee)}
          />
          <DataRow label={t('midnightTx.network')} value={view.network} />
          {/* The counts, not a UTxO table. Cardano earns a per-input breakdown because min-ada,
              collateral and a fee taken from the inputs make selection something you can get wrong;
              here the fee is somebody else's DUST and the recipient gets exactly the amount. What is
              worth knowing is how much of *this wallet* the transaction consumed — and the feed is
              address-scoped, so the holder's side is all there is to state. */}
          <DataRow
            label={t('midnightTx.ourOutputsSpent')}
            value={formatGroupedInteger(view.ourSpentCount, numberLocale)}
          />
          <DataRow
            label={t('midnightTx.ourOutputsReturned')}
            value={formatGroupedInteger(view.ourCreatedCount, numberLocale)}
          />
        </Card>
      </View>

      <View style={styles.footer}>
        <View style={styles.idBlock}>
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('cardanoActivity.txId')}
          </Typography>
          <Copiable text={view.hash} feedback={t('common.labels.copied')} testID="midnight-tx-id-copy">
            <Typography variant="bodySm_regular" style={styles.hash} numberOfLines={1}>
              {truncateWide(view.hash)}
            </Typography>
          </Copiable>
        </View>

        {view.counterparties.length === 0 ? null : (
          <View style={styles.idBlock}>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('midnightTx.counterparties')}
            </Typography>
            {view.counterparties.map((address) => (
              <Copiable key={address} text={address} feedback={t('common.labels.copied')}>
                <Typography variant="bodySm_regular" style={styles.hash} numberOfLines={1}>
                  {truncateWide(address)}
                </Typography>
              </Copiable>
            ))}
          </View>
        )}

        {explorerUrl === null ? null : (
          <Button
            variant="nakedDefault"
            size="sm"
            label={t('cardanoActivity.viewOnExplorer')}
            rightIcon="arrowUpRight"
            onPress={() => void Linking.openURL(explorerUrl)}
            testID="midnight-tx-explorer-link"
          />
        )}
      </View>
    </SafeAreaViewWrapper>
  )
}
