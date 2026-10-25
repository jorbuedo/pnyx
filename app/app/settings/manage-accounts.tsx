/**
 * Manage Accounts screen.
 *
 * Lists the active wallet group's derived Cardano accounts (#0 + any derived
 * via CIP-1852 `m/1852'/1815'/n'/…`), marks the active one, shows an on-chain
 * used/new signal (Koios `/account_addresses`), and — for software wallets —
 * lets the user derive the next account. Selecting a row switches the active
 * account; every account has its own xpub / addresses / UTxOs / history.
 *
 * @module
 */

import {CARDANO_MAINNET} from '@pnyx/config'
import {router, Stack, useLocalSearchParams} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../src/components/SettingsGroup'
import {SettingsRow} from '../../src/components/SettingsRow'
import {StickyFooter} from '../../src/components/StickyFooter'
import {Tag} from '../../src/components/Tag'
import {Typography} from '../../src/components/Typography'
import {WalletIdenticon} from '../../src/components/WalletIdenticon'
import {useCardanoAccountUsage} from '../../src/hooks/useCardanoAccountUsage'
import {useCardanoRail} from '../../src/hooks/useCardanoRail'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {useI18n, useWalletList} from '../../src/providers'
import {truncateMiddle} from '../../src/screens/cardano/review/format'
import {accountIdenticonSeed} from '../../src/utils/account-display'

export default function ManageAccountsScreen() {
  const {groupId} = useLocalSearchParams<{groupId: string}>()
  const {t} = useI18n()
  const {showToast} = useToast()
  const {walletGroups, selectedWalletGroup, selectedAccountIndex, selectAccount, addAccount, selectWallet} =
    useWalletList()

  // The account actions operate on the ACTIVE selection, so make the target
  // group active on entry when the settings screen was opened for another group.
  useEffect(() => {
    if (groupId && selectedWalletGroup?.groupId !== groupId) void selectWallet(groupId)
  }, [groupId, selectedWalletGroup?.groupId, selectWallet])

  const group = useMemo(
    () => walletGroups.find((g) => g.groupId === groupId) ?? selectedWalletGroup ?? null,
    [walletGroups, groupId, selectedWalletGroup],
  )
  const isActiveGroup = group?.groupId === selectedWalletGroup?.groupId
  const source = group?.primaryWallet.source
  const isSoftware = source === 'mnemonic'
  const isHardware = group?.primaryWallet.isHardware === true

  const accounts = useMemo(() => group?.primaryWallet.accounts ?? [], [group])
  const accountIndices = useMemo(() => accounts.map((a) => a.index), [accounts])
  const baseSeed = group?.primaryWallet.checksum?.seed ?? group?.groupId ?? ''

  const {rail} = useCardanoRail()
  const usageByIndex = useCardanoAccountUsage(isActiveGroup ? rail : null, accountIndices)

  const [adding, setAdding] = useState(false)

  const handleSelect = useCallback(
    (index: number) => {
      if (!isActiveGroup || index === selectedAccountIndex) return
      void selectAccount(CARDANO_MAINNET, index)
    },
    [isActiveGroup, selectedAccountIndex, selectAccount],
  )

  const handleAdd = useCallback(async () => {
    setAdding(true)
    try {
      await addAccount(CARDANO_MAINNET)
    } catch (err) {
      logger.error('Failed to add account', {origin: 'ManageAccountsScreen', groupId, err})
      showToast({variant: 'error', message: t('manageAccounts.addFailed')})
    } finally {
      setAdding(false)
    }
  }, [addAccount, groupId, showToast, t])

  if (!group) return null

  const usageTag = (usage: 'used' | 'fresh' | 'unknown' | undefined) => {
    if (usage === 'used') return <Tag size="sm" variant="success" label={t('manageAccounts.used')} />
    if (usage === 'fresh') return <Tag size="sm" variant="secondary" label={t('manageAccounts.fresh')} />
    return null
  }

  return (
    <View style={styles.root}>
      <Stack.Screen options={{title: t('manageAccounts.title')}} />
      <SafeAreaViewWrapper
        edges={isSoftware || isHardware ? [] : ['bottom']}
        scrollable
        contentContainerStyle={styles.scrollContent}
        stickyFooter={
          isSoftware ? (
            <StickyFooter>
              <Button
                onPress={handleAdd}
                label={adding ? t('manageAccounts.adding') : t('manageAccounts.addAccount')}
                fullWidth
                size="xl"
                variant="secondary"
                disabled={adding}
                loading={adding}
                testID="manage-accounts-add"
              />
            </StickyFooter>
          ) : isHardware ? (
            <StickyFooter>
              {/* Hardware accounts are derived on-device, so re-enter the pairing
                  flow (add-account mode) to select another account. */}
              <Button
                onPress={() =>
                  router.navigate({pathname: '/wallet/pair-device', params: {groupId: group.groupId}} as Parameters<
                    typeof router.navigate
                  >[0])
                }
                label={t('manageAccounts.addAccount')}
                fullWidth
                size="xl"
                variant="secondary"
                testID="manage-accounts-add-hardware"
              />
            </StickyFooter>
          ) : undefined
        }
      >
        <Typography variant="bodySm_regular" style={styles.subtitle}>
          {t('manageAccounts.subtitle')}
        </Typography>
        <SettingsGroup label={t('manageAccounts.sectionAccounts')}>
          {accounts.map((account, i) => {
            const info = usageByIndex.get(account.index)
            const isSelected = isActiveGroup && account.index === selectedAccountIndex
            return (
              <SettingsRow
                key={account.index}
                label={t('manageAccounts.accountLabel', {index: account.index})}
                description={info?.address ? truncateMiddle(info.address, 12, 8) : undefined}
                leftSlot={
                  <WalletIdenticon
                    seed={accountIdenticonSeed(baseSeed, account.index)}
                    iconStyle="blockies"
                    size={32}
                  />
                }
                showBorder={i < accounts.length - 1}
                onPress={() => handleSelect(account.index)}
                labelAccessory={
                  isSelected ? <Tag size="sm" variant="primary" label={t('manageAccounts.active')} /> : undefined
                }
                testID={`manage-accounts-row-${account.index}`}
                size="md"
              >
                <View style={styles.rowRight}>{usageTag(info?.usage)}</View>
              </SettingsRow>
            )
          })}
        </SettingsGroup>
      </SafeAreaViewWrapper>
    </View>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  root: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing16,
    flexGrow: 1,
  },
  subtitle: {
    color: colors.textMuted,
    paddingHorizontal: spacing.spacing4,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing8,
  },
}))
