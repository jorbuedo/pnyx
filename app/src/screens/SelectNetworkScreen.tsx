/**
 * Network selection screen — Mainnet, Preprod or Preview.
 *
 * The network drives every chain-facing read (Koios endpoint, address prefixes,
 * explorer links) and what the app is allowed to show (see
 * `config/network-capabilities.ts`), so switching re-syncs the wallet. Moving to
 * a testnet asks for confirmation once, with a "don't ask again" opt-out;
 * returning to mainnet applies immediately — there is nothing to warn about.
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'

import {router} from 'expo-router'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Button} from '../components/Buttons'
import {ChamferBackground} from '../components/Chamfer'
import {Modal} from '../components/Modal'
import {SafeAreaViewWrapper} from '../components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../components/SettingsPickerRow'
import {Toggle} from '../components/Toggle'
import {Typography} from '../components/Typography'
import {UniIcon} from '../components/UniIcon'
import {chainAvailability} from '../config/chain-availability'
import {isTestnetNetwork} from '../config/network-capabilities'
import {NETWORKS} from '../config/networks'
import type {TranslationKey} from '../i18n/types'
import {storage} from '../platform/storage'
import {useConfig} from '../providers/ConfigProvider'
import {useI18n} from '../providers/I18nProvider'
import {currentRemoteRules} from '../services/midnight/endpoint-overrides'
import {getNetworkDisplayName} from '../utils/network-utils'

const SKIP_TESTNET_WARNING_KEY = '@pnyx/skip_testnet_warning'

/**
 * Reason codes the control plane may publish. An unrecognised one falls back to the generic
 * sentence rather than rendering the raw code at the user.
 */
const REASON_KEY = {
  decommissioned: 'settings.endpoints.reason.decommissioned',
  maintenance: 'settings.endpoints.reason.maintenance',
  unspecified: 'settings.endpoints.reason.unspecified',
} as const satisfies Record<string, TranslationKey>

const reasonSentence = (code: string | null): TranslationKey =>
  (REASON_KEY as Record<string, TranslationKey>)[code ?? 'unspecified'] ?? 'settings.endpoints.reason.unspecified'

const DESCRIPTION_KEY = {
  mainnet: 'settings.network.mainnetDescription',
  preprod: 'settings.network.preprodDescription',
  preview: 'settings.network.previewDescription',
} as const satisfies Record<Network, string>

export function SelectNetworkScreen() {
  const {t} = useI18n()
  const {network, setNetwork} = useConfig()
  const [pendingNetwork, setPendingNetwork] = useState<Network | null>(null)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const applyNetwork = async (next: Network) => {
    // Always land on Wallets, never `back()`. A network change swaps the whole wallet layer — new
    // service, new SQLite files, different addresses and balances — so whatever screen the user came
    // from is either meaningless on the new network or showing the old one's data. Wallets is the one
    // place that is always correct afterwards.
    //
    // It also sidesteps a real bug: `setNetwork` remounts the provider tree in the same render flush as
    // its state update, so a `back()` after the await found no navigator and logged "The action
    // 'GO_BACK' was not handled by any navigator" on every switch. `canGoBack()` did not help — it reads
    // the router state that is already being torn down and still answers true. Navigating *before* the
    // switch, to a fixed route, depends on no history at all.
    router.replace('/wallets')
    await setNetwork(next)
  }

  const handleNetworkChange = async (next: Network) => {
    if (next === network) return
    if (!isTestnetNetwork(next)) {
      await applyNetwork(next)
      return
    }
    if ((await storage.get(SKIP_TESTNET_WARNING_KEY)) === 'true') {
      await applyNetwork(next)
      return
    }
    setPendingNetwork(next)
  }

  const confirmNetworkChange = async () => {
    if (pendingNetwork === null) return
    if (dontShowAgain) await storage.set(SKIP_TESTNET_WARNING_KEY, 'true')
    const next = pendingNetwork
    setPendingNetwork(null)
    await applyNetwork(next)
  }

  const cancelNetworkChange = () => {
    setPendingNetwork(null)
    setDontShowAgain(false)
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <Typography variant="bodySm_regular" style={styles.intro}>
        {t('settings.network.description')}
      </Typography>

      <View style={styles.list}>
        {NETWORKS.map((option) => {
          // A network the control plane has switched off stays listed and says so. Removing the row
          // would leave someone selected on a network that is no longer offered with nothing to
          // explain why their balances stopped loading.
          const availability = chainAvailability(currentRemoteRules(), 'cardano', option)
          return (
            <SettingsPickerRow
              key={option}
              label={getNetworkDisplayName(option, false)}
              sublabel={
                availability.usable
                  ? t(DESCRIPTION_KEY[option])
                  : t('settings.network.unavailableReason', {reason: t(reasonSentence(availability.reasonCode))})
              }
              trailingText={availability.usable ? undefined : t('settings.network.unavailableBadge')}
              isDisabled={!availability.usable}
              selected={option === network}
              onPress={() => {
                void handleNetworkChange(option)
              }}
              testID={`network-option-${option}`}
              checkboxVariant="radio"
            />
          )
        })}
      </View>

      <View style={styles.infoBox}>
        <ChamferBackground size="auto" fillToken="primaryMuted" />
        <UniIcon name="info" size="md" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
        <View style={styles.infoText}>
          <Typography variant="bodySm_regular">{t('settings.network.testnetWarning')}</Typography>
          <Typography variant="bodySm_regular" style={styles.infoMuted}>
            {t('settings.network.testnetRestrictions')}
          </Typography>
        </View>
      </View>

      <Modal
        visible={pendingNetwork !== null}
        title={t('settings.network.switchConfirmTitle')}
        onClose={cancelNetworkChange}
        position="bottom"
      >
        <View style={styles.modalContent}>
          <Typography variant="bodyMd_regular" style={styles.modalText}>
            {t('settings.network.switchConfirmMessage', {
              network: pendingNetwork === null ? '' : getNetworkDisplayName(pendingNetwork, false),
            })}
          </Typography>
          <Typography variant="bodyMd_regular" style={styles.modalText}>
            {t('settings.network.switchConfirmMessage2')}
          </Typography>

          <View style={styles.checkboxContainer}>
            <Toggle checked={dontShowAgain} onChange={setDontShowAgain} />
            <Typography variant="bodySm_regular" onPress={() => setDontShowAgain(!dontShowAgain)}>
              {t('settings.network.dontShowAgain')}
            </Typography>
          </View>

          <View style={styles.modalActions}>
            <Button
              label={t('settings.network.cancel')}
              variant="secondary"
              onPress={cancelNetworkChange}
              style={styles.modalButton}
            />
            <Button
              label={t('settings.network.confirm')}
              variant="primary"
              onPress={() => {
                void confirmNetworkChange()
              }}
              style={styles.modalButton}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingBottom: spacing.spacing80,
    gap: spacing.spacing12,
  },
  intro: {
    color: colors.textAlternative,
    paddingHorizontal: spacing.spacing4,
  },
  list: {
    gap: spacing.spacing6,
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.spacing16,
    gap: spacing.spacing12,
  },
  infoText: {
    flex: 1,
    gap: spacing.spacing4,
  },
  infoMuted: {
    color: colors.textAlternative,
  },
  modalContent: {
    gap: spacing.spacing16,
  },
  modalText: {
    color: colors.textAlternative,
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing8,
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.spacing12,
  },
  modalButton: {
    flex: 1,
  },
}))
