/**
 * Publish this wallet's CIP-1854 co-signer key so someone can add it to a shared
 * wallet: a QR to scan in person, and a link to send.
 *
 * Nothing shown here is secret — an account xpub is public the moment the wallet
 * transacts.
 *
 * **The key travels alone.** It used to carry a name this screen asked for, and
 * the account index it was taken at. Neither is the sender's to assert: whoever
 * assembles the roster types the names in it, having decided whose key each one
 * is, and every address derives from the xpub rather than from an index beside
 * it. So there is nothing to fill in — reveal the key and send it.
 *
 * @module
 */

import {Either} from 'effect'
import {useFocusEffect, useLocalSearchParams, useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {Share, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {Callout} from '../../../components/Callout'
import {Card} from '../../../components/Card'
import {Copiable} from '../../../components/Copiable'
import {QRCard} from '../../../components/QRCard'
import {SafeAreaViewWrapper} from '../../../components/SafeAreaViewWrapper'
import {SettingsRow} from '../../../components/SettingsRow'
import {Typography} from '../../../components/Typography'
import {useCoSignerKeyAccess} from '../../../hooks/useCoSignerKeyAccess'
import {useToast} from '../../../hooks/useToast'
import {logger} from '../../../logger'
import {useI18n, useWalletList} from '../../../providers'
import {buildCoSignerLink, coSignerFailureKey, encodeAccountXvk, reasonKeyOf} from '../../../services/cardano/multisig'
import {buildCoSignerKeyMessage} from '../../../services/cardano/multisig/dm-message'
import {registerComposerDraft} from '../../../services/composer-draft'
import {resolveGroupCoSignerXpub} from '../../../services/group-seed'
import {OwnWalletPickerModal} from './OwnWalletPickerModal'

const styles = StyleSheet.create(({spacing}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing16},
  card: {padding: spacing.spacing16, gap: spacing.spacing8},
  actions: {gap: spacing.spacing8},
}))

const ACCOUNT_INDEX = 0

export const ShareCoSignerKeyScreen = () => {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {groupId: requestedGroupId} = useLocalSearchParams<{groupId?: string}>()
  const {walletGroups, selectedWalletGroup} = useWalletList()

  /**
   * Whether the caller named the wallet. Wallet Management does — it is a per-group screen, and the
   * group it manages is not necessarily the active one, so reading the selection there would show a
   * different wallet's key under the nameplate of the one you opened. Shared Wallets does NOT: it
   * hangs off the Menu, which is shared across wallets, so arriving from there has to offer a choice
   * rather than silently answer for whichever wallet happens to be active.
   */
  const pinned = requestedGroupId !== undefined
  const [pickedGroupId, setPickedGroupId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const group = useMemo(() => {
    const wanted = pickedGroupId ?? requestedGroupId
    if (wanted === undefined || wanted === null) return selectedWalletGroup ?? null
    const found = walletGroups.find((g) => g.groupId === wanted) ?? null
    // Only once the list has actually loaded. The first renders see an empty `walletGroups`, and
    // warning there reports "no such wallet" for a wallet that is simply not read yet.
    if (found === null && walletGroups.length > 0) {
      logger.warn('co-signer key: no wallet group for the requested id', {wanted})
    }
    return found
  }, [pickedGroupId, requestedGroupId, walletGroups, selectedWalletGroup])

  const groupId = group?.groupId ?? null
  const source = group?.primaryWallet.source ?? null

  const router = useRouter()
  const {access, refresh} = useCoSignerKeyAccess(groupId, source, ACCOUNT_INDEX)
  // The pair flow writes the key and returns here; nothing else would remount.
  useFocusEffect(refresh)

  const [xpub, setXpub] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (source === null) {
      setBlocked(t('multisig.share.errorNoWallet'))
      return
    }
    // The reason this wallet cannot publish a key, not a blanket "watch-only" —
    // which is what this said for a shared wallet and for a device import alike.
    if (access === null) return
    if (access.kind === 'unavailable') {
      setBlocked(t(reasonKeyOf(access.reason)))
      return
    }
    if (access.kind === 'device') {
      setBlocked(t('multisig.create.deviceKeyMissing'))
      return
    }
    setBlocked(null)
  }, [source, access, t])

  const reveal = useCallback(async () => {
    if (groupId === null || source === null) return
    setBusy(true)
    try {
      const result = await resolveGroupCoSignerXpub(groupId, source, t('common.biometricPrompt'), ACCOUNT_INDEX)
      if (Either.isLeft(result)) {
        showToast({variant: 'error', message: t(coSignerFailureKey(result.left))})
        return
      }
      setXpub(result.right)
    } finally {
      setBusy(false)
    }
  }, [groupId, source, t, showToast])

  const link = xpub === null ? null : Either.getOrNull(buildCoSignerLink(xpub))
  const bech32 = xpub === null ? null : Either.getOrNull(encodeAccountXvk(xpub))

  const shareLink = useCallback(async () => {
    if (link === null) return
    await Share.share({message: link})
  }, [link])

  /**
   * Hand the key to the DM composer rather than posting it. Same rule the browser share sheet and
   * the invite flow follow: the inbox picks the conversation, the thread opens with the link in the
   * box, and the user presses send. The thread classifies the `pnyx://` link and draws it as the
   * co-signer card that already exists for it.
   */
  const sendInMessage = useCallback(() => {
    if (xpub === null) return
    const message = buildCoSignerKeyMessage(xpub)
    if (Either.isLeft(message)) {
      logger.warn('co-signer key: could not compose the DM body', {reason: message.left})
      showToast({variant: 'error', message: t('multisig.share.errorDerive')})
      return
    }
    router.push(`/community?draft=${registerComposerDraft(message.right)}` as never)
  }, [xpub, router, showToast, t])

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Typography variant="bodyMd_regular">{t('multisig.share.explainer')}</Typography>

      {/* Reachable from Wallet Management, which carries no multisig context at all — so say where a
          co-signer key is actually used rather than assuming the reader arrived from there. */}
      <Button
        label={t('multisig.share.sharedWalletsLink')}
        variant="nakedDefault"
        onPress={() => router.push('/wallet/shared-wallets' as never)}
        testID="cosigner-shared-wallets"
      />

      {blocked !== null ? (
        <Callout
          variant="warning"
          message={blocked}
          {...(access?.kind === 'device' && groupId !== null
            ? {
                actionLabel: t('multisig.create.deviceKeyAction'),
                onAction: () => router.push(`/wallet/pair-device?groupId=${groupId}&mode=shared-key` as never),
                actionTestID: 'share-connect-device',
              }
            : {})}
        />
      ) : null}

      {/* Only when the caller did not name a wallet. Pinned, the wallet is the screen's subject and
          swapping it under a per-wallet entry point would answer a question nobody asked. */}
      {pinned ? null : (
        <SettingsRow
          label={t('multisig.share.walletRowLabel')}
          description={group?.name ?? t('multisig.share.errorNoWallet')}
          leftIcon="wallet"
          iconColor="textMuted"
          onPress={() => setPickerOpen(true)}
          testID="cosigner-wallet-picker"
          size="lg"
        />
      )}

      {xpub === null ? (
        <Button
          label={t('multisig.share.reveal')}
          onPress={reveal}
          fullWidth
          size="xl"
          isLoading={busy}
          isDisabled={busy || blocked !== null}
          testID="cosigner-reveal"
        />
      ) : (
        <>
          {link !== null ? <QRCard value={link} fill testID="cosigner-qr" /> : null}
          <Card variant="outlined" style={styles.card}>
            <Typography variant="bodyMd_medium">{t('multisig.share.keyLabel')}</Typography>
            {bech32 !== null ? (
              <Copiable text={bech32} feedback={t('multisig.share.keyLabel')}>
                <Typography variant="bodySm_regular">{bech32}</Typography>
              </Copiable>
            ) : null}
          </Card>
          <View style={styles.actions}>
            <Button
              label={t('multisig.share.sendInMessage')}
              onPress={sendInMessage}
              fullWidth
              isDisabled={link === null}
              testID="cosigner-send-dm"
            />
            <Button
              label={t('multisig.share.shareLink')}
              onPress={shareLink}
              variant="secondary"
              fullWidth
              isDisabled={link === null}
              testID="cosigner-share"
            />
          </View>
        </>
      )}
      <OwnWalletPickerModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        // The picker derives the key as part of choosing, so a pick IS the reveal — asking for the
        // biometric a second time on "Show my key" would be the same prompt for the same bytes.
        onPicked={(picked) => {
          setPickedGroupId(picked.groupId)
          setXpub(picked.accountXpubHex)
        }}
        takenXpubs={[]}
      />
    </SafeAreaViewWrapper>
  )
}
