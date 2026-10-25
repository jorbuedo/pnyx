/**
 * Send funnel — allocation step (multi-recipient only): distribute each
 * basket asset's total across the recipients. The Review CTA arms once every
 * positive basket amount is exactly attributed; the authoritative validation
 * (min-ADA per output, aggregate balance) still runs at review build.
 *
 * @module
 */

import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AssetAmountRow} from '../../../components/AssetAmountRow'
import {Button} from '../../../components/Buttons/Button'
import {Card} from '../../../components/Card'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {Typography} from '../../../components/Typography'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useFormat, useI18n, useNumberParser} from '../../../providers'
import {useTokenInfos} from '../../../services/cardano-assets/hooks'
import {truncateCompact} from '../../../utils/truncate'
import {useSendFlow} from './SendFlowProvider'
import {ADA_ID, allocationRemaining, basketFullyAllocated, type SendTarget, setTargetAmount} from './state'

const ADA_DECIMALS = 6

/** Exact bigint→plain-decimal string (no grouping) for seeding the inputs. */
const canonicalToDecimal = (value: bigint, decimals: number): string => {
  if (decimals === 0) return value.toString()
  const s = value.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac.length > 0 ? `${int}.${frac}` : int
}

const truncateAddress = (address: string): string => truncateCompact(address)

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  hint: {color: colors.textAlternative},
  remainingCard: {padding: spacing.spacing16, gap: spacing.spacing8},
  remainingRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  remainingLabel: {color: colors.textDefault},
  remainingValue: {color: colors.textAlternative},
  remainingDone: {color: colors.successDefault},
  remainingOver: {color: colors.errorDefault},
  recipientCard: {padding: spacing.spacing16, gap: spacing.spacing12},
  recipientHeader: {color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.7},
  recipientAddress: {color: colors.textDefault},
}))

export const AllocateScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  const parseNumber = useNumberParser()
  const {state, setState, basket, startReview, reviewBusy, queueCurrent, canQueueMore} = useSendFlow()
  /** Funding wallets recorded on the send — the same test the amounts step makes. */
  const composing = state.sources.length > 0

  const assetIds = [...basket.amounts.entries()].filter(([, total]) => total > 0n).map(([id]) => id)
  const {infos} = useTokenInfos(assetIds)

  const decimalsOf = (assetId: string) => (assetId === ADA_ID ? ADA_DECIMALS : (infos.get(assetId)?.decimals ?? 0))
  const labelOf = (assetId: string) =>
    assetId === ADA_ID ? adaTicker : (infos.get(assetId)?.label ?? assetId.slice(0, 12))

  const keyOf = (targetIndex: number, assetId: string) => `${targetIndex}:${assetId}`
  // Seed inputs from any allocation already on the targets (back-navigation).
  const [text, setText] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {}
    state.targets.forEach((target: SendTarget, targetIndex: number) => {
      for (const [assetId, quantity] of target.amounts) {
        if (quantity > 0n) {
          seeded[keyOf(targetIndex, assetId)] = canonicalToDecimal(quantity, decimalsOf(assetId))
        }
      }
    })
    return seeded
  })

  const fullyAllocated = basketFullyAllocated(basket, state.targets)

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('cardanoSend.review')}
            onPress={() => void startReview()}
            fullWidth
            size="xl"
            isLoading={reviewBusy}
            isDisabled={reviewBusy || !fullyAllocated}
            testID="send-allocate-review"
          />
          {/* Compose and queue exclude each other, the same rule the amounts step applies:
              a queued leg chains on its own change, which a transaction still owing other
              people's signatures cannot do. This step did not apply it, and because the
              co-funded branch is taken before the build mode is read, Queue silently did
              what Review does — a button that named one thing and performed another. */}
          {canQueueMore && !composing ? (
            <Button
              label={t('cardanoSend.queue.action')}
              variant="secondary"
              onPress={() => void queueCurrent()}
              fullWidth
              isDisabled={reviewBusy || !fullyAllocated}
              testID="send-allocate-queue"
            />
          ) : null}
        </StickyFooter>
      }
    >
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('cardanoSend.allocateHint')}
      </Typography>

      <Card style={styles.remainingCard}>
        {assetIds.map((assetId) => {
          const remaining = allocationRemaining(basket, state.targets, assetId)
          const decimals = decimalsOf(assetId)
          return (
            <View key={assetId} style={styles.remainingRow}>
              <Typography variant="bodySm_medium" style={styles.remainingLabel}>
                {labelOf(assetId)}
              </Typography>
              <Typography
                variant="bodySm_regular"
                style={
                  remaining < 0n
                    ? styles.remainingOver
                    : remaining === 0n
                      ? styles.remainingDone
                      : styles.remainingValue
                }
                testID={`allocate-remaining-${assetId}`}
              >
                {remaining < 0n
                  ? t('cardanoSend.allocateOver', {
                      amount: format(-remaining, {preset: 'cryptoBalance', currency: labelOf(assetId), decimals}),
                    })
                  : t('cardanoSend.allocateRemaining', {
                      amount: format(remaining, {preset: 'cryptoBalance', currency: labelOf(assetId), decimals}),
                    })}
              </Typography>
            </View>
          )
        })}
      </Card>

      {state.targets.map((target, targetIndex) => (
        <Card
          // biome-ignore lint/suspicious/noArrayIndexKey: targets are positional; identity is the slot
          key={targetIndex}
          variant="outlined"
          style={styles.recipientCard}
        >
          <Typography variant="bodySm_medium" style={styles.recipientHeader}>
            {`${t('cardanoSend.recipient')} #${targetIndex + 1}`}
          </Typography>
          <Typography variant="bodySm_regular" style={styles.recipientAddress} numberOfLines={1}>
            {target.resolvedName ?? truncateAddress(target.address.trim())}
          </Typography>
          {assetIds.map((assetId) => {
            const decimals = decimalsOf(assetId)
            const key = keyOf(targetIndex, assetId)
            const parsed = parseNumber(text[key] ?? '', {decimals})
            return (
              <AssetAmountRow
                key={assetId}
                assetId={assetId === ADA_ID ? '' : assetId}
                label={labelOf(assetId)}
                value={parsed.inputValue}
                onChangeText={(value) => {
                  setText((prev) => ({...prev, [key]: value}))
                  const next = parseNumber(value, {decimals})
                  setState((s) => setTargetAmount(s, targetIndex, assetId, next.isEmpty ? 0n : next.canonical))
                }}
                testID={`send-allocate-${targetIndex}-${assetId}`}
              />
            )
          })}
        </Card>
      ))}
    </SafeAreaViewWrapper>
  )
}
