/**
 * Onboarding entry screen — single welcome with three setup paths.
 *
 * First screen shown on fresh install (route name kept as `new-or-return`
 * for guard/redirect compatibility). Replaces the old "I'm new / I already
 * have a wallet" split with one picker:
 *
 * 1. **Quick start** — generate the seed silently and go straight to the
 *    enclave-enrollment step; the account is marked not-backed-up and the
 *    profile screen nudges the user to back it up later (settings/backup-verification
 *    is the ceremony's new home).
 * 2. **Import** — restore options (recovery phrase entry, encrypted backup).
 *
 * Tapping any option records ToS acceptance and proceeds to onboarding.
 *
 * Inside the decoy, while the user's own setup is in flight, the welcome copy is
 * replaced with an explanation of what the profile is for and the legal consent
 * block is dropped — consent is device-global and was already given by the real
 * profile, so a second profile on the same device does not re-consent. Both
 * paths (create or restore) stay available.
 *
 * That swap is gated on `shouldExplainDecoySetup`, never on "am I the decoy":
 * copy that explains the decoy must not greet whoever else opens it.
 *
 * @module
 */

import {router, useFocusEffect} from 'expo-router'
import {useCallback, useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ClockLogomark} from '../../src/components/illustrations'
import {OnboardingTile} from '../../src/components/OnboardingTile'
import {RichText} from '../../src/components/RichText'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {Typography} from '../../src/components/Typography'
import {UniIcon} from '../../src/components/UniIcon'
import {useGuardedNavigation} from '../../src/hooks/useGuardedNavigation'
import {useLegalAgreement} from '../../src/legal'
import {logger} from '../../src/logger'
import {storage} from '../../src/platform/storage'
import {useI18n, useOnboarding} from '../../src/providers'
import {getActiveProfile} from '../../src/services/profile/active-profile'
import {isDecoySetupPendingSync, shouldExplainDecoySetup} from '../../src/services/profile/decoy-setup'
import {readSharedIdentityMnemonic} from '../../src/services/profile/share-identity'

export default function OnboardingEntryScreen() {
  const {t} = useI18n()
  const {guard, isNavigating, reset: resetGuard} = useGuardedNavigation()
  const {agree} = useLegalAgreement()
  const {setIsQuickStart, setMnemonic, reset: resetOnboarding} = useOnboarding()
  const [explainDecoy] = useState(() => shouldExplainDecoySetup(getActiveProfile(), isDecoySetupPendingSync()))

  // The guard auto-resets on focus return; this effect additionally clears the
  // previously stored choice (so closing and reopening lands on this screen)
  // and any onboarding state from an abandoned attempt.
  useFocusEffect(
    useCallback(() => {
      resetOnboarding()
      void storage.remove('@pnyx/init_new_or_return_done').catch((e) => {
        logger.warn('Failed to clear the onboarding marker', {origin: 'NewOrReturn', error: String(e)})
      })
    }, [resetOnboarding]),
  )

  /** Shared preamble for both paths: ToS consent + choice persistence. */
  const acceptAndRecord = async (choice: 'quick' | 'return'): Promise<boolean> => {
    // Consent is device-global and already given by the real profile; the decoy
    // is a second profile on the same device, not a second user.
    if (!explainDecoy && !(await agree())) return false
    await storage.set('@pnyx/init_new_or_return_done', choice)
    return true
  }

  const handleQuickStart = () => {
    guard(async () => {
      try {
        if (!(await acceptAndRecord('quick'))) return
        // Seed generation happens silently on /onboarding/preparing —
        // no mnemonic ceremony; the account is marked backup-pending there.
        setIsQuickStart(true)
        // The avatar picker chooses the identity itself, then hands off to the same enclave
        // gate — the device-lock check must still happen before any keychain write.
        router.push('/onboarding/choose-avatar')
      } catch (e) {
        logger.error('Quick Start: failed to start creation', {origin: 'OnboardingEntry', error: String(e)})
        resetGuard()
      }
    })
  }

  const handleImport = () => {
    guard(async () => {
      if (!(await acceptAndRecord('return'))) return
      router.push('/onboarding')
    })
  }

  /**
   * Decoy only: give this profile the *same* identity as the real one, so only
   * the wallets differ. Reuses the ordinary identity path — the seed is put into
   * onboarding context and `preparing` stores it, records it and signs in exactly
   * as it would a fresh one. No avatar picker: the avatar derives from the seed,
   * and a shared identity must look identical.
   */
  const handleReuseIdentity = () => {
    guard(async () => {
      try {
        if (!(await acceptAndRecord('return'))) return
        const mnemonic = await readSharedIdentityMnemonic(t('init.decoySetup.reuseIdentity.authPrompt'))
        setIsQuickStart(false)
        setMnemonic(mnemonic)
        // No name param: the identity run never carries one, and the handle
        // follows `C` on its own.
        router.push('/onboarding/preparing')
      } catch (e) {
        logger.error('Reuse identity: failed', {origin: 'OnboardingEntry', error: String(e)})
        resetGuard()
      }
    })
  }

  const handleTermsPress = () => {
    router.push('/(legal)/terms-of-service')
  }

  const handlePrivacyPress = () => {
    router.push('/(legal)/privacy-policy')
  }

  return (
    <SafeAreaViewWrapper style={styles.safeArea}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Centered welcome group: logo → title → subtitle → tiles → legal */}
        <View style={styles.centerGroup}>
          <View style={styles.logoContainer}>
            <ClockLogomark width={96} />
          </View>

          <Typography variant="headingXl" style={styles.title}>
            {explainDecoy ? t('init.decoySetup.title') : t('init.newOrReturn.title')}
          </Typography>
          <View style={styles.subtitleContainer}>
            <Typography variant="bodyMd_regular" style={styles.subtitle}>
              {explainDecoy ? t('init.decoySetup.subtitle') : t('init.newOrReturn.subtitle')}
            </Typography>
            <Typography variant="bodyMd_regular" style={styles.subtitle}>
              {explainDecoy ? t('init.decoySetup.actions') : t('init.newOrReturn.actions')}
            </Typography>
          </View>

          <View style={styles.tilesContainer}>
            <OnboardingTile
              icon={
                <UniIcon name="tileQuickstart" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />
              }
              title={t('init.newOrReturn.quickStart.title')}
              subtitle={t('init.newOrReturn.quickStart.subtitle')}
              badge={t('init.newOrReturn.quickStart.badge')}
              recommended
              onPress={handleQuickStart}
              isDisabled={isNavigating}
              testID="quick-start-button"
            />
            <OnboardingTile
              icon={
                <UniIcon name="tileImportBackup" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />
              }
              title={t('init.newOrReturn.importAccount.title')}
              subtitle={t('init.newOrReturn.importAccount.subtitle')}
              onPress={handleImport}
              isDisabled={isNavigating}
              testID="import-account-button"
            />
            {/* Decoy only. A decoy carrying a different identity is a giveaway to
                anyone who already knows your handle. */}
            {explainDecoy && (
              <OnboardingTile
                icon={<UniIcon name="lock" size="sm" uniProps={(theme) => ({color: theme.colors.textDefault})} />}
                title={t('init.decoySetup.reuseIdentity.title')}
                subtitle={t('init.decoySetup.reuseIdentity.subtitle')}
                onPress={handleReuseIdentity}
                isDisabled={isNavigating}
                testID="reuse-identity-button"
              />
            )}
          </View>

          {explainDecoy ? (
            <Typography variant="bodyXs_regular" style={styles.consent}>
              {t('init.decoySetup.footnote')}
            </Typography>
          ) : (
            <RichText
              messageId="init.newOrReturn.consent"
              variant="bodyXs_regular"
              style={styles.consent}
              values={{
                terms: (chunks) => (
                  <Typography variant="bodyXs_regular" style={styles.link} onPress={handleTermsPress}>
                    {chunks}
                  </Typography>
                ),
                privacy: (chunks) => (
                  <Typography variant="bodyXs_regular" style={styles.link} onPress={handlePrivacyPress}>
                    {chunks}
                  </Typography>
                ),
              }}
            />
          )}
        </View>
      </ScrollView>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.backgroundDefault,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing24,
    justifyContent: 'center',
  },
  centerGroup: {
    alignItems: 'center',
  },
  logoContainer: {
    marginBottom: theme.spacing.spacing24,
  },
  title: {
    color: theme.colors.textDefault,
    textAlign: 'center',
    marginBottom: theme.spacing.spacing8,
  },
  subtitle: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
  },
  tilesContainer: {
    width: '100%',
    gap: theme.spacing.spacing8,
  },
  consent: {
    color: theme.colors.textMuted,
    textAlign: 'center',
    marginTop: theme.spacing.spacing16,
    maxWidth: 300,
  },
  link: {
    color: theme.colors.textAlternative,
    textDecorationLine: 'underline',
  },
  subtitleContainer: {
    gap: theme.spacing.spacing8,
    marginBottom: theme.spacing.spacing32,
  },
}))
