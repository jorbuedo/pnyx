/**
 * Source hook: light up Wallet Management when the **active** wallet group
 * has a pending mnemonic backup.
 *
 *   /settings                          (dashboard avatar)
 *   /settings/wallet-settings          (Wallet Management row → active group)
 *
 * Scoped to the active group on purpose. A per-group dot that lit up for a
 * *non-active* group would send the user to Wallet Management (which always
 * opens the active group) and leave them to discover they first have to
 * switch groups — confusing. The dot only points somewhere actionable: the
 * group you're already in.
 *
 * Not dismissable — backup is the whole point; the dot only clears when the
 * user completes verification and `confirmGroup` flips the storage bit.
 *
 * @module
 */

import {useMnemonicBackupStatus} from '../../hooks/useMnemonicBackupStatus'
import {useWalletList} from '../../providers'
import {useRegisterNotice} from '../useNoticeDot'

const KEY = 'backup-pending'
const ROUTE = '/settings/wallet-settings'

export const useBackupNotice = (): void => {
  const {selectedWalletGroup} = useWalletList()
  const {isPending} = useMnemonicBackupStatus(selectedWalletGroup?.groupId)
  useRegisterNotice(KEY, {route: ROUTE, active: isPending === true})
}
