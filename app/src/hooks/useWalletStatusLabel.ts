/**
 * Single source of truth for the wallet status label displayed in settings.
 *
 * The decision lives in `wallet-status-reason.ts` (pure, tested); this binds it
 * to the group's backup state and to the translations. Both the settings hub and
 * the wallet selection screen use this hook, so the label cannot diverge between
 * them.
 *
 * @module
 */

import {useMemo} from 'react'
import type {WalletGroup} from '../providers'
import {useI18n} from '../providers'
import {useMnemonicBackupStatus} from './useMnemonicBackupStatus'
import {useSharedWalletOnNetwork} from './useSharedWalletOnNetwork'
import {type WalletStatusReason, walletStatusReasonOf} from './wallet-status-reason'

type WalletStatusResult = {
  /** Translated label string */
  readonly label: string
  /** Whether the label should be styled as a warning */
  readonly isWarning: boolean
  /** Identifies which specific status case produced the label */
  readonly reason: WalletStatusReason | null
}

const EMPTY: WalletStatusResult = {label: '', isWarning: false, reason: null}

export const useWalletStatusLabel = (group: WalletGroup | null): WalletStatusResult => {
  const {t} = useI18n()
  const {isPending: backupPending} = useMnemonicBackupStatus(group?.groupId)
  const registeredOnActiveNetwork = useSharedWalletOnNetwork(
    group?.groupId ?? null,
    group?.primaryWallet.source === 'multisig',
  )

  return useMemo<WalletStatusResult>(() => {
    if (!group) return EMPTY

    const wallet = group.primaryWallet
    const reason = walletStatusReasonOf({
      ...(wallet.isHardware === undefined ? {} : {isHardware: wallet.isHardware}),
      ...(wallet.implementation === undefined ? {} : {implementation: wallet.implementation}),
      ...(wallet.source === undefined ? {} : {source: wallet.source}),
      // `null` and `undefined` both mean "not known yet" to the decision.
      ...(backupPending === undefined || backupPending === null ? {} : {backupPending}),
      ...(registeredOnActiveNetwork === undefined ? {} : {registeredOnActiveNetwork}),
    })

    switch (reason) {
      case 'hardware':
        return {label: t('settings.hub.hardwareWallet'), isWarning: false, reason}
      case 'readOnly':
        return {label: t('settings.hub.readOnly'), isWarning: false, reason}
      case 'shared':
        return {label: t('settings.hub.sharedWallet'), isWarning: false, reason}
      // A warning, because selecting it leads to a wallet with no rail: the
      // roster it needs to compile its addresses is filed under the other network.
      case 'sharedOtherNetwork':
        return {label: t('settings.hub.sharedWalletOtherNetwork'), isWarning: true, reason}
      case 'backupPending':
        return {label: t('settings.hub.notBackedUp'), isWarning: true, reason}
      default:
        return {...EMPTY, reason}
    }
  }, [group, backupPending, registeredOnActiveNetwork, t])
}
