import {Stack} from 'expo-router'
import {ThemedStack} from '../../src/components/ThemedStack'
import {useI18n} from '../../src/providers'

export default function SettingsLayout() {
  const {t} = useI18n()

  return (
    <ThemedStack>
      <Stack.Screen
        name="index"
        options={{
          title: '',
        }}
      />
      <Stack.Screen name="network" options={{title: t('settings.network.title')}} />
      <Stack.Screen name="endpoints" options={{title: t('settings.endpoints.title')}} />
      <Stack.Screen name="theme" options={{title: t('settings.theme.title')}} />
      <Stack.Screen name="language" options={{title: t('settings.language.title')}} />
      <Stack.Screen name="number-format" options={{title: t('settings.numberFormat.title')}} />
      <Stack.Screen name="currency" options={{title: t('settings.currency.title')}} />
      <Stack.Screen name="explorer" options={{title: t('settings.explorer.title')}} />
      <Stack.Screen name="wallet-optimization" options={{title: t('settings.walletOptimization.title')}} />
      <Stack.Screen name="security" options={{title: t('settings.security.title')}} />
      {/* Title only — the screen's own heading carries which code is being set. */}
      <Stack.Screen name="pin-setup" options={{title: t('settings.security.pin.setupScreenTitle')}} />
      <Stack.Screen name="notifications" options={{title: t('settings.notifications.title')}} />
      <Stack.Screen name="messaging" options={{title: t('settings.messaging.title')}} />
      <Stack.Screen name="connected-dapps" options={{title: t('settings.connectedDapps.title')}} />
      <Stack.Screen name="ai" options={{title: t('aiSettings.title')}} />
      <Stack.Screen name="agents" options={{title: t('agents.title')}} />
      <Stack.Screen name="signing-history" options={{title: t('settings.signingAudit.title')}} />
      <Stack.Screen name="bug-report" options={{title: t('bugReport.title')}} />
      <Stack.Screen name="protocol-links" options={{title: t('settings.protocolLinks.title')}} />
      <Stack.Screen name="wallet-selection" options={{title: t('walletSelection.screenTitle')}} />
      <Stack.Screen name="wallet-settings" options={{title: ''}} />
      <Stack.Screen name="manage-accounts" options={{title: t('manageAccounts.title')}} />
      <Stack.Screen name="backup-verification" options={{title: t('settings.backup.title')}} />
      <Stack.Screen name="recovery-phrase-warn" options={{title: t('settings.backup.title')}} />
      <Stack.Screen name="passkey-recovery" options={{title: t('passkeyRecovery.title')}} />
      {/* Tools first, then probes alphabetically — the same order as the menu (`dev-tools-rows.ts`).
          A screen with no entry here opens with its raw pathname as the title, which is how
          `dev/tx-lookup` shipped looking broken; `dev-tools-rows.test.ts` pins the set. */}
      <Stack.Screen name="dev/feature-flags" options={{title: t('settings.developer.featureFlags')}} />
      <Stack.Screen name="dev/logs" options={{title: t('settings.developer.logs')}} />
      <Stack.Screen name="dev/tx-lookup" options={{title: t('settings.developer.txLookup')}} />
      <Stack.Screen name="dev/notifications" options={{title: t('settings.developer.notificationsTest')}} />
      <Stack.Screen name="dev/dust-probe" options={{title: 'DUST probe'}} />
      <Stack.Screen name="dev/compact-probe" options={{title: 'Compact driver probe'}} />
      <Stack.Screen name="dev/handle-fold-probe" options={{title: 'Handle case-fold probe'}} />
      <Stack.Screen name="dev/swap-probe" options={{title: 'Swap rail'}} />
      <Stack.Screen name="dev/identity-row-probe" options={{title: 'Identity row probe'}} />
      <Stack.Screen name="dev/keychain-probe" options={{title: 'Keychain probe'}} />
      <Stack.Screen name="dev/mls-probe" options={{title: 'MLS on Hermes probe'}} />
      <Stack.Screen name="dev/model-probe" options={{title: 'On-device model probe'}} />
      <Stack.Screen name="dev/nfc-probe" options={{title: 'Unicode NFC probe'}} />
      <Stack.Screen name="dev/proving-probe" options={{title: 'On-device proving probe'}} />
      <Stack.Screen name="dev/shielded-wallet-probe" options={{title: 'Shielded wallet probe'}} />
      <Stack.Screen name="dev/unshielded-send-probe" options={{title: 'Unshielded send probe'}} />
    </ThemedStack>
  )
}
