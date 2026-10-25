/**
 * Wallet Selection screen (V2 redesign).
 *
 * Lists wallet groups with a featured hero card for the active wallet and a
 * consolidated list for the others. Tap-inactive → 1-tap switch + land on
 * Home. A *backed-up* active hero card is non-interactive — re-selecting it is
 * a no-op (avoids spurious SELECT_WALLET dispatch that could re-trigger
 * device-bound work). An active card with **no backup** is pressable and goes
 * straight to the backup flow: it is already active, so there is nothing for
 * the advisory to offer.
 *
 * Switching *to* an un-backed-up wallet raises `BackupAdvisorySheet` first, and
 * that sheet's buttons carry the held tap out — see the advisory section below.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {StackActions, useIsFocused, useNavigation} from '@react-navigation/native'
import {router, useLocalSearchParams} from 'expo-router'
import {useCallback, useContext, useEffect, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components'
import {BackupAdvisorySheet} from '../../src/components/BackupAdvisorySheet/BackupAdvisorySheet'
import {Card} from '../../src/components/Card'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {WalletGroupCard} from '../../src/components/WalletGroupCard'
import {WalletIdenticon} from '../../src/components/WalletIdenticon'
import {useFeatureFlag} from '../../src/hooks/useFeatureFlag'
import {useGuardedNavigation} from '../../src/hooks/useGuardedNavigation'
import {BackupStatusContext} from '../../src/hooks/useMnemonicBackupStatus'
import {useToast} from '../../src/hooks/useToast'
import {useWalletStatusLabel} from '../../src/hooks/useWalletStatusLabel'
import {logger} from '../../src/logger'
import {useI18n, useWalletList, type WalletGroupView} from '../../src/providers'
import {accountIdenticonSeed} from '../../src/utils/account-display'

export default function WalletSelectionScreen() {
  const {walletGroups, selectedWalletGroup, selectedAccountIndex, selectWallet, selectAccount} = useWalletList()
  const {t} = useI18n()
  const isFocused = useIsFocused()
  const addWalletEnabled = useFeatureFlag('addWallet')

  const props = useLocalSearchParams<{addWallet?: string; returnToCaller?: string}>()
  const notShowAddWallet = props.addWallet === 'false'
  const showAddWallet = addWalletEnabled && !notShowAddWallet
  const returnToCaller = props.returnToCaller === 'true'

  const otherGroups = useMemo(
    () => walletGroups.filter((g) => g.groupId !== selectedWalletGroup?.groupId),
    [walletGroups, selectedWalletGroup?.groupId],
  )

  // ---------------------------------------------------------------------------
  // Backup advisory — the interstitial for activating a wallet with no backup
  // ---------------------------------------------------------------------------

  const backupCtx = useContext(BackupStatusContext)
  /**
   * The tap being held while the advisory is up.
   *
   * ⚠️ **The tap is not honoured until the sheet answers.** Holding it here is what lets the sheet
   * name the wallet the user actually pressed and then carry that exact selection out. The previous
   * version opened by itself when the screen was focused, about whichever pending wallet it found
   * first — which need not have been one the user was reaching for at all.
   */
  const [heldSelection, setHeldSelection] = useState<{
    readonly group: WalletGroupView
    readonly accountIndex?: number
  } | null>(null)

  // Read every mnemonic group's backup state, so the card's flag and the gate below agree. This
  // load is what populates `statusByGroup`; without it a pending wallet reads as backed up and the
  // interstitial never fires.
  useEffect(() => {
    if (!backupCtx || !isFocused) return
    for (const g of walletGroups) {
      if (g.primaryWallet?.source === 'mnemonic') backupCtx.loadGroup(g.groupId)
    }
  }, [walletGroups, backupCtx, isFocused])

  /** Does activating this wallet warrant the interstitial? */
  const needsBackupAdvisory = useCallback(
    (group: WalletGroupView): boolean =>
      group.primaryWallet?.source === 'mnemonic' && backupCtx?.statusByGroup.get(group.groupId) === true,
    [backupCtx],
  )

  const {showToast} = useToast()
  const selectGuard = useGuardedNavigation()
  const navigation = useNavigation()

  const finishSelection = useCallback(() => {
    if (returnToCaller) {
      // Switch flow opened from a gated caller (swap, buy): just dismiss
      // this screen so the caller resumes with the new active wallet.
      router.back()
      return
    }
    // Pop the root stack — `router.dismissAll()`/`dismissTo` only pop
    // the focused (settings) sub-stack, leaving prior-wallet routes
    // (e.g. a stale /send/amount) in the root that re-surface on
    // switch-back. Walk up one level to the root <Stack> and popToTop.
    const parent = navigation.getParent()
    if (parent) parent.dispatch(StackActions.popToTop())
    else router.dismissAll()
    // popToTop resets the root <Stack> but not the nested Tabs index, so
    // a prior tab could stay selected. Land back on Wallets — that's where
    // the switcher was opened from and where a funds wallet lives.
    router.replace('/wallets')
  }, [returnToCaller, navigation])

  /**
   * Activate a wallet (and optionally one of its accounts), then go wherever the caller says.
   *
   * `then` is a parameter rather than a fixed `finishSelection()` because the advisory's two buttons
   * differ only in where they land: "Later" leaves for the app, "Back up now" leaves for the backup
   * flow. Both must activate first, and neither may navigate if activation failed.
   */
  const activate = useCallback(
    (group: WalletGroupView, accountIndex: number | undefined, then: () => void) => {
      selectGuard.guard(async () => {
        try {
          // Selecting an account in another group first activates the group;
          // selectAccount targets the (now) active selection.
          if (accountIndex === undefined || group.groupId !== selectedWalletGroup?.groupId) {
            await selectWallet(group.groupId)
          }
          if (accountIndex !== undefined) await selectAccount(CARDANO_MAINNET, accountIndex)
          then()
        } catch (err) {
          showToast({variant: 'error', message: t('walletDetail.toast.setActiveFailed', {name: group.name})})
          logger.error('Failed to set wallet active', {
            origin: 'WalletSelectionScreen',
            groupId: group.groupId,
            accountIndex,
            err,
          })
          throw err
        }
      })
    },
    [selectGuard, selectWallet, selectAccount, selectedWalletGroup?.groupId, showToast, t],
  )

  const handleSelectWallet = useCallback(
    (group: WalletGroupView) => {
      // Held, not honoured: the sheet decides what happens to this tap.
      if (needsBackupAdvisory(group)) {
        setHeldSelection({group})
        return
      }
      activate(group, undefined, finishSelection)
    },
    [needsBackupAdvisory, activate, finishSelection],
  )

  const handleSelectAccount = useCallback(
    (group: WalletGroupView, accountIndex: number) => {
      // ⚠️ Only when this is a *switch*. Picking another account inside the already-active group is
      // an account change, and an advisory offering to "activate the wallet" would both misdescribe
      // it and hijack the only way to change account.
      if (group.groupId !== selectedWalletGroup?.groupId && needsBackupAdvisory(group)) {
        setHeldSelection({group, accountIndex})
        return
      }
      activate(group, accountIndex, finishSelection)
    },
    [needsBackupAdvisory, activate, finishSelection, selectedWalletGroup?.groupId],
  )

  /** "Later" — the switch the user asked for, and nothing about the backup. */
  const handleAdvisoryLater = useCallback(() => {
    const held = heldSelection
    setHeldSelection(null)
    if (held) activate(held.group, held.accountIndex, finishSelection)
  }, [heldSelection, activate, finishSelection])

  /** Open the backup flow for one specific wallet. */
  const openBackup = useCallback((group: WalletGroupView) => {
    router.navigate({pathname: '/settings/recovery-phrase-warn', params: {groupId: group.groupId}})
  }, [])

  /** "Back up now" — the same switch, landing in the backup flow for *that* wallet. */
  const handleAdvisoryBackUpNow = useCallback(() => {
    const held = heldSelection
    setHeldSelection(null)
    if (!held) return
    activate(held.group, held.accountIndex, () => openBackup(held.group))
  }, [heldSelection, activate, openBackup])

  const renderGroup = (group: WalletGroupView, isActive: boolean) => {
    const accounts = group.primaryWallet.accounts
    if (accounts.length <= 1) {
      return (
        <WalletGroupCard
          key={group.groupId}
          group={group}
          isActive={isActive}
          // The active card is inert *unless* it has no backup: there is nothing left to activate, so
          // the advisory would have no switch to offer and its press is the backup itself. A
          // backed-up active card stays inert — re-selecting it is a no-op.
          onPress={
            isActive
              ? needsBackupAdvisory(group)
                ? () => openBackup(group)
                : undefined
              : () => handleSelectWallet(group)
          }
        />
      )
    }
    return (
      <MultiAccountGroup
        key={group.groupId}
        group={group}
        isActive={isActive}
        selectedAccountIndex={selectedAccountIndex}
        accountLabel={(index) => t('manageAccounts.accountLabel', {index})}
        onSelectAccount={handleSelectAccount}
      />
    )
  }

  const handleAddWallet = useCallback(() => {
    // Settings wallet selection
    // routes to the dedicated 3-tile picker (Create / Restore / Hardware)
    // instead of the first-time onboarding restore screen.
    router.navigate('/onboarding/add-wallet' as Parameters<typeof router.navigate>[0])
  }, [])

  return (
    <View style={styles.root}>
      <SafeAreaViewWrapper
        edges={showAddWallet ? [] : ['bottom']}
        scrollable
        contentContainerStyle={styles.scrollContent}
        stickyFooter={
          showAddWallet ? (
            <StickyFooter>
              <Button
                onPress={handleAddWallet}
                label={t('walletSelection.addWallet')}
                fullWidth
                size="xl"
                variant="secondary"
                testID="wallet-selection-add"
              />
            </StickyFooter>
          ) : undefined
        }
      >
        <View style={styles.content}>
          {selectedWalletGroup ? (
            <View style={styles.section}>
              <Typography variant="bodySm_medium" style={styles.sectionLabel}>
                {t('walletSelection.activeWallet')}
              </Typography>
              {renderGroup(selectedWalletGroup, true)}
            </View>
          ) : null}

          {otherGroups.length > 0 ? (
            <View style={styles.section}>
              <Typography variant="bodySm_medium" style={styles.sectionLabel}>
                {t('walletSelection.otherWallets')}
              </Typography>
              <View style={styles.groupList}>{otherGroups.map((group) => renderGroup(group, false))}</View>
            </View>
          ) : null}
        </View>
      </SafeAreaViewWrapper>
      <BackupAdvisorySheet
        walletName={heldSelection?.group.name ?? null}
        onDismiss={() => setHeldSelection(null)}
        onLater={handleAdvisoryLater}
        onBackUpNow={handleAdvisoryBackUpNow}
      />
    </View>
  )
}

function MultiAccountGroup({
  group,
  isActive,
  selectedAccountIndex,
  accountLabel,
  onSelectAccount,
}: {
  group: WalletGroupView
  isActive: boolean
  selectedAccountIndex: number
  accountLabel: (index: number) => string
  onSelectAccount: (group: WalletGroupView, accountIndex: number) => void
}) {
  const {label: statusLabel, isWarning} = useWalletStatusLabel(group)
  const baseSeed = group.primaryWallet.checksum?.seed ?? group.groupId
  return (
    <View style={styles.multiGroup}>
      <View style={styles.multiGroupHeader}>
        <Typography variant="bodyLg_semibold" numberOfLines={1} style={styles.multiGroupName}>
          {group.name}
        </Typography>
        {statusLabel ? (
          <Typography
            variant="bodySm_regular"
            numberOfLines={1}
            style={[styles.status, isWarning ? styles.statusWarn : styles.statusOk]}
          >
            · {statusLabel}
          </Typography>
        ) : null}
      </View>
      <View style={styles.groupList}>
        {group.primaryWallet.accounts.map((account) => {
          const selected = isActive && account.index === selectedAccountIndex
          return (
            <AccountSubcard
              key={account.index}
              label={accountLabel(account.index)}
              seed={accountIdenticonSeed(baseSeed, account.index)}
              selected={selected}
              onPress={selected ? undefined : () => onSelectAccount(group, account.index)}
              testID={`wallet-selection-account-${group.groupId}-${account.index}`}
            />
          )
        })}
      </View>
    </View>
  )
}

function AccountSubcard({
  label,
  seed,
  selected,
  onPress,
  testID,
}: {
  label: string
  seed: string
  selected: boolean
  onPress?: (() => void) | undefined
  testID?: string | undefined
}) {
  const content = (
    <Card variant={selected ? 'selected' : 'outlined'} style={styles.subcard}>
      <WalletIdenticon seed={seed} iconStyle="blockies" size={32} />
      <Typography variant="bodyMd_medium" numberOfLines={1} style={styles.subcardLabel}>
        {label}
      </Typography>
      {selected ? (
        <UniIcon name="check" width={16} height={16} uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
      ) : (
        <UniIcon name="rightThin" width={12} height={12} uniProps={(theme) => ({color: theme.colors.textMuted})} />
      )}
    </Card>
  )
  return onPress ? (
    <Pressable onPress={onPress} style={({pressed}) => pressed && styles.pressed} testID={testID}>
      {content}
    </Pressable>
  ) : (
    <View testID={testID}>{content}</View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create(({colors, spacing}) => ({
  root: {
    flex: 1,
  },
  multiGroup: {
    gap: spacing.spacing8,
  },
  multiGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing4,
    paddingHorizontal: spacing.spacing12,
    minWidth: 0,
  },
  multiGroupName: {
    flexShrink: 1,
    minWidth: 0,
  },
  status: {
    flexShrink: 0,
  },
  statusOk: {
    color: colors.textAlternative,
  },
  statusWarn: {
    color: colors.errorDefault,
    fontWeight: '600',
  },
  subcard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    marginLeft: spacing.spacing12,
  },
  subcardLabel: {
    flex: 1,
    minWidth: 0,
  },
  pressed: {
    opacity: 0.85,
    transform: [{scale: 0.985}],
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing16,
    flexGrow: 1,
  },
  content: {
    gap: spacing.spacing20,
  },
  section: {
    gap: spacing.spacing8,
  },
  groupList: {
    gap: spacing.spacing8,
  },
  sectionLabel: {
    color: colors.textMuted,
    textTransform: 'uppercase',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.9,
    paddingHorizontal: spacing.spacing12,
  },
}))
