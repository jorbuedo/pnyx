/**
 * Onboarding layout with stack navigation.
 *
 * Provides navigation stack for the account setup flow:
 * - new-or-return: Entry — quick start / seed phrase / import picker
 * - index: Import picker (recovery phrase / encrypted backup)
 * - create: Show recovery phrase
 * - verify: Verify recovery phrase
 * - restore: Enter recovery phrase to restore
 * - restore-with-passkey: Restore via passkey-PRF recovery blob
 * - choose-avatar: Pick the identity (its avatar) — replaces the identity-name field
 * - secure-with-biometrics: Enclave enrollment (wallet name on add-wallet + OS auth)
 * - device-lock-required: Blocking explainer when no device lock exists
 * - preparing: Sync wallet after creation/restore
 *
 * @module
 */

import {router, Stack, usePathname} from 'expo-router'
import {type ReactNode, useCallback, useEffect, useState} from 'react'

import {HeaderBackButton} from '../../src/components/HeaderBackButton'
import {ThemedOnboardingStack} from '../../src/components/ThemedStack'
import {logger} from '../../src/logger'
import {storage} from '../../src/platform/storage'
import {OnboardingProvider, useI18n, usePnyxSession, useWalletCore, useWalletList} from '../../src/providers'
import {getActiveProfile} from '../../src/services/profile/active-profile'
import {isDecoySetupPendingSync, shouldExplainDecoySetup} from '../../src/services/profile/decoy-setup'

function OnboardingInitGuard({
  children,
  hasWallets,
  identityEstablished,
}: {
  children: ReactNode
  hasWallets: boolean
  identityEstablished: boolean
}) {
  const pathname = usePathname()
  const [isReady, setIsReady] = useState(false)
  const {isReady: isWalletReady} = useWalletCore()

  useEffect(() => {
    // Only enforce the guard for onboarding routes — ignore unrelated pathnames
    // (e.g., when a modal like (legal)/terms-of-service opens on top)
    if (!pathname.startsWith('/onboarding')) return
    if (!isWalletReady) return

    let cancelled = false

    void (async () => {
      const newOrReturnDone = await storage.get('@pnyx/init_new_or_return_done')

      if (cancelled) return

      // Allow access to new-or-return without the flag (it's the entry point)
      const isNewOrReturn = pathname === '/onboarding/new-or-return'
      // Encrypted-backup deep links can land a brand-new user directly here
      // without first going through new-or-return — clicking the link IS the
      // user signalling intent, equivalent to "I'm returning".
      const isRestoreFromBackup = pathname === '/onboarding/restore-from-backup'
      // 'quick' / 'return' are the entry-screen choices; 'phrase' and 'new' are
      // legacy values from earlier flows, still accepted for in-flight installs.
      const hasEntryChoice =
        newOrReturnDone === 'quick' ||
        newOrReturnDone === 'phrase' ||
        newOrReturnDone === 'return' ||
        newOrReturnDone === 'new'
      // Users who already have wallets (or an established identity) are past
      // first-run — skip the new-or-return gate. identityEstablished is what keeps a re-entry after
      // an identity-only first run from bouncing back to new-or-return (identity creation leaves 0
      // funds wallets, so hasWallets alone is false).
      const canEnterOnboarding =
        hasEntryChoice || isNewOrReturn || isRestoreFromBackup || hasWallets || identityEstablished

      logger.info('Checked onboarding init gate', {
        origin: 'OnboardingLayout',
        pathname,
        newOrReturnDone,
        hasWallets,
        canEnterOnboarding,
      })

      if (!canEnterOnboarding) {
        router.replace('/onboarding/new-or-return')
        return
      }

      setIsReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [pathname, hasWallets, identityEstablished, isWalletReady])

  if (!isReady) return null

  return <>{children}</>
}

export default function OnboardingLayout() {
  const {t} = useI18n()
  const {wallets} = useWalletList()
  const {identityEstablished} = usePnyxSession()
  // Frozen once *known*, not at mount. The first-run pass flips identityEstablished mid-flow (the
  // identity slot fills on `preparing`) and the header must not swap wording inside a run — but the
  // slot is an async keychain probe that reads `undefined` on the first render, and freezing
  // `undefined !== true` made **every** run an identity run. That is how an add-wallet restore came
  // to be headed "Creating identity" while the screen body underneath it said "account".
  const [isIdentityRun, setIsIdentityRun] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (identityEstablished === undefined) return
    setIsIdentityRun((current) => current ?? identityEstablished !== true)
  }, [identityEstablished])

  /** Back handler for onboarding entry screens (index, new-user). */
  const handleOnboardingBack = useCallback(() => {
    if (wallets.length > 0 || identityEstablished === true) {
      if (router.canGoBack()) {
        router.back()
      } else {
        router.replace('/community')
      }
    } else {
      router.replace('/onboarding/new-or-return')
    }
  }, [wallets.length, identityEstablished])

  return (
    <OnboardingInitGuard hasWallets={wallets.length > 0} identityEstablished={identityEstablished === true}>
      <OnboardingProvider>
        <ThemedOnboardingStack>
          <Stack.Screen
            name="new-or-return"
            options={{
              title: shouldExplainDecoySetup(getActiveProfile(), isDecoySetupPendingSync())
                ? t('init.decoySetup.headerTitle')
                : t('init.newOrReturn.headerTitle'),
              headerShown: true,
              headerBackVisible: false,
              headerLeft: () => null,
            }}
          />
          <Stack.Screen
            name="index"
            options={{
              title: t('onboarding.nav.setupWallet'),
              headerShown: true,
              headerBackVisible: false,
              headerLeft: () => <HeaderBackButton onBack={handleOnboardingBack} />,
            }}
          />
          <Stack.Screen
            name="add-wallet"
            options={{
              title: t('onboarding.addWallet.headerTitle'),
            }}
          />
          <Stack.Screen
            name="restore"
            options={{
              title: t('onboarding.nav.restoreWallet'),
            }}
          />
          <Stack.Screen
            name="restore-from-backup"
            options={{
              title: t('onboarding.nav.importBackup'),
            }}
          />
          <Stack.Screen
            name="restore-with-passkey"
            options={{
              title: t('passkeyRecovery.restore.title'),
            }}
          />
          <Stack.Screen
            name="preparing"
            options={{
              title: t(
                isIdentityRun === true
                  ? 'onboarding.preparing.identity.headerTitle'
                  : 'onboarding.preparing.headerTitle',
              ),
              headerBackVisible: false,
              headerLeft: () => null,
              gestureEnabled: false,
            }}
          />
          <Stack.Screen name="watch-only" options={{title: t('onboarding.watchOnly.headerTitle')}} />
          <Stack.Screen name="choose-avatar" options={{title: t('onboarding.chooseAvatar.headerTitle')}} />
          <Stack.Screen name="choose-name" options={{title: t('onboarding.chooseName.headerTitle')}} />
          <Stack.Screen
            name="secure-with-biometrics"
            options={{
              title: t(
                isIdentityRun === true
                  ? 'onboarding.secureWithBiometrics.identity.headerTitle'
                  : 'onboarding.secureWithBiometrics.headerTitle',
              ),
            }}
          />
          <Stack.Screen
            name="device-lock-required"
            options={{
              title: t('onboarding.deviceLockRequired.headerTitle'),
              headerBackVisible: false,
              headerLeft: () => null,
              gestureEnabled: false,
            }}
          />
        </ThemedOnboardingStack>
      </OnboardingProvider>
    </OnboardingInitGuard>
  )
}
