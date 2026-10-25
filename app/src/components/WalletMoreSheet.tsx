/**
 * The "More" bottom sheet behind the wallet's fourth quick action — the
 * per-account wallet actions that don't fit the primary Send / Receive / Swap
 * row. Everything here is scoped to the active Cardano account (`useCardanoRail`
 * / a send flow), which is why these live on Wallets rather than in the Menu tab.
 * Shared by the Wallets home and the Cardano portfolio.
 *
 * No header and no per-row chevrons: the drag indicator already says what it is.
 *
 * Add an action by appending to {@link ACTIONS}; nothing else needs touching.
 * Rows carry no divider (`SettingsRow` defaults `showBorder` off) — the icon plus
 * the row gap is the separation.
 *
 * @module
 */

import {router} from 'expo-router'
import type {TranslationKey} from '../i18n'
import {useI18n} from '../providers'
import {Modal} from './Modal'
import {SettingsRow} from './SettingsRow'
import type {UniIconName} from './UniIcon'

export type WalletMoreSheetProps = {
  readonly visible: boolean
  readonly onClose: () => void
}

type MoreAction = {
  readonly labelKey: TranslationKey
  readonly icon: UniIconName
  readonly route: string
  readonly testID: string
}

const ACTIONS: readonly MoreAction[] = [
  {labelKey: 'cardanoStaking.title', icon: 'growthStaking', route: '/wallet/stake', testID: 'more-staking'},
  {labelKey: 'wallets.moreActions.utxos', icon: 'layers', route: '/wallet/utxos', testID: 'more-utxos'},
  {labelKey: 'midnightDust.title', icon: 'midnight', route: '/wallet/dust', testID: 'more-dust'},
  {labelKey: 'pending.importCosign', icon: 'sign', route: '/wallet/cosign', testID: 'more-cosign'},
  {labelKey: 'wallets.moreActions.donate', icon: 'support', route: '/wallet/donate', testID: 'more-donate'},
]

export const WalletMoreSheet = ({visible, onClose}: WalletMoreSheetProps) => {
  const {t} = useI18n()
  const go = (route: string) => {
    onClose()
    router.push(route as Parameters<typeof router.push>[0])
  }

  return (
    <Modal visible={visible} onClose={onClose} position="bottom">
      {ACTIONS.map((action) => (
        <SettingsRow
          key={action.route}
          label={t(action.labelKey)}
          leftIcon={action.icon}
          onPress={() => go(action.route)}
          testID={action.testID}
        />
      ))}
    </Modal>
  )
}
