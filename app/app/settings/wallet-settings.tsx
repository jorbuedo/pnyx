import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {type TextInput as RNTextInput, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {Modal} from '../../src/components/Modal'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsRow} from '../../src/components/SettingsRow'
import {TextInputBase} from '../../src/components/TextInputBase'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {WalletGroupCard} from '../../src/components/WalletGroupCard'
import {useMnemonicBackupStatus} from '../../src/hooks/useMnemonicBackupStatus'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {useDismissNoticesOnFocusAt} from '../../src/notices'
import {unsubscribeUserTopicForGroup} from '../../src/platform/notification-tools'
import {useI18n, useWalletList} from '../../src/providers'
import {loadCardanoGovKeys} from '../../src/services/cardano'
import {getActiveCardanoNetwork} from '../../src/services/cardano/config'
import {canCoSign, spendingAuthorityOf} from '../../src/services/cardano/multisig/eligibility'
import {strandedByRemoving} from '../../src/services/cardano/multisig/local-cosigners'
import {platformSharedWalletRegistry} from '../../src/services/cardano/multisig/storage'
import {MAX_WALLET_NAME_LENGTH} from '../../src/utils/auto-wallet-name'

type SheetState = 'rename' | 'remove' | 'recovery-blocked' | null

export default function WalletSettingsScreen() {
  const {groupId} = useLocalSearchParams<{groupId: string}>()
  const {t} = useI18n()
  const {theme} = useUnistyles()
  const {walletGroups, deleteWallet, renameWallet} = useWalletList()
  const {showToast} = useToast()

  const group = useMemo(
    () => (groupId ? (walletGroups.find((g) => g.groupId === groupId) ?? null) : null),
    [walletGroups, groupId],
  )

  const primaryWallet = group?.primaryWallet
  const hasMnemonic = primaryWallet?.source === 'mnemonic'
  // Manage accounts is available for seed wallets AND hardware wallets (which
  // add accounts by re-deriving on the device); read-only has no accounts.
  const canManageAccounts = hasMnemonic || primaryWallet?.isHardware === true
  const canShareCoSignerKey = primaryWallet !== undefined && canCoSign(primaryWallet.source)
  // A composition belongs to a wallet spent by a script. Not the same question as
  // "cannot co-sign": a watch-only wallet cannot co-sign either, and has no roster.
  const isSharedWallet = primaryWallet !== undefined && spendingAuthorityOf(primaryWallet.source) === 'script'
  const {isPending: backupPending} = useMnemonicBackupStatus(group?.groupId)

  // Visiting Wallet Management acknowledges the multichain-activation nudge for
  // the active group (dismissable). Backup, anchored at the same route, is not
  // dismissable, so it survives the visit.
  useDismissNoticesOnFocusAt('/settings/wallet-settings')

  const existingNames = useMemo(
    () => walletGroups.filter((g) => g.groupId !== group?.groupId).map((g) => g.name),
    [walletGroups, group?.groupId],
  )

  // ---------------------------------------------------------------------------
  // Backup
  // ---------------------------------------------------------------------------

  const handleBackup = useCallback(() => {
    const params = group?.groupId ? {groupId: group.groupId} : {}
    if (backupPending === true) {
      router.navigate({pathname: '/settings/recovery-phrase-warn', params})
    } else {
      router.navigate({pathname: '/settings/recovery-phrase-warn', params: {...params, showOnly: 'true'}})
    }
  }, [backupPending, group?.groupId])

  // ---------------------------------------------------------------------------
  // Rename sheet
  // ---------------------------------------------------------------------------

  const [sheetState, setSheetState] = useState<SheetState>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
  const renameInputRef = useRef<RNTextInput>(null)

  const openRename = useCallback(() => {
    if (!group) return
    setRenameValue(group.name)
    setSheetState('rename')
  }, [group])

  const closeRename = useCallback(() => {
    if (isSavingRename) return
    setSheetState(null)
  }, [isSavingRename])

  useEffect(() => {
    if (sheetState !== 'rename') return
    const timer = setTimeout(() => renameInputRef.current?.focus(), 350)
    return () => clearTimeout(timer)
  }, [sheetState])

  const trimmedRename = renameValue.trim()
  const isRenameDuplicate = existingNames.includes(trimmedRename)
  const isRenameEmpty = trimmedRename.length === 0
  const isRenameTooLong = renameValue.length > MAX_WALLET_NAME_LENGTH
  const isRenameUnchanged = trimmedRename === group?.name
  const isRenameValid = !isRenameEmpty && !isRenameTooLong && !isRenameDuplicate && !isRenameUnchanged

  const handleSaveRename = useCallback(async () => {
    if (!group || !isRenameValid) return
    setIsSavingRename(true)
    try {
      await renameWallet(group.groupId, trimmedRename)
      setSheetState(null)
      showToast({variant: 'success', message: t('walletDetail.toast.renamed', {name: trimmedRename})})
    } catch (e) {
      logger.error('Failed to rename wallet', {origin: 'WalletSettingsScreen', error: String(e)})
    } finally {
      setIsSavingRename(false)
    }
  }, [group, isRenameValid, renameWallet, trimmedRename, showToast, t])

  // ---------------------------------------------------------------------------
  // Remove sheet
  // ---------------------------------------------------------------------------

  // Shared wallets this removal would leave with no key on this device. Read
  // when the sheet opens rather than on every render: it reads storage, and the
  // answer cannot change while the sheet is up.
  const [stranded, setStranded] = useState<readonly {readonly id: string; readonly name: string}[]>([])

  const openRemove = useCallback(() => {
    setSheetState('remove')
    if (group === null || group === undefined) return
    void (async () => {
      const locals = await Promise.all(
        walletGroups.map(async (g) => ({
          groupId: g.groupId,
          name: g.name,
          source: g.primaryWallet?.source,
          govKeys: await Effect.runPromise(loadCardanoGovKeys(g.groupId).pipe(Effect.orElseSucceed(() => null))),
        })),
      )
      const shared = await Effect.runPromise(
        platformSharedWalletRegistry()
          .list(getActiveCardanoNetwork() === 'mainnet' ? Address.Network.Mainnet : Address.Network.Testnet)
          .pipe(Effect.orElseSucceed(() => [])),
      )
      setStranded(strandedByRemoving(group.groupId, shared, locals))
    })()
  }, [group, walletGroups])
  const closeRemove = useCallback(() => setSheetState(null), [])

  const handleConfirmRemove = useCallback(async () => {
    if (!group) return
    try {
      const name = group.name
      // Delete FIRST, unsubscribe AFTER. If deleteWallet throws, push must
      // stay intact for the wallet that's still around — running the
      // unsubscribe first would tear down FCM and storage for an account the
      // user keeps. The helper itself is race-safe (resolves the userId per-
      // group; only drops the FCM topic when no OTHER group still shares it;
      // only clears `notificationPrefs.userId` when it matches the deleted
      // user), so the post-delete re-subscribe in useInitPushNotifications
      // can't be clobbered.
      // Together, and in this order: a shared wallet outliving its last key is
      // the state this whole guard exists to prevent, so it must not survive a
      // failure part-way through.
      for (const w of stranded) {
        await Effect.runPromise(
          platformSharedWalletRegistry()
            .remove(getActiveCardanoNetwork() === 'mainnet' ? Address.Network.Mainnet : Address.Network.Testnet, w.id)
            .pipe(Effect.orElseSucceed(() => undefined)),
        )
      }
      await deleteWallet(group.groupId)
      await unsubscribeUserTopicForGroup(group.groupId)
      router.back()
      showToast({variant: 'success', message: t('walletDetail.toast.removed', {name})})
    } catch (err) {
      logger.error('Failed to delete wallet group', {origin: 'WalletSettingsScreen', groupId: group.groupId, err})
      setSheetState(null)
    }
  }, [group, stranded, deleteWallet, showToast, t])

  // ---------------------------------------------------------------------------
  // Derived UI
  // ---------------------------------------------------------------------------

  const recoveryLabel =
    backupPending === true ? t('walletDetail.backUpRecoveryPhrase') : t('walletDetail.recoveryPhrase')

  const removeMessageKey =
    primaryWallet?.source === 'hardware'
      ? 'walletDetail.deleteWalletMessageHardware'
      : 'walletDetail.deleteWalletMessage'

  const chevron = (
    <UniIcon name="rightThin" width={12} height={12} uniProps={(theme) => ({color: theme.colors.textMuted})} />
  )

  if (!group) return null

  return (
    <View style={styles.root}>
      <Stack.Screen options={{title: t('walletDetail.screenTitle')}} />
      <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.scrollContent}>
        {/* Name plate for the wallet being managed — the header now shows the
            screen title, so surface which wallet this is here. Display only. */}
        <WalletGroupCard group={group} isActive={false} testID="wallet-settings-nameplate" />

        <SettingsGroup label={t('walletDetail.sectionManage')}>
          <SettingsRow
            label={t('walletDetail.renameWallet')}
            leftIcon="pencilOutline"
            iconColor="textMuted"
            onPress={openRename}
            showBorder={canManageAccounts}
            testID="wallet-settings-rename"
            size="lg"
          >
            {chevron}
          </SettingsRow>
          {canManageAccounts ? (
            <SettingsRow
              label={t('walletDetail.manageAccounts')}
              leftIcon="manageAccount"
              iconColor="textMuted"
              onPress={() => router.navigate({pathname: '/settings/manage-accounts', params: {groupId: group.groupId}})}
              showBorder={hasMnemonic}
              testID="wallet-settings-manage-accounts"
              size="lg"
            >
              {chevron}
            </SettingsRow>
          ) : null}
          {hasMnemonic ? (
            <SettingsRow
              label={recoveryLabel}
              leftIcon="shieldCheck"
              iconColor={backupPending ? 'errorDefault' : 'textMuted'}
              onPress={handleBackup}
              testID="wallet-settings-backup"
              size="lg"
            >
              {chevron}
            </SettingsRow>
          ) : null}
          {/* A shared wallet's own screen: who can sign, under what rule, and the link
              that hands the whole composition to the other co-signers. Only for a
              script wallet — an ordinary wallet has no composition to show. */}
          {isSharedWallet ? (
            <SettingsRow
              label={t('multisig.composition.title')}
              description={t('multisig.composition.rowDescription')}
              leftIcon="wallet"
              iconColor="textMuted"
              onPress={() => router.navigate({pathname: '/wallet/shared-wallet', params: {id: group.groupId}})}
              testID="wallet-settings-composition"
              size="lg"
            >
              {chevron}
            </SettingsRow>
          ) : null}
          {/* Only a wallet that can actually contribute a key. A script has none, a watch-only
              import has none, and an xpriv import has no slot to read one from — for those three the
              destination could only ever refuse. A hardware wallet keeps the row: it offers to
              import the key from the device. */}
          {canShareCoSignerKey ? (
            <SettingsRow
              label={t('multisig.share.title')}
              description={t('multisig.share.rowDescription')}
              leftIcon="share"
              iconColor="textMuted"
              onPress={() => router.navigate({pathname: '/wallet/cosigner-key', params: {groupId: group.groupId}})}
              testID="wallet-settings-cosigner-key"
              size="lg"
            >
              {chevron}
            </SettingsRow>
          ) : null}
        </SettingsGroup>

        {/* Every funds wallet is removable — the Midnight identity is a separate
            singleton, so there's no "last wallet" that must be kept. */}
        <SettingsGroup label={t('walletDetail.sectionDangerZone')}>
          <SettingsRow
            label={t('walletDetail.deleteWallet')}
            leftIcon="delete"
            destructive
            onPress={openRemove}
            testID="wallet-settings-remove"
            size="lg"
          >
            {chevron}
          </SettingsRow>
        </SettingsGroup>
      </SafeAreaViewWrapper>

      {/* Rename sheet */}
      <Modal
        position="bottom"
        visible={sheetState === 'rename'}
        onClose={closeRename}
        title={t('walletDetail.rename.title')}
        showDragIndicator
      >
        <View style={styles.subBody}>
          <Typography variant="bodyMd_regular" style={styles.subTitle}>
            {t('walletDetail.rename.subtitle')}
          </Typography>
          <View style={styles.inputWrap}>
            <ChamferBackground size="auto" fillToken="backgroundAlternativeMuted" borderToken="borderDefaultWeak" />
            <TextInputBase
              ref={renameInputRef}
              style={styles.input}
              value={renameValue}
              onChangeText={setRenameValue}
              maxLength={MAX_WALLET_NAME_LENGTH}
              placeholder={t('walletDetail.rename.placeholder')}
              placeholderTextColor={theme.colors.textAlternative}
              returnKeyType="done"
              onSubmitEditing={handleSaveRename}
              testID="wallet-settings-rename-input"
            />
          </View>
          {isRenameDuplicate ? (
            <Typography variant="bodySm_regular" style={styles.errorText}>
              {t('onboarding.walletDetails.errors.nameDuplicate')}
            </Typography>
          ) : null}
          {isRenameTooLong ? (
            <Typography variant="bodySm_regular" style={styles.errorText}>
              {t('onboarding.walletDetails.errors.nameTooLong', {max: MAX_WALLET_NAME_LENGTH})}
            </Typography>
          ) : null}
          <View style={styles.btnRow}>
            <View style={styles.btnWrap}>
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                label={t('walletDetail.rename.cancel')}
                onPress={closeRename}
                isDisabled={isSavingRename}
                testID="wallet-settings-rename-cancel"
              />
            </View>
            <View style={styles.btnWrap}>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                label={t('walletDetail.rename.save')}
                onPress={handleSaveRename}
                isDisabled={!isRenameValid || isSavingRename}
                testID="wallet-settings-rename-save"
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Remove sheet */}
      <Modal
        position="bottom"
        visible={sheetState === 'remove'}
        onClose={closeRemove}
        title={t('walletDetail.deleteWalletTitle')}
        showDragIndicator
      >
        <View style={styles.subBody}>
          <Typography variant="bodyMd_regular" style={styles.removeBodyText}>
            {t(removeMessageKey, {name: group.name})}
          </Typography>
          {/*
            A shared wallet holds no key of its own — the co-signer wallets on
            this device are its only ability to sign. Removing the last of those
            leaves it listed, still holding whatever is at its address, and unable
            to ever spend again. Named here because nothing else on this screen
            would have hinted at it, and removed alongside on confirm.
          */}
          {stranded.length > 0 && (
            <Typography variant="bodyMd_regular" style={styles.removeBodyText} testID="remove-strands-shared">
              {t('walletDetail.deleteWalletStrandsShared', {
                names: stranded.map((w) => w.name).join(', '),
                count: stranded.length,
              })}
            </Typography>
          )}
          <View style={styles.btnRow}>
            <View style={styles.btnWrap}>
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                label={t('walletDetail.deleteWalletCancel')}
                onPress={closeRemove}
                testID="wallet-settings-delete-cancel"
              />
            </View>
            <View style={styles.btnWrap}>
              <Button
                variant="secondary"
                isError
                size="lg"
                fullWidth
                label={t('walletDetail.deleteWalletConfirm')}
                onPress={handleConfirmRemove}
                testID="wallet-settings-delete-confirm"
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  root: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing8,
    gap: spacing.spacing24,
    paddingBottom: spacing.spacing32,
  },

  subBody: {
    gap: spacing.spacing12,
  },
  subTitle: {
    color: colors.textAlternative,
  },
  inputWrap: {
    paddingHorizontal: spacing.spacing12,
    paddingVertical: spacing.spacing8,
  },
  input: {
    color: colors.textDefault,
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    color: colors.errorDefault,
  },

  removeBodyText: {
    color: colors.textAlternative,
  },

  lockedSection: {
    gap: spacing.spacing8,
  },

  btnRow: {
    flexDirection: 'row',
    gap: spacing.spacing12,
    paddingTop: spacing.spacing8,
  },
  btnWrap: {
    flex: 1,
  },
}))
