/**
 * What happens to a `cardano-sign-request` the QR scanner reassembled: decide whether it may be
 * reviewed, review and sign it, hand the signature back as an animated QR.
 *
 * **There is no camera here.** The app has one scanner (`app/scan.tsx`); it recognises a UR
 * sequence, accumulates it, and hands the finished message over. This screen is what a scanned
 * request *becomes*.
 *
 * **Signing does not happen here either.** As with co-sign, the action registers a review ticket
 * and navigates to `TxReviewScreen`, the one place a signature is consented to (Phase 16 item
 * 41). That screen returns here, which is why the signature QR appears here: it belongs to the
 * flow that asked for it.
 *
 * The trust decision is `decideSignRequest`'s, not this screen's — consumed, never re-derived.
 * See `services/keystone/sign-request-review.ts` for why that matters.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {resolveCardanoSigningPaths, reviewCardanoTx} from '@pnyx/tx-review'
import {UR_TYPE_SIGNATURE, type Ur} from '@pnyx/ur'
import {Effect, Exit} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AnimatedQRCode} from '../../../components/AnimatedQRCode'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {Checkbox} from '../../../components/Checkbox'
import {EmptyState} from '../../../components/EmptyState'
import {CircleLoader} from '../../../components/Loaders'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {Typography} from '../../../components/Typography'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useToast} from '../../../hooks/useToast'
import type {TranslationKey} from '../../../i18n/types'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {type CredentialStoreDeps, cardanoSigningLayer, createCardanoTxContext} from '../../../services/cardano'
import {accountScriptContext} from '../../../services/cardano/account'
import {
  confirmGate,
  describeWitnessOutcome,
  keystoneSigningRequest,
  signatureReply,
  type WitnessCoverage,
  witnessCoverage,
} from '../../../services/keystone/sign-leg'
import {
  decideSignRequest,
  networkMismatch,
  type RefusalReason,
  type SignRequestDecision,
} from '../../../services/keystone/sign-request-review'
import {resolveInputAddresses} from '../../../services/keystone/verify-request-utxos'
import {failureOf, reasonOfThrown} from '../../../utils/effect-failure'
import {registerReviewTicket} from '../review-handoff'
import {RequestInputs} from './RequestInputs'
import {claimScannedUr} from './scanned-request-handoff'

type Phase =
  /** Holding a scanned request, waiting for the synced UTxOs the decision needs. */
  | {readonly kind: 'deciding'}
  | {readonly kind: 'decided'; readonly decision: SignRequestDecision}
  /**
   * `coverage` travels with the payload so the QR can say whether it is the whole answer. A reply
   * short of a witness is still worth handing over — the coordinator collects the rest elsewhere —
   * but presenting it silently is what leaves someone waiting on a signature that is never coming.
   */
  | {readonly kind: 'signature'; readonly payload: Uint8Array; readonly coverage: WitnessCoverage}
  /** Signed, but none of the transaction's required keys were ours — nothing to hand back. */
  | {readonly kind: 'nothing-to-sign'}
  /** No scan to act on: a stale link, or the handoff was already claimed. */
  | {readonly kind: 'no-request'}

/**
 * A failure between "Review & sign" and the review screen, kept on screen rather than only in a
 * toast — a toast is gone before anyone can copy it, and this is the surface with no counterparty
 * to ask. `step` is what makes it actionable: these fail for unrelated reasons.
 */
type PrepareFailure = {
  readonly step:
    | 'protocol-params'
    | 'input-address'
    | 'review'
    | 'witness-coverage'
    | 'credential-vault'
    | 'signing'
    | 'unexpected'
  readonly reason: string
}

const REFUSAL_KEY: Record<RefusalReason, TranslationKey> = {
  'tx-hash-only': 'airGap.refused.txHashOnly',
  'wrong-network': 'airGap.refused.wrongNetwork',
  'unsupported-type': 'airGap.refused.unsupportedType',
  malformed: 'airGap.refused.malformed',
  'contradicts-our-state': 'airGap.refused.contradictsOurState',
}

export const AirGapRequestScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {showToast} = useToast()
  const {adaTicker} = useNetworkCapabilities()
  const {rail, groupId, unavailable} = useCardanoRail()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const source = selectedWalletGroup?.primaryWallet.source
  const {scan} = useLocalSearchParams<{scan?: string}>()

  const [phase, setPhase] = useState<Phase>({kind: 'deciding'})
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<PrepareFailure | null>(null)
  const [utxos, setUtxos] = useState<readonly UTxO.UTxO[] | null>(null)

  // Claimed once and held: the handoff is single-consumer, so a re-render must not re-claim (and
  // find nothing) or the request would vanish under the user.
  const scanned = useRef<Ur | null | undefined>(undefined)
  if (scanned.current === undefined) scanned.current = scan === undefined ? null : (claimScannedUr(scan) ?? null)

  useEffect(() => {
    if (rail === null) return
    let active = true
    void Effect.runPromise(rail.confirmedUtxos)
      .then((u) => {
        if (active) setUtxos(u)
      })
      .catch((e) => {
        logger.warn('Confirmed UTxO read failed; the request has no inputs to offer', {
          origin: 'AirGapRequestScreen',
          error: String(e),
        })
      })
    return () => {
      active = false
    }
  }, [rail])

  // Deciding without our own UTxO set would degrade every input to `unknown` and turn the
  // cross-check into a formality, so the screen waits rather than answering with less.
  useEffect(() => {
    const ur = scanned.current
    if (ur === null || ur === undefined) {
      setPhase({kind: 'no-request'})
      return
    }
    if (utxos === null || rail === null) return
    const decision = decideSignRequest(ur, utxos, rail.config.networkId)
    setPhase((current) => (current.kind === 'deciding' ? {kind: 'decided', decision} : current))
  }, [utxos, rail])

  const scanAnother = useCallback(() => router.replace('/scan' as never), [router])

  const afterSigned = useCallback(
    async (witnessSetHex: string, requestId: Uint8Array | undefined, coverage: WitnessCoverage) => {
      try {
        const vkeys = await Effect.runPromise(Inspect.witnessSetVkeys(witnessSetHex))
        if (describeWitnessOutcome(vkeys.length).kind === 'nothing-to-sign') {
          setPhase({kind: 'nothing-to-sign'})
          return
        }
        setPhase({kind: 'signature', payload: signatureReply(witnessSetHex, requestId), coverage})
      } catch (e: unknown) {
        // One message for a request we could not read, a wallet that cannot cover it, and a
        // ceremony that failed — on the air-gap signing path.
        logger.warn('Air-gap signing request could not be answered', {
          origin: 'AirGapRequestScreen',
          error: String(e),
        })
        showToast({variant: 'error', message: t('airGap.signError')})
      }
    },
    [showToast, t],
  )

  const reviewAndSign = useCallback(async () => {
    if (phase.kind !== 'decided' || phase.decision.kind !== 'reviewable') return
    if (rail === null || groupId === null) return
    const {decision} = phase
    setBusy(true)
    setFailure(null)
    // Which step failed is the whole diagnosis: this path can die at the provider, at the decode,
    // in the vault or in the handoff, and they need different fixes. A single toast said only that
    // one of them had.
    const fail = (step: PrepareFailure['step'], reason: string) => {
      logger.warn('air-gap: could not prepare the request for review', {
        origin: 'AirGapRequestScreen',
        step,
        reason,
      })
      setFailure({step, reason})
      showToast({variant: 'error', message: t('airGap.signError')})
    }
    try {
      const signing = keystoneSigningRequest(decision.bodyHex, {
        groupId,
        networkId: rail.config.networkId,
        protocolMagic: rail.config.protocolMagic,
        accountIndex: selectedAccountIndex,
      })
      const paramsExit = await Effect.runPromiseExit(rail.protocolParams)
      if (Exit.isFailure(paramsExit)) return fail('protocol-params', failureOf(paramsExit.cause).reason)
      const params = paramsExit.value

      // The decision cannot produce `addressHex` — decoding bech32 needs the codec and that module
      // is synchronous — so the inputs are completed here, where the codec exists.
      const resolvedExit = await Effect.runPromiseExit(resolveInputAddresses(decision.inputs))
      if (Exit.isFailure(resolvedExit)) return fail('input-address', failureOf(resolvedExit.cause).reason)

      // Reviewed from the signing request's own bodyHex, so the bytes rendered and the bytes
      // signed are the same value and not two conversions that could drift.
      const reviewedExit = await Effect.runPromiseExit(
        reviewCardanoTx(signing.payload.bodyHex, rail.account.walletContext, resolvedExit.value, params).pipe(
          Effect.provideService(Decode, rail.decode),
        ),
      )
      if (Exit.isFailure(reviewedExit)) return fail('review', failureOf(reviewedExit.cause).reason)
      const reviewed = reviewedExit.value

      // Two resolutions, deliberately. The first says what the body *requires*, using the input
      // addresses the request supplied. The second is the signing service's own — it resolves
      // inputs against the wallet's synced UTxOs, so an input at an address we do not sync is not
      // required by it at all and its witness is quietly never produced. The difference between
      // them is the shortfall, and asking the registry instead would report full coverage.
      const requiredExit = await Effect.runPromiseExit(
        resolveCardanoSigningPaths(
          signing.payload.bodyHex,
          rail.account.keyRegistry,
          resolvedExit.value,
          accountScriptContext(rail.account),
        ).pipe(Effect.provideService(Decode, rail.decode)),
      )
      if (Exit.isFailure(requiredExit)) return fail('witness-coverage', failureOf(requiredExit.cause).reason)
      const signerExit = await Effect.runPromiseExit(
        createCardanoTxContext(rail).resolveSigningPaths(signing.payload.bodyHex, groupId, signing.accountIndex),
      )
      if (Exit.isFailure(signerExit)) return fail('witness-coverage', failureOf(signerExit.cause).reason)
      const willSign = new Set(signerExit.value.signingPaths)
      const coverage = witnessCoverage(
        requiredExit.value.requiredKeyHashes,
        rail.account.keyRegistry.filter((k) => willSign.has(k.path)).map((k) => k.keyHashHex),
      )

      // The backstop to the address check the decision already ran: `network_id` is an optional
      // body field, so this catches only the requests that bother to declare one — but a body
      // that declares the wrong network is unambiguous, and the review must not be shown.
      if (networkMismatch(reviewed.networkId, rail.config.networkId)) {
        setPhase({
          kind: 'decided',
          decision: {
            kind: 'refused',
            reason: 'wrong-network',
            detail: `the transaction declares network ${reviewed.networkId}, this wallet is on ${rail.config.networkId}`,
          },
        })
        return
      }

      // Dynamic, so the enclave module stays off the path a refused request takes. A bundling or
      // native-module failure surfaces here and nowhere else, which is why it gets its own step.
      const vaultModule = await import('../../../services/credential-vault').catch((error: unknown) => {
        fail('credential-vault', reasonOfThrown(error))
        return null
      })
      if (vaultModule === null) return
      const {createEnclaveMnemonicVault} = vaultModule
      const vault = createEnclaveMnemonicVault()
      const credentialDeps: CredentialStoreDeps = {
        retrieveMnemonic: (gid) =>
          vault.retrieve(gid, t('common.biometricPrompt')).pipe(Effect.mapError((e) => ({message: e.message}))),
        resolveSource: () => Effect.succeed(source === 'hardware' ? 'hardware' : 'software'),
        resolveHardwareMeta: () => Effect.succeed(null),
      }

      const ticketId = registerReviewTicket({
        legs: [{reviewed, request: signing}],
        groupId,
        // `origin` is the requester's own word for itself — stored verbatim, never resolved.
        audit: {purpose: 'air-gap', origin: decision.unverifiedOrigin ?? null},
        signingLayer: cardanoSigningLayer(rail, credentialDeps),
        titleKey: 'airGap.sign.title',
        // Said before the signature exists, not after: once the QR is up the user has already
        // told the coordinator this was answered.
        ...(coverage.missing.length === 0 ? {} : {noticeKey: 'airGap.sign.incompleteNotice'}),
        // Stays put: `afterSigned` hands the witness set back to this screen for the offline
        // device to scan. Navigating away would strand it.
        doneHref: null,
        onSettled: (results) => {
          const result = results.length === 1 ? results[0] : undefined
          if (result?._tag !== 'TxSignedOnly') {
            fail('signing', `expected one TxSignedOnly result, got ${results.length} of ${result?._tag ?? 'none'}`)
            return
          }
          void afterSigned(result.witnessSetHex, decision.request.requestId, coverage)
        },
        onError: (error) => fail('signing', reasonOfThrown(error)),
        onCancel: () => {},
      })
      router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
    } catch (error) {
      fail('unexpected', reasonOfThrown(error))
    } finally {
      setBusy(false)
    }
  }, [phase, rail, groupId, source, t, showToast, afterSigned, router, selectedAccountIndex])

  const gate = useMemo(
    () => (phase.kind === 'decided' ? confirmGate(phase.decision, acknowledged) : null),
    [phase, acknowledged],
  )

  if (unavailable) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <EmptyState icon="wallet" title={t('airGap.walletUnavailable')} />
      </SafeAreaViewWrapper>
    )
  }

  if (phase.kind === 'no-request') {
    return (
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
        <Callout variant="info" message={t('airGap.sign.noRequest')} testID="airgap-no-request" />
        <Button label={t('airGap.sign.scanAnother')} onPress={scanAnother} fullWidth />
      </SafeAreaViewWrapper>
    )
  }

  if (phase.kind === 'signature') {
    return (
      <SafeAreaViewWrapper
        edges={['bottom']}
        scrollable
        contentContainerStyle={styles.content}
        stickyFooter={
          <StickyFooter>
            <Button
              label={t('airGap.sign.done')}
              onPress={() => router.back()}
              fullWidth
              size="xl"
              testID="airgap-done"
            />
          </StickyFooter>
        }
      >
        <Typography variant="headingSm">{t('airGap.sign.signatureTitle')}</Typography>
        <Typography variant="bodyMd_regular" style={styles.muted}>
          {t('airGap.sign.signatureBody')}
        </Typography>
        {phase.coverage.missing.length === 0 ? null : (
          <Callout
            variant="warning"
            message={t('airGap.sign.partialSignature', {
              ours: phase.coverage.ours,
              required: phase.coverage.required,
            })}
          />
        )}
        <AnimatedQRCode
          payload={phase.payload}
          urType={UR_TYPE_SIGNATURE}
          caption={t('airGap.sign.signatureCaption')}
          testID="airgap-signature"
        />
      </SafeAreaViewWrapper>
    )
  }

  if (phase.kind === 'nothing-to-sign') {
    return (
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
        <Callout variant="warning" message={t('airGap.sign.nothingToSign')} testID="airgap-nothing-to-sign" />
        <Button label={t('airGap.sign.scanAnother')} variant="secondary" onPress={scanAnother} fullWidth />
      </SafeAreaViewWrapper>
    )
  }

  if (phase.kind === 'deciding') {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <CircleLoader />
      </SafeAreaViewWrapper>
    )
  }

  const {decision} = phase
  if (decision.kind === 'refused') {
    return (
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
        <Callout variant="error" message={t(REFUSAL_KEY[decision.reason])} testID="airgap-refused" />
        <Typography variant="bodySm_regular" style={styles.detail} testID="airgap-refused-detail">
          {decision.detail}
        </Typography>
        <Button label={t('airGap.sign.scanAnother')} variant="secondary" onPress={scanAnother} fullWidth />
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('airGap.sign.reviewAndSign')}
            onPress={reviewAndSign}
            fullWidth
            size="xl"
            isLoading={busy}
            isDisabled={!(gate?.canConfirm ?? false)}
            testID="airgap-review-and-sign"
          />
        </StickyFooter>
      }
    >
      <Typography variant="headingSm">{t('airGap.sign.decidedTitle')}</Typography>
      {decision.unverifiedOrigin === undefined ? null : (
        <Typography variant="bodySm_regular" style={styles.muted} testID="airgap-origin">
          {t('airGap.sign.origin', {origin: decision.unverifiedOrigin})}
        </Typography>
      )}
      <RequestInputs inputs={decision.inputs} adaTicker={adaTicker} />
      {failure === null ? null : (
        <>
          <Callout variant="error" message={t('airGap.sign.prepareFailed')} testID="airgap-prepare-failed" />
          <Typography variant="bodySm_regular" style={styles.detail} testID="airgap-prepare-failed-detail">
            {`${failure.step}: ${failure.reason}`}
          </Typography>
        </>
      )}
      {gate?.needsAcknowledgement === true ? (
        <View style={styles.acknowledgement}>
          <Checkbox checked={acknowledged} onPress={() => setAcknowledged((v) => !v)} testID="airgap-acknowledge" />
          <Typography variant="bodySm_regular" style={styles.acknowledgementText}>
            {t('airGap.sign.acknowledge', {count: gate.unverifiedCount})}
          </Typography>
        </View>
      ) : null}
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  muted: {
    color: theme.colors.textAlternative,
  },
  detail: {
    color: theme.colors.textMuted,
  },
  acknowledgement: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.spacing12,
  },
  acknowledgementText: {
    flex: 1,
    color: theme.colors.textDefault,
  },
}))
