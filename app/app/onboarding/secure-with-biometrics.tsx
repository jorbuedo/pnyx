/**
 * Onboarding step: enclave enrollment explainer, plus a wallet name on the add-wallet run.
 *
 * The **identity** run collects no name: it is chosen by avatar on `choose-avatar`, and an Pnyx
 * identity is its `pnyx_id` rather than a label. A funds wallet still needs a name, because wallet
 * groups are listed and switched between by name.
 *
 * Shown after mnemonic creation/restore. The wallet seed always goes
 * into the enclave vault (OS keychain, `BIOMETRY_ANY_OR_DEVICE_PASSCODE`)
 * — there is no password or PIN alternative. This screen collects the
 * wallet name; Continue navigates straight to `preparing`, where the
 * enclave key ceremony (keychain write) fires the single OS
 * authentication prompt of the creation flow. A rehearsal prompt here
 * would make it two prompts back-to-back for no security gain — devices
 * without any screen-lock credential never reach this screen (the
 * `navigateToAuthSetup` gate routes them to `device-lock-required`,
 * which needs no prompt).
 *
 * @module
 */

import {router} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {protoInputStyle, protoInputTextStyle} from '../../src/components/onboarding/protoForm'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {TextInput} from '../../src/components/TextInput'
import {Typography} from '../../src/components/Typography'
import {useExistingWalletPrefill} from '../../src/hooks/useExistingWalletPrefill'
import {useBiometricMethodsLabel} from '../../src/i18n/biometric-methods'
import {useI18n, useOnboarding, usePnyxSession, useWalletList} from '../../src/providers'
import {generateAutoWalletName, MAX_WALLET_NAME_LENGTH} from '../../src/utils/auto-wallet-name'

export default function SecureWithBiometricsRoute() {
  const {t} = useI18n()
  const biometricMethods = useBiometricMethodsLabel()
  const {proposedWalletName} = useOnboarding()
  const {walletGroups} = useWalletList()
  // First run establishes the Pnyx identity (identity/wallet split) — the
  // copy names an identity, not a wallet. With an identity present this is
  // the add-wallet flow and keeps account wording.
  const {identityEstablished} = usePnyxSession()
  const isIdentityRun = identityEstablished !== true

  const [initialName] = useState(
    () => proposedWalletName?.trim() || generateAutoWalletName(walletGroups.map((g) => g.name)),
  )
  const [walletName, setWalletName] = useState(initialName)
  const userEditedNameRef = useRef(false)
  const handleWalletNameChange = useCallback((value: string) => {
    userEditedNameRef.current = true
    setWalletName(value)
  }, [])

  const {matchedName} = useExistingWalletPrefill()
  // Apply the prefill in an effect rather than synchronously during
  // render — avoids the extra commit a setState-during-render pattern
  // would cost on every re-render that still satisfies the condition.
  useEffect(() => {
    if (matchedName && !userEditedNameRef.current) setWalletName(matchedName)
  }, [matchedName])

  // What follows this tap is the enclave key ceremony on `preparing`, and mounting it is not free.
  // Marking the button on press means the press is acknowledged on its own frame instead of when
  // the next screen finally appears. Never cleared: `replace` takes this screen with it.
  const [continuing, setContinuing] = useState(false)
  const handleContinue = useCallback(() => {
    if (continuing) return
    setContinuing(true)
    if (isIdentityRun) {
      router.replace({pathname: '/onboarding/preparing'})
      return
    }
    const finalName = walletName.trim() || initialName
    router.replace({pathname: '/onboarding/preparing', params: {name: finalName}})
  }, [walletName, initialName, isIdentityRun, continuing])

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      style={styles.safeArea}
      contentContainerStyle={styles.scrollContent}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('onboarding.secureWithBiometrics.continueButton')}
            onPress={handleContinue}
            isLoading={continuing}
            isDisabled={continuing}
            size="xl"
            fullWidth
            testID="secure-with-biometrics-button"
          />
        </StickyFooter>
      }
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Typography variant="bodyMd_regular" style={styles.subtitle}>
            {t(
              isIdentityRun
                ? 'onboarding.secureWithBiometrics.identity.subtitle'
                : 'onboarding.secureWithBiometrics.subtitle',
              {methods: biometricMethods},
            )}
          </Typography>
          {/* Identity run only: passkey recovery backs up the *account*, which the add-wallet run
              already has. */}
          {isIdentityRun ? (
            <Typography variant="bodyMd_regular" style={styles.subtitle}>
              {t('onboarding.secureWithBiometrics.identity.passkeyHint')}
            </Typography>
          ) : null}
        </View>

        {!isIdentityRun && (
          <View style={styles.field}>
            <Typography variant="bodySm_regular" style={styles.fieldLabel}>
              {t('onboarding.secureWallet.walletNameLabel')}
            </Typography>
            <TextInput
              value={walletName}
              onChange={handleWalletNameChange}
              placeholder={initialName}
              maxLength={MAX_WALLET_NAME_LENGTH}
              inputContainerStyle={protoInputStyle}
              inputStyle={protoInputTextStyle}
              fullWidth
              testID="wallet-name-input"
            />
            <Typography variant="bodyXs_regular" style={styles.fieldHelper}>
              {t('onboarding.secureWallet.walletNameHelper')}
            </Typography>
          </View>
        )}
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing24,
  },
  container: {
    flex: 1,
    gap: theme.spacing.spacing24,
  },
  header: {
    gap: theme.spacing.spacing8,
  },
  subtitle: {
    color: theme.colors.textAlternative,
  },
  field: {
    gap: theme.spacing.spacing6,
  },
  fieldLabel: {
    color: theme.colors.textAlternative,
  },
  fieldHelper: {
    color: theme.colors.textMuted,
  },
}))
