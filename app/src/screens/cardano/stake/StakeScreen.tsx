/**
 * Staking + governance hub. Two modes on one screen: setup (unregistered —
 * two-step pool + DRep selection, both required before the combined
 * registration tx) and delegated (current targets with per-target Change,
 * claimable rewards with Withdraw, and Unstake). Every action funnels into
 * the shared review/ceremony screen — this screen never signs.
 *
 * @module
 */

import {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import {Cause, Effect, Exit, Option} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {ActivityIndicator, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {Card} from '../../../components/Card'
import {EmptyState} from '../../../components/EmptyState'
import {PoolDrepAvatar} from '../../../components/PoolDrepAvatar'
import {DataRow} from '../../../components/Row'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../../components/SectionHeader'
import {StickyFooter} from '../../../components/StickyFooter'
import {Typography} from '../../../components/Typography'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {useCardanoSigningLayer} from '../../../hooks/useCardanoSigningLayer'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useToast} from '../../../hooks/useToast'
import type {TranslationKey} from '../../../i18n/types'
import {logger} from '../../../logger'
import {useFormat, useI18n} from '../../../providers'
import {type CardanoRail, pendingTxFrom} from '../../../services/cardano'
import {authorityStakeContext} from '../../../services/cardano/account'
import {platformCosignRegistry} from '../../../services/cardano/cosign'
import {findPendingStakeChange} from '../../../services/cardano/staking/pending-stake'
import {
  buildDelegationReview,
  buildUnstakeReview,
  buildWithdrawReview,
  fetchStakeAccountState,
  type StakeReview,
} from '../../../services/cardano/staking/staking-flow'
import {decideDelegation, type StakeAccountState} from '../../../services/cardano/staking/state'
import {cexplorerLogoUrl, drepTargetBech32, useDRepInfo, usePoolInfo} from '../../../services/cardano-pool-drep'
import {buildGatherContext, withGather} from '../multisig-gather'
import {registerReviewTicket} from '../review-handoff'
import {type DRepChoice, DrepPickerSheet, truncateDrepId} from './DrepPickerSheet'
import {PoolPickerSheet} from './PoolPickerSheet'
import {claimStakePrefill} from './stake-prefill-handoff'

const ADA_DECIMALS = 6

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing12},
  stateContent: {flexGrow: 1, justifyContent: 'center'},
  center: {paddingVertical: spacing.spacing32, alignItems: 'center', gap: spacing.spacing12},
  muted: {color: colors.textAlternative},
  intro: {padding: spacing.spacing16, gap: spacing.spacing8},
  stepRow: {flexDirection: 'row', gap: spacing.spacing8},
  stepNumber: {color: colors.primaryDefault},
  stepBody: {flex: 1},
  targetCard: {padding: spacing.spacing16, gap: spacing.spacing8},
  targetRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing12},
  targetRowText: {flex: 1, gap: spacing.spacing2},
  targetValue: {color: colors.textDefault},
  targetSub: {color: colors.textAlternative},
  targetMetrics: {gap: spacing.spacing4, marginTop: spacing.spacing4},
  rewardsCard: {padding: spacing.spacing16},
  rewardsRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  timing: {color: colors.textAlternative},
  unstake: {marginTop: spacing.spacing8},
}))

export const StakeScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  const router = useRouter()
  const {prefill: prefillParam} = useLocalSearchParams<{prefill?: string}>()
  const {showToast} = useToast()
  const {rail, groupId, shared, loading: railLoading, unavailable} = useCardanoRail()
  const {resolveSigningLayer, signerKind} = useCardanoSigningLayer()

  const [state, setState] = useState<StakeAccountState | null>(null)
  const [stateFailed, setStateFailed] = useState(false)
  const [stateNonce, setStateNonce] = useState(0)
  const [busy, setBusy] = useState(false)

  /**
   * The chosen pool as its *id*, with metadata resolved separately below —
   * deliberately the same shape as the on-chain `state.currentPool` beside it.
   * Holding a whole `PoolInfo` meant a pool could only be chosen if the indexed
   * list happened to carry it, so a target arriving from a link had nowhere to go
   * without inventing the fields the list would have supplied.
   */
  const [pendingPoolId, setPendingPoolId] = useState<string | null>(null)
  const [pendingDrep, setPendingDrep] = useState<DRepChoice | null>(null)
  const [poolPickerOpen, setPoolPickerOpen] = useState(false)
  const [drepPickerOpen, setDrepPickerOpen] = useState(false)
  /**
   * A staking change already gathering signatures for this wallet.
   *
   * The rest of this screen reads the chain, and the chain does not move until a
   * gathered transaction is submitted — so without this the screen shows the old
   * state and builds a second certificate for the same decision.
   */
  const [pendingStakeId, setPendingStakeId] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stateNonce` is the manual refresh trigger.
  useEffect(() => {
    let active = true
    const stake = rail === null ? undefined : authorityStakeContext(rail.account.authority)
    if (groupId === null || stake === undefined) {
      setPendingStakeId(null)
      return
    }
    void Effect.runPromise(
      platformCosignRegistry()
        .list(groupId)
        .pipe(
          Effect.flatMap((entries) => findPendingStakeChange(entries, stake.scriptHashHex)),
          Effect.orElseSucceed(() => null),
        ),
    ).then((id) => {
      if (active) setPendingStakeId(id)
    })
    return () => {
      active = false
    }
  }, [rail, groupId, stateNonce])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stateNonce` is the manual refresh trigger.
  useEffect(() => {
    let active = true
    if (rail === null) return
    setStateFailed(false)
    void Effect.runPromise(fetchStakeAccountState(rail))
      .then((s) => {
        if (active) setState(s)
      })
      .catch((e) => {
        logger.warn('Stake account state read failed', {origin: 'StakeScreen', error: String(e)})
        if (active) setStateFailed(true)
      })
    return () => {
      active = false
    }
  }, [rail, stateNonce])

  /**
   * A target handed in from outside — a delegation card tapped in a message, or a
   * scanned QR. Claimed once and evicted, so returning to this screen does not
   * re-apply something the user has since changed.
   *
   * It seeds the pickers and nothing else: the confirm button, the review screen
   * and the ceremony all still run. A link cannot delegate.
   */
  const prefillClaimed = useRef(false)
  useEffect(() => {
    if (prefillClaimed.current || prefillParam === undefined) return
    prefillClaimed.current = true
    const prefill = claimStakePrefill(prefillParam)
    if (prefill === undefined) return
    if (prefill.poolId !== null) setPendingPoolId(prefill.poolId)
    if (prefill.drep !== null) {
      const target = prefill.drep
      // The link supplies the target; the *name* is ours to render, never theirs
      // to assert. Abstain and No confidence have no id to show.
      const label =
        target.kind === 'abstain'
          ? t('cardanoStaking.abstain')
          : target.kind === 'no_confidence'
            ? t('cardanoStaking.noConfidence')
            : truncateDrepId(drepTargetBech32(target) ?? '')
      setPendingDrep({target, label})
    }
    // `t` is in here honestly rather than suppressed: the ref guard above makes a
    // re-run a no-op, so a locale change cannot re-claim an evicted prefill.
  }, [prefillParam, t])

  const currentDrepId = state?.currentDrep !== null && state !== null ? drepTargetBech32(state.currentDrep) : null
  const {info: currentPoolInfo} = usePoolInfo(state?.currentPool ?? undefined)
  const {info: pendingPoolInfo} = usePoolInfo(pendingPoolId ?? undefined)
  const {info: currentDrepInfo} = useDRepInfo(currentDrepId ?? undefined)

  const selection = useMemo(
    () => ({
      pool: pendingPoolId,
      drep: pendingDrep?.target ?? null,
    }),
    [pendingPoolId, pendingDrep],
  )
  const action = state !== null ? decideDelegation(state, selection) : ({kind: 'noop'} as const)
  // First-time setup requires BOTH targets: without a DRep delegation the
  // staking rewards can't be withdrawn (Conway), so we don't offer pool-only.
  const canConfirm =
    !busy &&
    state !== null &&
    action.kind !== 'noop' &&
    (state.registered || (pendingPoolId !== null && pendingDrep !== null))

  const submit = useCallback(
    async (
      build: (
        rail: CardanoRail,
      ) => Effect.Effect<StakeReview, {readonly reason: string; readonly kind: string} | CborError>,
      titleKey: TranslationKey,
    ) => {
      if (rail === null || groupId === null) return
      // Refused rather than queued: the second transaction is built against a
      // chain state the first one is about to change, so it is a certificate for
      // a decision already taken — and the ledger rejects it once the first lands.
      if (pendingStakeId !== null) {
        showToast({variant: 'error', message: t('cardanoStaking.errors.alreadyPending')})
        return
      }
      setBusy(true)
      try {
        // `runPromiseExit` (not `runPromise().catch`) so the typed StakeBuildError
        // survives — a rejected promise only exposes a FiberFailure wrapper, whose
        // `.kind` is undefined, which silently collapsed every failure (funds
        // included) into the generic "cannot build" toast.
        const exit = await Effect.runPromiseExit(build(rail))
        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
          const buildKind = failure !== undefined && 'kind' in failure ? (failure as {kind: string}).kind : null
          const reason =
            failure !== undefined && 'reason' in failure
              ? String((failure as {reason: unknown}).reason)
              : Cause.pretty(exit.cause)
          // Build failures otherwise vanish behind the toast — log kind + reason
          // so infra errors are distinguishable from funds shortfalls.
          logger.warn('stake tx build failed', {origin: 'StakeScreen', kind: buildKind, reason})
          const key =
            buildKind === 'insufficient-funds' || buildKind === 'empty-wallet'
              ? 'insufficientFunds'
              : buildKind === 'nothing-to-do'
                ? 'nothingToDo'
                : buildKind === 'unsafe-params'
                  ? 'unsafeParams'
                  : 'buildFailed'
          showToast({
            variant: 'error',
            message: t(`cardanoStaking.errors.${key}` as 'cardanoStaking.errors.buildFailed'),
          })
          return
        }
        const review = exit.value

        // The shared hook rather than a local copy, because a script wallet makes
        // the difference load-bearing: a co-signer's request arrives redirected at
        // their *home* group, and the vault must be asked about that group's
        // source. The copy that used to live here answered with the selected
        // wallet's kind for every group — right until a hardware co-signer.
        const signingLayer = await resolveSigningLayer(rail, groupId)
        if (signingLayer === null) {
          showToast({variant: 'error', message: t('cardanoStaking.errors.railUnavailable')})
          return
        }

        // `null` for a key wallet, and `withGather` then returns the ticket by
        // identity — so this is wired in unconditionally and the flow never asks
        // what kind of wallet it is serving.
        const gather = await Effect.runPromise(
          buildGatherContext({
            rail,
            shared,
            bodyHex: review.bodyHex,
            createdAt: new Date().toISOString(),
          }).pipe(
            Effect.provideService(Decode, rail.decode),
            Effect.orElseSucceed(() => null),
          ),
        )

        const ticketId = registerReviewTicket(
          withGather(
            {
              legs: [{reviewed: review.reviewed, request: review.request}],
              groupId,
              audit: {purpose: 'stake', origin: null},
              signingLayer,
              titleKey,
              // Stays put: this screen refreshes its own delegation state below, which is
              // what the user came to see change.
              doneHref: null,
              onSettled: (results) => {
                const result = results[0]
                if (result?._tag === 'TxSubmitted') {
                  void Effect.runPromise(
                    rail.pendingTracker.register(pendingTxFrom(result.txHash, review.tracked, Date.now())),
                  )
                  setPendingPoolId(null)
                  setPendingDrep(null)
                  setStateNonce((n) => n + 1)
                }
              },
              onError: () => {},
              onCancel: () => {},
            },
            gather,
            // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
            (pendingId) => router.push(`/wallet/cosign?pendingId=${pendingId}` as never),
          ),
        )
        // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
        router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
      } finally {
        setBusy(false)
      }
    },
    [rail, groupId, shared, pendingStakeId, resolveSigningLayer, router, showToast, t],
  )

  const onConfirmDelegation = useCallback(() => {
    if (state === null) return
    // `signerKind` decides whether a combined Conway certificate may be used: a device refuses one
    // (CIP-21), and a script wallet's co-signers may be devices too.
    void submit(
      (r) => buildDelegationReview(r, groupId as string, state, selection, signerKind),
      'cardanoStaking.reviewTitle',
    )
  }, [submit, state, groupId, selection, signerKind])

  const onUnstake = useCallback(() => {
    if (state === null) return
    void submit((r) => buildUnstakeReview(r, groupId as string, state), 'cardanoStaking.unstakeTitle')
  }, [submit, state, groupId])

  const onWithdraw = useCallback(() => {
    if (state === null) return
    void submit((r) => buildWithdrawReview(r, groupId as string, state), 'cardanoStaking.withdrawTitle')
  }, [submit, state, groupId])

  // ── unavailable / loading states ──
  if (unavailable) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.stateContent}>
        <EmptyState icon="growthStaking" title={t('cardanoStaking.unavailable')} />
      </SafeAreaViewWrapper>
    )
  }
  if (railLoading || (state === null && !stateFailed)) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      </SafeAreaViewWrapper>
    )
  }
  if (stateFailed || state === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.stateContent}>
        <EmptyState
          icon="growthStaking"
          title={t('cardanoStaking.stateFailed')}
          action={{label: t('common.buttons.tryAgain'), onPress: () => setStateNonce((n) => n + 1)}}
          testID="stake-retry"
        />
      </SafeAreaViewWrapper>
    )
  }

  // The id is the honest fallback when the list does not carry the pool — the same
  // rule `currentPoolLabel` below already applies to the on-chain one.
  const poolTitle = pendingPoolId !== null ? (pendingPoolInfo?.name ?? pendingPoolId) : null
  const currentPoolLabel =
    currentPoolInfo !== null ? (currentPoolInfo.name ?? currentPoolInfo.id) : (state.currentPool ?? null)
  const currentDrepLabel =
    state.currentDrep?.kind === 'abstain'
      ? t('cardanoStaking.abstain')
      : state.currentDrep?.kind === 'no_confidence'
        ? t('cardanoStaking.noConfidence')
        : (currentDrepInfo?.givenName ?? currentDrepId ?? null)

  // Avatars for the selected / current target (cexplorer logo; verified DRep
  // image preferred). Abstain / No confidence have no bech32 → no avatar.
  // Once a pool is pending, its avatar must not fall through to the *current*
  // pool's — that would show the outgoing pool's logo beside the incoming pool's
  // name. `logoUrl` is derived from the id, so an unlisted pool still gets one.
  const poolImageUrl =
    pendingPoolId !== null
      ? (pendingPoolInfo?.logoUrl ?? cexplorerLogoUrl(pendingPoolId))
      : (currentPoolInfo?.logoUrl ?? null)
  const poolAvatarLabel = pendingPoolInfo?.ticker ?? poolTitle ?? currentPoolInfo?.ticker ?? currentPoolLabel ?? 'ADA'
  const drepBech32 = pendingDrep !== null ? drepTargetBech32(pendingDrep.target) : currentDrepId
  const drepImageUrl = currentDrepInfo?.imageUrl ?? (drepBech32 !== null ? cexplorerLogoUrl(drepBech32) : null)
  const drepAvatarLabel = pendingDrep?.label ?? currentDrepInfo?.givenName ?? drepBech32 ?? 'DR'

  const rewardsText = format(state.rewardsAvailable, {
    preset: 'cryptoBalance',
    currency: adaTicker,
    decimals: ADA_DECIMALS,
  })

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={state.registered ? t('cardanoStaking.confirmChanges') : t('cardanoStaking.startStaking')}
            onPress={onConfirmDelegation}
            disabled={!canConfirm}
            loading={busy}
            fullWidth
            testID="stake-confirm"
          />
        </StickyFooter>
      }
    >
      {pendingStakeId !== null && (
        <Card variant="outlined" style={styles.intro} testID="stake-pending-cosign">
          <Typography variant="bodyMd_medium">{t('cardanoStaking.pendingTitle')}</Typography>
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('cardanoStaking.pendingBody')}
          </Typography>
          <Button
            label={t('cardanoStaking.pendingAction')}
            variant="secondary"
            // Route type isn't inferred for the new group yet; narrow cast per CLAUDE.md.
            onPress={() => router.push(`/wallet/cosign?pendingId=${pendingStakeId}` as never)}
            testID="stake-pending-open"
          />
        </Card>
      )}
      {!state.registered && (
        <Card variant="outlined" style={styles.intro}>
          <Typography variant="bodyMd_medium">{t('cardanoStaking.introTitle')}</Typography>
          <View style={styles.stepRow}>
            <Typography variant="bodyMd_medium" style={styles.stepNumber}>
              1
            </Typography>
            <Typography variant="bodySm_regular" style={[styles.muted, styles.stepBody]}>
              {t('cardanoStaking.introStepPool')}
            </Typography>
          </View>
          <View style={styles.stepRow}>
            <Typography variant="bodyMd_medium" style={styles.stepNumber}>
              2
            </Typography>
            <Typography variant="bodySm_regular" style={[styles.muted, styles.stepBody]}>
              {t('cardanoStaking.introStepDrep')}
            </Typography>
          </View>
          <Typography variant="bodySm_regular" style={styles.muted}>
            {t('cardanoStaking.introFootnote')}
          </Typography>
        </Card>
      )}

      {/* Pool target */}
      <Card variant="outlined" style={styles.targetCard} testID="stake-pool-card">
        <SectionHeader
          title={t('cardanoStaking.poolSection')}
          link={{
            label:
              poolTitle !== null || state.currentPool !== null
                ? t('cardanoStaking.change')
                : t('cardanoStaking.choose'),
            onPress: () => setPoolPickerOpen(true),
            testID: 'stake-choose-pool',
          }}
        />
        <View style={styles.targetRow}>
          {poolImageUrl !== null && <PoolDrepAvatar imageUrl={poolImageUrl} label={poolAvatarLabel} size={40} />}
          <View style={styles.targetRowText}>
            <Typography variant="bodyMd_medium" style={styles.targetValue} singleLine>
              {poolTitle ?? currentPoolLabel ?? t('cardanoStaking.notStaked')}
            </Typography>
            {poolTitle === null && currentPoolLabel === null && (
              <Typography variant="bodySm_regular" style={styles.targetSub}>
                {t('cardanoStaking.notStakedHint')}
              </Typography>
            )}
          </View>
        </View>
        {pendingPoolId === null && currentPoolInfo !== null && (
          <View style={styles.targetMetrics}>
            {currentPoolInfo.roa !== undefined && (
              <DataRow
                label={t('cardanoStaking.metrics.roa')}
                value={t('cardanoStaking.roaValue', {roa: currentPoolInfo.roa.toFixed(2)})}
              />
            )}
            {currentPoolInfo.saturation !== undefined && (
              <DataRow
                label={t('cardanoStaking.metrics.saturation')}
                value={`${(currentPoolInfo.saturation * 100).toFixed(0)}%`}
              />
            )}
            {currentPoolInfo.delegators !== undefined && (
              <DataRow label={t('cardanoStaking.metrics.delegators')} value={String(currentPoolInfo.delegators)} />
            )}
          </View>
        )}
      </Card>

      {/* DRep target */}
      <Card variant="outlined" style={styles.targetCard} testID="stake-drep-card">
        <SectionHeader
          title={t('cardanoStaking.drepSection')}
          link={{
            label:
              pendingDrep !== null || state.currentDrep !== null
                ? t('cardanoStaking.change')
                : t('cardanoStaking.choose'),
            onPress: () => setDrepPickerOpen(true),
            testID: 'stake-choose-drep',
          }}
        />
        <View style={styles.targetRow}>
          {drepImageUrl !== null && <PoolDrepAvatar imageUrl={drepImageUrl} label={drepAvatarLabel} size={40} />}
          <View style={styles.targetRowText}>
            <Typography variant="bodyMd_medium" style={styles.targetValue} singleLine>
              {pendingDrep?.label ?? currentDrepLabel ?? t('cardanoStaking.notDelegated')}
            </Typography>
            {pendingDrep === null && currentDrepLabel === null && (
              <Typography variant="bodySm_regular" style={styles.targetSub}>
                {t('cardanoStaking.notDelegatedHint')}
              </Typography>
            )}
          </View>
        </View>
      </Card>

      {/* Rewards (registered accounts) */}
      {state.registered && (
        <Card variant="outlined" style={styles.rewardsCard} testID="stake-rewards-card">
          <View style={styles.rewardsRow}>
            <View>
              <Typography variant="bodySm_medium" style={styles.muted}>
                {t('cardanoStaking.rewardsSection')}
              </Typography>
              <Typography variant="bodyMd_medium">{rewardsText}</Typography>
            </View>
            <Button
              variant="secondary"
              size="sm"
              label={t('cardanoStaking.withdraw')}
              onPress={onWithdraw}
              disabled={busy || state.rewardsAvailable <= 0n}
              testID="stake-withdraw"
            />
          </View>
        </Card>
      )}

      <Typography variant="bodySm_regular" style={styles.timing}>
        {t('cardanoStaking.timingNote')}
      </Typography>

      {state.registered && (
        <Button
          variant="secondary"
          label={t('cardanoStaking.unstake')}
          onPress={onUnstake}
          disabled={busy}
          containerStyles={styles.unstake}
          testID="stake-unstake"
        />
      )}

      <PoolPickerSheet
        visible={poolPickerOpen}
        onClose={() => setPoolPickerOpen(false)}
        currentPoolId={state.currentPool}
        onSelect={(pool) => {
          setPendingPoolId(pool.id)
          setPoolPickerOpen(false)
        }}
      />
      <DrepPickerSheet
        visible={drepPickerOpen}
        onClose={() => setDrepPickerOpen(false)}
        currentTarget={state.currentDrep}
        onSelect={(choice) => {
          setPendingDrep(choice)
          setDrepPickerOpen(false)
        }}
      />
    </SafeAreaViewWrapper>
  )
}
