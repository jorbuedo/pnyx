/**
 * Publish this wallet's Cardano account keys as an animated `crypto-multi-accounts` QR, so a
 * companion wallet can watch them and build transactions for us to sign.
 *
 * **One way in: a scanned `qr-hardware-call`.** The companion names the paths it wants and we
 * answer those, in the order it named them; a path we do not derive is declined *by name* rather
 * than silently dropped.
 *
 * There was a second entry point — a row in Wallet settings that published a guess unprompted —
 * and it was removed 2026-08-07. A companion that assigns keys by position rather than by their
 * `origin` path (Eternl does) makes an unprompted export a coin flip: publishing 1852 first was
 * imported as the multisig chain and vice versa, and no fixed order can be right for two readers
 * with opposite conventions. The call *is* the ordering, so the handshake is the only path that
 * can be correct by construction rather than by luck.
 *
 * Nothing secret leaves: every key is an account-level *public* key and chain code. The enclave
 * ceremony is needed because the master fingerprint derives from the root key — and, since it is
 * open anyway, every account key is derived from that same root rather than mixing a persisted
 * xpub with a freshly derived one. It is also the only way to reach CIP-1854, which nothing
 * persists.
 *
 * No chain access: this is key material, not chain state, so it uses the codec directly rather
 * than a Cardano rail.
 *
 * @module
 */

import {Keys} from '@pnyx/cardano-core'
import {hex} from '@pnyx/crypto'
import {decodeQrHardwareCall, UR_TYPE_MULTI_ACCOUNTS, type Ur} from '@pnyx/ur'
import {Effect, Either} from 'effect'
import {useLocalSearchParams} from 'expo-router'
import {useCallback, useMemo, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AnimatedQRCode} from '../../../components/AnimatedQRCode'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {EmptyState} from '../../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {Typography} from '../../../components/Typography'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {getCardanoRailConfig} from '../../../services/cardano/config'
import {
  type AccountKeySource,
  CARDANO_COIN_TYPE,
  CARDANO_PURPOSE_MULTISIG,
  cardanoMultiAccounts,
  encodeCardanoAccountExport,
  masterFingerprintOf,
  type RequestedAccount,
  requestedAccountsFrom,
} from '../../../services/keystone/account-export'
import {claimScannedUr} from './scanned-request-handoff'

const HARDENED = 0x80000000

/** `m/purpose'/1815'/account'` as the raw indices BIP32-Ed25519 derivation takes. */
const accountPath = (account: RequestedAccount): number[] => [
  (account.purpose | HARDENED) >>> 0,
  (CARDANO_COIN_TYPE | HARDENED) >>> 0,
  (account.accountIndex | HARDENED) >>> 0,
]

export const AirGapExportScreen = () => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {scan} = useLocalSearchParams<{scan?: string}>()
  const {selectedWalletGroup} = useWalletList()

  // The route carries no group: the wallet the user is holding is the one being asked for.
  const groupId = selectedWalletGroup?.groupId

  // Claimed once and held. The handoff is single-consumer, so claiming inside the `useMemo` below
  // would lose the call the moment React re-ran it (a discarded memo cache, a StrictMode double
  // render) and the screen would report an export nobody asked for.
  const scanned = useRef<Ur | null | undefined>(undefined)
  if (scanned.current === undefined) scanned.current = scan === undefined ? null : (claimScannedUr(scan) ?? null)

  const [payload, setPayload] = useState<Uint8Array | null>(null)
  const [declined, setDeclined] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)

  // The export names the network its xpubs are for, so an unconfigured Cardano network is a
  // reason not to export at all rather than to guess one — a companion told the wrong network
  // derives the wrong addresses and watches an account that does not exist.
  const railConfig = getCardanoRailConfig()

  /**
   * What to publish, and in what order — for a reader that ignores `origin`, one question. The
   * call answers both: the paths it named, in the order it named them. Reached without one there
   * is nothing to answer, which the empty list renders as.
   */
  const requested = useMemo<{accounts: readonly RequestedAccount[]; declined: readonly string[]}>(() => {
    const ur = scanned.current
    if (ur === null || ur === undefined) return {accounts: [], declined: []}
    const call = decodeQrHardwareCall(ur.cbor)
    if (!call.ok) return {accounts: [], declined: [call.error]}
    const {accepted, declined: refused} = requestedAccountsFrom(call.value)
    return {accounts: accepted, declined: refused}
  }, [])

  const build = useCallback(async () => {
    if (groupId === undefined || requested.accounts.length === 0 || railConfig === null) return
    setBusy(true)
    try {
      const {createEnclaveMnemonicVault} = await import('../../../services/credential-vault')
      const mnemonic = await Effect.runPromise(
        createEnclaveMnemonicVault().retrieve(groupId, t('common.biometricPrompt')),
      )

      const derived = await Effect.runPromise(
        Effect.gen(function* () {
          const rootXprv = yield* Keys.rootKeyFromMnemonic(mnemonic)
          const rootPublicKeyHex = yield* Keys.publicKey(rootXprv)
          const keys: AccountKeySource[] = []
          for (const account of requested.accounts) {
            const accountXprv = yield* Keys.derivePath(rootXprv, accountPath(account))
            const xpubHex = yield* Keys.accountXpubOf(accountXprv)
            keys.push({
              ...account,
              xpub: Either.getOrThrowWith(hex.decode(xpubHex), () => new Error('air-gap: xpub is not hex')),
            })
          }
          return {
            rootPublicKey: Either.getOrThrowWith(
              hex.decode(rootPublicKeyHex),
              () => new Error('air-gap: the root public key is not hex'),
            ),
            keys,
          }
        }),
      )

      setPayload(
        encodeCardanoAccountExport(
          cardanoMultiAccounts({
            masterFingerprint: masterFingerprintOf(derived.rootPublicKey),
            accounts: derived.keys,
            cardanoNetworkId: railConfig.networkId,
            name: (account) =>
              account.purpose === CARDANO_PURPOSE_MULTISIG
                ? t('airGap.export.multisigAccountName', {index: account.accountIndex})
                : t('airGap.export.accountName', {index: account.accountIndex}),
          }),
        ),
      )
      setDeclined(requested.declined)
    } catch (e: unknown) {
      logger.warn('Air-gap export could not be prepared', {origin: 'AirGapExportScreen', error: String(e)})
      showToast({variant: 'error', message: t('airGap.export.error')})
    } finally {
      setBusy(false)
    }
  }, [groupId, requested, railConfig, t, showToast])

  if (requested.accounts.length === 0 || railConfig === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
        <EmptyState icon="wallet" title={t('airGap.export.unavailable')} />
        {requested.declined.map((reason) => (
          <Typography key={reason} variant="bodySm_regular" style={styles.declined}>
            {reason}
          </Typography>
        ))}
      </SafeAreaViewWrapper>
    )
  }

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Typography variant="bodyMd_regular" style={styles.muted}>
        {t('airGap.export.answeringBody')}
      </Typography>
      {payload === null ? (
        <Button
          label={t('airGap.export.action')}
          onPress={build}
          isLoading={busy}
          fullWidth
          size="xl"
          testID="airgap-export-build"
        />
      ) : (
        <>
          <AnimatedQRCode
            payload={payload}
            urType={UR_TYPE_MULTI_ACCOUNTS}
            caption={t('airGap.export.caption')}
            testID="airgap-export-qr"
          />
          <View style={styles.howTo} testID="airgap-export-how-to">
            <Typography variant="bodyMd_medium">{t('airGap.export.howTo.title')}</Typography>
            {HOW_TO_STEPS.map((step) => (
              <View key={step} style={styles.step}>
                <Typography variant="bodySm_regular" style={styles.bullet}>
                  {'•'}
                </Typography>
                <Typography variant="bodySm_regular" style={styles.stepText}>
                  {t(step)}
                </Typography>
              </View>
            ))}
          </View>
        </>
      )}
      {/* A path we would not answer is stated, not dropped: an incomplete export otherwise shows
          up later as a companion quietly missing an account. */}
      {declined.length === 0 ? null : (
        <Callout variant="warning" message={t('airGap.export.declined', {count: declined.length})} />
      )}
      {declined.map((reason) => (
        <Typography key={reason} variant="bodySm_regular" style={styles.declined}>
          {reason}
        </Typography>
      ))}
    </SafeAreaViewWrapper>
  )
}

const HOW_TO_STEPS = [
  'airGap.export.howTo.pointCamera',
  'airGap.export.howTo.holdStill',
  'airGap.export.howTo.brightness',
] as const

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing16,
  },
  muted: {
    color: theme.colors.textAlternative,
  },
  declined: {
    color: theme.colors.textMuted,
  },
  howTo: {
    gap: theme.spacing.spacing8,
  },
  step: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
  },
  bullet: {
    color: theme.colors.textMuted,
  },
  stepText: {
    flex: 1,
    color: theme.colors.textAlternative,
  },
}))
