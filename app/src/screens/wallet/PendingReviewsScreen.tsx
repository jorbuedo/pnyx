/**
 * Pending-review inbox: the resumable in-flight signing work for the selected
 * wallet group — under-quorum co-sign envelopes and multi-leg signing
 * continuations — merged newest-first. Resume a cosign by re-opening the co-sign
 * screen by id; resume a continuation (best-effort) by re-running its remaining
 * legs when the payload can be reconstructed. Dismiss drops the persisted record.
 *
 * @module
 */

import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'
import {useRouter} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {FlatList} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {EmptyState} from '../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {useLocalWalletKeys} from '../../hooks/useLocalWalletKeys'
import {useNetworkCapabilities} from '../../hooks/useNetworkCapabilities'
import {usePendingReviews} from '../../hooks/usePendingReviews'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {useFormat, useI18n, useWalletAddress, useWalletList} from '../../providers'
// No signing imports here on purpose: this screen surfaces pending work and
// dismisses it, and the co-sign path signs from its own reviewed screen. See the
// note in `services/cardano/pending/aggregate.ts`.
import {getCardanoRail} from '../../services/cardano'
import {
  type ContinuationReconciliation,
  platformContinuationStore,
  reconcileContinuation,
  storedRequests,
} from '../../services/cardano/continuation'
import {platformCosignRegistry} from '../../services/cardano/cosign'
import type {PendingContinuationItem, PendingReviewItem} from '../../services/cardano/pending'
import {awaitingHere} from '../../services/cardano/pending/awaiting'
import {PendingReviewRow} from './PendingReviewRow'

const ADA_DECIMALS = 6

/** The first stashed leg's body, for the row summary — `null` when there is none to decode. */
const firstLegBodyHex = (item: PendingContinuationItem): string | null => {
  const first = storedRequests(item.record)?.[0]
  const payload = (first as {payload?: {_tag?: string; bodyHex?: string}} | undefined)?.payload
  return payload?._tag === 'CardanoTx' && typeof payload.bodyHex === 'string' ? payload.bodyHex : null
}

export const PendingReviewsScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  const router = useRouter()
  const {showToast} = useToast()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {getDeriveOnlyAddresses} = useWalletAddress()
  const groupId = selectedWalletGroup?.groupId ?? null
  const {items, loading, refresh} = usePendingReviews(groupId)
  // Whose signature each row wants, derived from the roster rather than the filing group —
  // see `awaitingHere`. The inbox lists every wallet's co-signs now, so this is what tells
  // them apart.
  const localWallets = useLocalWalletKeys()

  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [verdicts, setVerdicts] = useState<Record<string, ContinuationReconciliation>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  // Fee + output-count summary for every row (pure decode, no layer). A continuation is
  // summarised from its first leg — the row used to show nothing at all for those.
  useEffect(() => {
    const bodies = items.map((item) =>
      item.kind === 'cosign'
        ? ([item.id, item.envelope.bodyHex] as const)
        : ([item.id, firstLegBodyHex(item)] as const),
    )
    if (bodies.length === 0) return
    let active = true
    void Promise.all(
      bodies.map(async ([id, bodyHex]) => {
        if (bodyHex === null) return [id, ''] as const
        try {
          const {body} = await Effect.runPromise(Inspect.txBody(bodyHex))
          const feeText = format(body.fee, {preset: 'cryptoFee', currency: adaTicker, decimals: ADA_DECIMALS})
          const outputs = t('pending.outputs', {count: body.outputs.length})
          return [id, `${t('pending.fee')} ${feeText} · ${outputs}`] as const
        } catch (e: unknown) {
          // An empty summary is what a row with nothing to say looks like, so an undecodable
          // body silently becomes an ordinary-looking entry.
          logger.warn('Pending review body could not be inspected; its row shows no summary', {
            origin: 'PendingReviewsScreen',
            id,
            error: String(e),
          })
          return [id, ''] as const
        }
      }),
    ).then((entries) => {
      if (active) setSummaries((prev) => ({...prev, ...Object.fromEntries(entries)}))
    })
    return () => {
      active = false
    }
  }, [items, format, t, adaTicker])

  // Ask the chain what actually happened to each continuation's legs. A record's own step
  // count is a belief, and a stale one strands work: a leg can be in a block while the record
  // says nothing was signed, and a leg it still offers can have become unsubmittable.
  useEffect(() => {
    const continuations = items.filter((i): i is PendingContinuationItem => i.kind === 'continuation')
    if (continuations.length === 0 || groupId === null) return
    let active = true
    void (async () => {
      try {
        const derived = await getDeriveOnlyAddresses()
        const address = derived.cardano ?? null
        if (address === null) return
        const railHandle = getCardanoRail(groupId, address, undefined, {accountIndex: selectedAccountIndex})
        if (railHandle === null) return
        const rail = await railHandle
        for (const item of continuations) {
          const verdict = await Effect.runPromise(reconcileContinuation(rail, item.record))
          if (!active) return
          // Nothing left to do: the whole ceremony is on chain, so the record is noise.
          if (verdict.outcome === 'complete') {
            await Effect.runPromise(Effect.ignore(platformContinuationStore().remove(groupId, item.id)))
            if (active) refresh()
            continue
          }
          setVerdicts((prev) => ({...prev, [item.id]: verdict}))
        }
      } catch (e: unknown) {
        // ⚠️ Nothing above can be caught by a caller: this whole body is a `void (async …)()`, so a
        // rejection here is an unhandled one and reaches the user as a red box. The address read is
        // the one that does it in practice — the store closes under it on a network switch — but the
        // rail and the reconcile awaits are no safer.
        logger.warn('Could not reconcile pending continuations', {
          origin: 'PendingReviewsScreen',
          groupId,
          error: String(e),
        })
      }
    })()
    return () => {
      active = false
    }
  }, [items, groupId, getDeriveOnlyAddresses, refresh, selectedAccountIndex])

  const dismiss = useCallback(
    async (item: PendingReviewItem) => {
      if (groupId === null) return
      setBusyId(item.id)
      try {
        if (item.kind === 'cosign') await Effect.runPromise(platformCosignRegistry().remove(item.id))
        else await Effect.runPromise(platformContinuationStore().remove(groupId, item.id))
        refresh()
      } catch (e: unknown) {
        // The toast tells the user; nothing told us which store refused.
        logger.warn('Pending review could not be dismissed', {
          origin: 'PendingReviewsScreen',
          id: item.id,
          kind: item.kind,
          error: String(e),
        })
        showToast({variant: 'error', message: t('pending.dismissError')})
      } finally {
        setBusyId(null)
      }
    },
    [groupId, refresh, showToast, t],
  )

  // Only co-sign resumes, and it resumes *into a review*. Continuations cannot be
  // signed from here — they stash unsigned bytes, and signing those without
  // showing them is the hole this closes (Phase 16 item 41). `canResume` is
  // statically `false` for a continuation, so this is exhaustive by type.
  const onResume = useCallback(
    (item: PendingReviewItem) => {
      if (item.kind !== 'cosign') return
      router.push(`/wallet/cosign?pendingId=${item.id}` as Parameters<typeof router.push>[0])
    },
    [router],
  )

  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={items.length === 0 ? styles.center : styles.list}
        renderItem={({item}) => (
          <PendingReviewRow
            item={item}
            subtitle={summaries[item.id] ?? null}
            {...(item.kind === 'cosign' ? {awaiting: awaitingHere(item.envelope, localWallets)} : {})}
            {...(item.kind === 'continuation' && verdicts[item.id] !== undefined
              ? {reconciled: verdicts[item.id] as ContinuationReconciliation}
              : {})}
            onResume={() => onResume(item)}
            onDismiss={() => void dismiss(item)}
            busy={busyId === item.id}
          />
        )}
        ListEmptyComponent={
          loading ? null : <EmptyState icon="pending" title={t('pending.empty')} testID="pending-empty" />
        }
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {flexGrow: 1},
  list: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12},
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.spacing24,
  },
}))
