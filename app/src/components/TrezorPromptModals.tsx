/**
 * Trezor interaction prompts (PIN / passphrase / pairing code), driven by the
 * hardware service's active `trezorUIRequest`. Minimal + token/i18n-compliant;
 * the device shows the scrambled PIN layout, so the PIN entry is a plain
 * secure field submitted to `resolveTrezorPin`.
 *
 * ⚠️ **Mounted once, app-wide, in `app/_layout.tsx`** — not per screen. The
 * device raises these requests from any operation that opens a session, so a
 * prompt reachable only from the pair screen is a prompt that is absent exactly
 * when it is needed. It used to live inside `HardwarePairScreen`, which meant a
 * send or a stake delegation whose reconnect needed THP pairing had nowhere to
 * ask: the Trezor displayed its 6-digit code and the app showed
 * "reconnecting" until the device gave up. Renders `null` with no active
 * request, so the global mount costs nothing.
 *
 * @module
 */

import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../providers'
import {useHardwareWallet} from '../providers/HardwareWalletProvider'
import {Modal} from './Modal'
import {TextInput} from './TextInput'

const styles = StyleSheet.create(({spacing}) => ({
  field: {marginTop: spacing.spacing8},
}))

export const TrezorPromptModals = () => {
  const {t} = useI18n()
  const hw = useHardwareWallet()
  const request = hw.trezorUIRequest
  const [value, setValue] = useState('')

  const close = () => setValue('')

  if (request === null) return null

  if (request.type === 'pin' || request.type === 'invalid_pin') {
    return (
      <Modal
        visible
        position="bottom"
        title={t('hardware.trezor.pinTitle')}
        description={t('hardware.trezor.pinSubtitle')}
        onClose={() => {
          hw.rejectTrezorPin()
          close()
        }}
        actions={[
          {label: t('hardware.trezor.cancel'), variant: 'secondary', onPress: () => hw.rejectTrezorPin()},
          {
            label: t('hardware.trezor.submit'),
            variant: 'primary',
            onPress: () => {
              hw.resolveTrezorPin(value)
              close()
            },
          },
        ]}
        actionsLayout="horizontal"
      >
        <View style={styles.field}>
          <TextInput
            fullWidth
            value={value}
            onChange={setValue}
            secureTextEntry
            keyboardType="number-pad"
            testID="trezor-pin"
          />
        </View>
      </Modal>
    )
  }

  if (request.type === 'passphrase') {
    return (
      <Modal
        visible
        position="bottom"
        title={t('hardware.trezor.passphraseTitle')}
        onClose={() => {
          hw.rejectTrezorPassphrase()
          close()
        }}
        actions={[
          {label: t('hardware.trezor.cancel'), variant: 'secondary', onPress: () => hw.rejectTrezorPassphrase()},
          {
            label: t('hardware.trezor.submit'),
            variant: 'primary',
            onPress: () => {
              hw.resolveTrezorPassphrase(value)
              close()
            },
          },
        ]}
        actionsLayout="horizontal"
      >
        <View style={styles.field}>
          <TextInput fullWidth value={value} onChange={setValue} secureTextEntry testID="trezor-passphrase" />
        </View>
      </Modal>
    )
  }

  if (request.type === 'pairing_code') {
    return (
      <Modal
        visible
        position="bottom"
        title={t('hardware.trezor.pairingTitle')}
        onClose={() => {
          hw.rejectPairingCode()
          close()
        }}
        actions={[
          {label: t('hardware.trezor.cancel'), variant: 'secondary', onPress: () => hw.rejectPairingCode()},
          {
            label: t('hardware.trezor.submit'),
            variant: 'primary',
            onPress: () => {
              hw.resolvePairingCode(value)
              close()
            },
          },
        ]}
        actionsLayout="horizontal"
      >
        <View style={styles.field}>
          <TextInput fullWidth value={value} onChange={setValue} keyboardType="number-pad" testID="trezor-pairing" />
        </View>
      </Modal>
    )
  }

  // 'button' requests are on-device confirmations — nothing to prompt here.
  return null
}
