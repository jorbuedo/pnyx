/**
 * What happens to a scanned CIP-8 message request: decide whether we may answer it, review and
 * sign it, hand the COSE signature back as an animated QR.
 *
 * The transaction sibling is `AirGapRequestScreen`, and the same two rules apply. **There is no
 * camera here** — the app has one scanner, and this screen is what a completed scan becomes. And
 * **signing does not happen here**: the action registers a review ticket and navigates to
 * `TxReviewScreen`, the one place a signature is consented to (Phase 16 item 41), which returns
 * here so the QR belongs to the flow that asked for it.
 *
 * The trust decision is `decideCip8Request`'s and is consumed, never re-derived. In particular the
 * key that signs was resolved from *our* registry, not from the path the request asked for.
 *
 * @module
 */

import {UR_TYPE_SIGN_CIP8_DATA_SIGNATURE} from '@pnyx/ur'
import {Effect} from 'effect'
import {useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {AnimatedQRCode} from '../../../components/AnimatedQRCode'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {decodeSignDataPayload} from '../../../components/DappBrowser/sign-data-decode'
import {EmptyState} from '../../../components/EmptyState'
import {CircleLoader} from '../../../components/Loaders'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {StickyFooter} from '../../../components/StickyFooter'
import {Typography} from '../../../components/Typography'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {useToast} from '../../../hooks/useToast'
import type {TranslationKey} from '../../../i18n/types'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {
  CARDANO_PAYMENT_PATH,
  CARDANO_STAKE_PATH,
  type CredentialStoreDeps,
  cardanoSigningLayer,
  loadCardanoGovKeys,
} from '../../../services/cardano'
import {
  type Cip8Decision,
  type Cip8RefusalReason,
  decideCip8Request,
} from '../../../services/keystone/cip8-request-review'
import {cip8SignatureReply, cip8SigningRequest} from '../../../services/keystone/sign-leg'
import {reasonOfThrown} from '../../../utils/effect-failure'
import {registerReviewTicket} from '../review-handoff'
import {claimScannedUr} from './scanned-request-handoff'

type Phase =
  | {readonly kind: 'deciding'}
  | {readonly kind: 'decided'; readonly decision: Cip8Decision}
  | {readonly kind: 'signature'; readonly payload: Uint8Array}
  /** No scan to act on: a stale link, or the handoff was already claimed. */
  | {readonly kind: 'no-request'}

const REFUSAL_KEY: Record<Cip8RefusalReason, TranslationKey> = {
  'raw-sign-data': 'airGap.refused.rawSignData',
  'unsupported-type': 'airGap.refused.unsupportedType',
  malformed: 'airGap.refused.malformed',
  'not-ours': 'airGap.refused.notOurs',
  'wrong-network': 'airGap.refused.wrongNetwork',
  'unverifiable-key': 'airGap.refused.unverifiableKey',
}

export const AirGapMessageScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {showToast} = useToast()
  const {rail, groupId, unavailable} = useCardanoRail()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const source = selectedWalletGroup?.primaryWallet.source
  const {scan} = useLocalSearchParams<{scan?: string}>()

  const [phase, setPhase] = useState<Phase>({kind: 'deciding'})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (rail === null) return
    const ur = scan === undefined ? undefined : claimScannedUr(scan)
    if (ur === undefined) {
      setPhase((current) => (current.kind === 'deciding' ? {kind: 'no-request'} : current))
      return
    }
    // The account xpub is only needed by KEY_HASH mode, and it is read rather than derived: this
    // screen holds no seed, and a request that cannot be checked against it is refused, not assumed.
    void Effect.runPromise(
      Effect.gen(function* () {
        const gov = groupId === null ? null : yield* loadCardanoGovKeys(groupId).pipe(Effect.orElseSucceed(() => null))
        return yield* decideCip8Request(
          ur,
          {
            paymentKeyHashHex: rail.account.paymentKeyHashHex,
            stakeKeyHashHex: rail.account.stakeKeyHashHex,
            paymentPath: CARDANO_PAYMENT_PATH,
            stakePath: CARDANO_STAKE_PATH,
            accountXpubHex: gov?.accountXpubHex ?? null,
          },
          rail.config.networkId,
        )
      }),
    ).then((decision) => {
      setPhase((current) => (current.kind === 'deciding' ? {kind: 'decided', decision} : current))
    })
  }, [scan, rail, groupId])

  const scanAnother = useCallback(() => router.replace('/scan' as never), [router])

  const reviewAndSign = useCallback(async () => {
    if (phase.kind !== 'decided' || phase.decision.kind !== 'signable') return
    if (rail === null || groupId === null) return
    const {decision} = phase
    setBusy(true)
    const fail = (reason: string) => {
      logger.warn('air-gap: could not prepare the message for review', {origin: 'AirGapMessageScreen', reason})
      showToast({variant: 'error', message: t('airGap.signError')})
    }
    try {
      const signing = cip8SigningRequest(decision, {
        groupId,
        networkId: rail.config.networkId,
        protocolMagic: rail.config.protocolMagic,
        accountIndex: selectedAccountIndex,
      })
      // Dynamic, so the enclave module stays off the path a refused request takes.
      const vaultModule = await import('../../../services/credential-vault').catch((error: unknown) => {
        fail(reasonOfThrown(error))
        return null
      })
      if (vaultModule === null) return
      const vault = vaultModule.createEnclaveMnemonicVault()
      const credentialDeps: CredentialStoreDeps = {
        retrieveMnemonic: (gid) =>
          vault.retrieve(gid, t('common.biometricPrompt')).pipe(Effect.mapError((e) => ({message: e.message}))),
        resolveSource: () => Effect.succeed(source === 'hardware' ? 'hardware' : 'software'),
        resolveHardwareMeta: () => Effect.succeed(null),
      }

      const ticketId = registerReviewTicket({
        legs: [
          {
            kind: 'message',
            // A request from outside the app: a dApp or a scanned payload, whoever it says it is.
            requestedBy: 'external',
            // The decoded form, so the screen renders what the bytes prove rather than a summary
            // the requester wrote.
            message: decodeSignDataPayload(decision.messageHex),
            addressHex: signing.payload.addressHex,
            // The requester's own word for itself — stored verbatim, never resolved.
            origin: decision.unverifiedOrigin ?? null,
            request: signing,
          },
        ],
        groupId,
        audit: {purpose: 'air-gap', origin: decision.unverifiedOrigin ?? null},
        signingLayer: cardanoSigningLayer(rail, credentialDeps),
        titleKey: 'airGap.message.title',
        // Stays put: the signature this produces is shown on THIS screen for the offline device
        // to scan. Leaving for the wallet home would discard the thing the user came for.
        doneHref: null,
        onSettled: (results) => {
          const result = results.length === 1 ? results[0] : undefined
          if (result?._tag !== 'DataSigned') {
            fail(`expected one DataSigned result, got ${results.length} of ${result?._tag ?? 'none'}`)
            return
          }
          setPhase({
            kind: 'signature',
            payload: cip8SignatureReply(result.signature, result.key, decision.requestId),
          })
        },
        onError: (error) => fail(reasonOfThrown(error)),
        onCancel: () => {},
      })
      router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
    } catch (error) {
      fail(reasonOfThrown(error))
    } finally {
      setBusy(false)
    }
  }, [phase, rail, groupId, source, t, showToast, router, selectedAccountIndex])

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
        <Callout variant="info" message={t('airGap.sign.noRequest')} testID="airgap-message-no-request" />
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
              testID="airgap-message-done"
            />
          </StickyFooter>
        }
      >
        <Typography variant="headingSm">{t('airGap.message.signatureTitle')}</Typography>
        <Typography variant="bodyMd_regular" style={styles.muted}>
          {t('airGap.sign.signatureBody')}
        </Typography>
        <AnimatedQRCode
          payload={phase.payload}
          urType={UR_TYPE_SIGN_CIP8_DATA_SIGNATURE}
          caption={t('airGap.message.signatureCaption')}
          testID="airgap-message-signature"
        />
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
        <Callout variant="error" message={t(REFUSAL_KEY[decision.reason])} testID="airgap-message-refused" />
        <Typography variant="bodySm_regular" style={styles.detail} testID="airgap-message-refused-detail">
          {decision.detail}
        </Typography>
        <Button label={t('airGap.sign.scanAnother')} variant="secondary" onPress={scanAnother} fullWidth />
      </SafeAreaViewWrapper>
    )
  }

  const decoded = decodeSignDataPayload(decision.messageHex)
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
            disabled={busy}
            fullWidth
            size="xl"
            testID="airgap-message-review"
          />
        </StickyFooter>
      }
    >
      <Typography variant="headingSm">{t('airGap.message.decidedTitle')}</Typography>
      {decision.unverifiedOrigin === undefined ? null : (
        <Callout variant="info" message={t('airGap.sign.origin', {origin: decision.unverifiedOrigin})} />
      )}
      <Typography variant="bodyMd_regular" style={styles.muted}>
        {decoded.kind === 'hex' ? t('airGap.message.opaquePayload') : decoded.text}
      </Typography>
      <Typography variant="bodySm_regular" style={styles.detail} testID="airgap-message-path">
        {t('airGap.message.signingWith', {path: decision.signingPath})}
      </Typography>
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
    color: theme.colors.textAlternative,
  },
}))
