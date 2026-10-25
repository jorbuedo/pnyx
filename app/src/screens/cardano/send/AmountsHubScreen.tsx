/**
 * Send funnel step 2 — the asset basket hub: chosen assets as tappable rows
 * (each pushes the per-token amount editor), add-token via the shared asset
 * picker sheet, and the memo. With one recipient the CTA builds the review;
 * with several it continues to the allocate step.
 *
 * @module
 */

import {useRouter} from 'expo-router'
import {useEffect, useMemo, useState} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {TextInput} from '../../../components/TextInput'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {useAssetFiat, useTokenInfos} from '../../../services/cardano-assets/hooks'
import {AssetPickerSheet} from './AssetPickerSheet'
import {SendAssetRows} from './SendAssetRows'
import {useSendFlow} from './SendFlowProvider'
import {composerSource, SendSourcesCard} from './SendSourcesCard'
import {
  ADA_ID,
  basketAddToken,
  basketRemoveToken,
  basketSetAmount,
  clearBasketSendAll,
  type SendBasket,
  setMemo,
} from './state'

const ADA_DECIMALS = 6

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  right: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing12},
  amountCol: {alignItems: 'flex-end'},
  fiat: {color: colors.textAlternative},
  maxTag: {color: colors.primaryDefault},
}))

export const AmountsHubScreen = () => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const router = useRouter()
  const {adaTicker} = useNetworkCapabilities()
  const {
    state,
    setState,
    basket,
    setBasket,
    programmableAssetIds,
    pickerAssetIds,
    balanceOfSource,
    startReview,
    reviewBusy,
    queueCurrent,
    canQueueMore,
  } = useSendFlow()
  const [pickerOpen, setPickerOpen] = useState(false)

  const assetIds = [...basket.amounts.keys()]
  const {infos} = useTokenInfos(assetIds)
  const [now] = useState(() => Date.now())
  const fiatOf = useAssetFiat([], now)

  const multiRecipient = state.targets.length > 1
  const {walletGroups, selectedWalletGroup} = useWalletList()
  const selectedGroupId = selectedWalletGroup?.groupId ?? null
  const selectedName = selectedWalletGroup?.name ?? selectedGroupId ?? ''
  /** Compose mode is on when the send has funding wallets recorded. */
  const composing = state.sources.length > 0
  /** No second wallet, nothing to compose with. */
  const canCompose = (walletGroups?.length ?? 0) > 1 && selectedGroupId !== null

  /**
   * In compose mode the wallets decide the total, so the basket follows them.
   *
   * Typing the total here as well would be the second place to enter one number — the
   * thing the accordion exists to remove — and the two could disagree, which the build
   * would have to refuse. Derived instead, so they cannot.
   */
  const composedTotals = useMemo(() => {
    const totals = new Map<string, bigint>([[ADA_ID, 0n]])
    for (const source of state.sources) {
      totals.set(ADA_ID, (totals.get(ADA_ID) ?? 0n) + source.lovelace)
      // Tokens too, not just ADA. Syncing lovelace alone left a contributed token out of
      // the basket the allocate step splits and the build balances against, so it reached
      // no output and the planner swept it into the composer's change.
      for (const [assetId, quantity] of source.assets) {
        totals.set(assetId, (totals.get(assetId) ?? 0n) + quantity)
      }
    }
    return totals
  }, [state.sources])

  useEffect(() => {
    if (!composing) return
    setBasket((b) => {
      const sameSize = b.amounts.size === composedTotals.size
      if (sameSize && [...composedTotals].every(([id, total]) => b.amounts.get(id) === total)) return b
      // Rebuilt rather than merged: a token removed from the last wallet holding it has to
      // leave the basket too, and setting amounts one by one would leave it behind at its
      // old quantity for the allocate step to split.
      const cleared: SendBasket = {...b, amounts: new Map<string, bigint>()}
      return [...composedTotals].reduce<SendBasket>((next, [id, total]) => basketSetAmount(next, id, total), cleared)
    })
  }, [composing, composedTotals, setBasket])

  const decimalsOf = (assetId: string) => (assetId === ADA_ID ? ADA_DECIMALS : (infos.get(assetId)?.decimals ?? 0))
  const labelOf = (assetId: string) =>
    assetId === ADA_ID ? adaTicker : (infos.get(assetId)?.label ?? assetId.slice(0, 12))

  const openEditor = (assetId: string) =>
    router.push(`/wallet/send/edit-amount?asset=${assetId === ADA_ID ? 'ada' : encodeURIComponent(assetId)}` as never)

  const onNext = () => {
    if (multiRecipient) {
      // Send-all cannot be split across recipients deterministically.
      setBasket(clearBasketSendAll)
      router.push('/wallet/send/allocate' as never)
    } else {
      // Never `void` a failing review: an unexpected error here used to leave the
      // button doing nothing at all, with no message and no log.
      void startReview().catch((e: unknown) => {
        logger.error('Send review failed to start', {origin: 'AmountsHubScreen', error: String(e)})
        showToast({variant: 'error', message: t('cardanoSend.errors.reviewFailed')})
      })
    }
  }

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={multiRecipient ? t('common.buttons.continue') : t('cardanoSend.review')}
            onPress={onNext}
            fullWidth
            size="xl"
            isLoading={reviewBusy}
            isDisabled={reviewBusy}
            testID="send-amounts-next"
          />
          {/* Compose and queue exclude each other. A queued leg chains on its own change,
              which a transaction still owing other people's signatures cannot do — so the
              queue disappears the moment this becomes co-funded. */}
          {!composing && !multiRecipient && canQueueMore ? (
            <Button
              label={t('cardanoSend.queue.action')}
              variant="secondary"
              onPress={() => void queueCurrent()}
              fullWidth
              isDisabled={reviewBusy}
              testID="send-amounts-queue"
            />
          ) : null}
          {/* Only worth offering when there is a second wallet to fund from. */}
          {canCompose ? (
            <Button
              label={composing ? t('coFund.composeOff') : t('coFund.compose')}
              variant={composing ? 'nakedDefault' : 'secondary'}
              onPress={() =>
                setState((prev) => ({
                  ...prev,
                  sources:
                    prev.sources.length > 0
                      ? []
                      : selectedGroupId === null
                        ? []
                        : [composerSource(selectedGroupId, selectedName)],
                }))
              }
              fullWidth
              isDisabled={reviewBusy}
              testID="send-amounts-compose"
            />
          ) : null}
        </StickyFooter>
      }
    >
      {composing ? (
        <SendSourcesCard
          sources={state.sources}
          onChange={(sources) => setState((prev) => ({...prev, sources}))}
          balanceOf={balanceOfSource}
          decimalsOf={decimalsOf}
          labelOf={labelOf}
          onEdit={(groupId, assetId) =>
            router.push(
              `/wallet/send/edit-amount?asset=${assetId === ADA_ID ? 'ada' : encodeURIComponent(assetId)}&party=${encodeURIComponent(groupId)}` as never,
            )
          }
        />
      ) : null}
      {/* The flat list is the ordinary send's. In compose mode the totals are the sum of
          the wallets above, so typing one here as well would be the second place to enter
          the same number. */}
      {composing ? null : (
        <SendAssetRows
          amounts={basket.amounts}
          sendAll={basket.sendAll}
          decimalsOf={decimalsOf}
          labelOf={labelOf}
          fiatOf={(assetId, quantity, decimals) => (assetId === ADA_ID ? fiatOf('', quantity, decimals) : null)}
          onEdit={openEditor}
          onRemove={(assetId) => setBasket((b) => basketRemoveToken(b, assetId))}
          testIDPrefix="send-asset-row"
        />
      )}

      {composing ? null : (
        <Button
          label={t('cardanoSend.addToken')}
          variant="nakedDefault"
          leftIcon="plus"
          onPress={() => setPickerOpen(true)}
          testID="send-add-token"
        />
      )}

      <TextInput
        fullWidth
        label={t('cardanoSend.memo')}
        value={state.memo}
        onChange={(text) => setState((s) => setMemo(s, text))}
        testID="cardano-send-memo"
      />

      <AssetPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        assetIds={pickerAssetIds.filter((id) => !basket.amounts.has(id))}
        programmableAssetIds={programmableAssetIds}
        programmableReason={t('cardanoSend.programmableUnavailable')}
        onSelect={(assetId) => {
          setBasket((b) => basketAddToken(b, assetId))
          setPickerOpen(false)
          openEditor(assetId)
        }}
      />
    </SafeAreaViewWrapper>
  )
}
