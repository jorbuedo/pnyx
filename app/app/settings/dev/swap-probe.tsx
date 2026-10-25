/**
 * Dev launcher for the swap rail, plus the partner readout.
 *
 * The Swap action is hidden on the Wallets screen for a watch-only wallet — it
 * cannot sign, and offering the action would be a promise the app cannot keep.
 * But a watch-only wallet CAN quote, build and review a swap (it is stopped at
 * the signing ceremony, like Send and dApp), which is what makes it the right
 * wallet for driving the rail against real mainnet routes.
 *
 * So the two buttons are doors to the REAL screens — this renders none of its own.
 * Opened from **Menu → Developer → Swap rail**, like every other probe: the row is
 * its entry point, and `dev-tools-rows.test.ts` is what keeps it there.
 *
 * ⚠️ The partner block below answers §0 of the integration plan: SteelSwap
 * derives a swap's fee channel from the AUTHENTICATED CALLER, and a key mint
 * auto-provisions a `self_serve` partner for whichever wallet minted it. So
 * `kind` here tells you whose principal a swap from this install would pay:
 * `self_serve` means this device's own auto-provisioned account, NOT Pnyx.
 *
 * @module
 */

import {Effect} from 'effect'
import {useRouter} from 'expo-router'
import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../src/components/Buttons/Button'
import {SafeAreaViewWrapper} from '../../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../../src/components/Typography'
import {logger} from '../../../src/logger'
import {
  type FeeSummary,
  fetchFeeSummary,
  fetchPartnerProfile,
  type PartnerProfile,
} from '../../../src/services/cardano-swap/fees-client'

export default function SwapProbeScreen() {
  const router = useRouter()
  const [partner, setPartner] = useState<PartnerProfile | null>(null)
  const [fees, setFees] = useState<FeeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const now = Date.now()
    void Promise.all([
      Effect.runPromise(Effect.either(fetchPartnerProfile(now))),
      Effect.runPromise(Effect.either(fetchFeeSummary(now))),
    ]).then(([p, f]) => {
      if (!active) return
      if (p._tag === 'Right') setPartner(p.right)
      else {
        logger.warn('Partner profile unavailable', {origin: 'swap-probe', error: p.left.reason})
        setError(p.left.reason)
      }
      if (f._tag === 'Right') setFees(f.right)
      else logger.warn('Fee summary unavailable', {origin: 'swap-probe', error: f.left.reason})
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Typography variant="bodySm_regular" style={styles.note}>
        Dev launcher for the Cardano swap rail. Both screens are the real ones.
      </Typography>
      <View style={styles.actions}>
        <Button label="Swap" onPress={() => router.push('/wallet/swap')} fullWidth testID="probe-open-swap" />
        <Button
          label="Orders"
          variant="secondary"
          onPress={() => router.push('/wallet/orders' as never)}
          fullWidth
          testID="probe-open-orders"
        />
      </View>

      <Typography variant="bodySm_medium" style={styles.heading}>
        SteelSwap principal
      </Typography>
      {partner === null ? (
        <Typography variant="bodyXs_regular" style={styles.note}>
          {error ?? 'Reading…'}
        </Typography>
      ) : (
        <View testID="probe-partner">
          <Row label="kind" value={partner.kind} />
          <Row label="partner id" value={partner.partnerId ?? '—'} />
          <Row label="name" value={partner.name ?? '—'} />
          <Row label="fee bps" value={partner.feeBps === null ? '—' : String(partner.feeBps)} />
          <Row label="reward address" value={partner.rewardAddress ?? '—'} />
          <Row
            label="requests today"
            value={`${partner.requestsToday}${partner.dailyQuota === null ? '' : ` / ${partner.dailyQuota}`}`}
          />
          <Row label="within quota" value={partner.withinQuota ? 'yes' : 'NO'} />
          <Row label="fees collected (lovelace)" value={fees === null ? '—' : fees.feeValue} />
          <Row label="fee-bearing txs" value={fees === null ? '—' : String(fees.txCount)} />
        </View>
      )}
      <Typography variant="bodyXs_regular" style={styles.note}>
        `self_serve` means this install's own auto-provisioned account — a swap from here does not pay Pnyx.
      </Typography>
    </SafeAreaViewWrapper>
  )
}

const Row = ({label, value}: {readonly label: string; readonly value: string}) => (
  <View style={styles.row}>
    <Typography variant="bodyXs_regular" style={styles.note}>
      {label}
    </Typography>
    <Typography variant="bodyXs_medium" style={styles.value} numberOfLines={1}>
      {value}
    </Typography>
  </View>
)

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing24, gap: spacing.spacing12},
  note: {color: colors.textMuted},
  heading: {marginTop: spacing.spacing16},
  actions: {gap: spacing.spacing12},
  row: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.spacing12, paddingVertical: 2},
  value: {flexShrink: 1, textAlign: 'right'},
}))
