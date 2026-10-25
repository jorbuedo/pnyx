import {type Href, Redirect, router} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {PnyxPortraitLogo} from '../src/components/illustrations/PnyxPortraitLogo'
import {GradientEffect} from '../src/components/patterns/GradientEffect'
import {useEnclaveUnlock} from '../src/hooks/useEnclaveUnlock'
import {markSessionAuthenticated} from '../src/hooks/useLockScreen'
import {useLegalAgreement} from '../src/legal/useLegalAgreement'
import {logger} from '../src/logger'
import {storage} from '../src/platform/storage'
import {useAuth, usePnyxSession, useWalletCore} from '../src/providers'
import {BiometricFirstLockScreen} from '../src/screens/BiometricFirstLockScreen'
import {readLastHomeTabSync} from '../src/services/last-home-tab'
import {pendingPushIntent} from '../src/services/pending-push-intent'
import {postUnlockLanding} from '../src/services/post-unlock-landing'

export default function RootIndex() {
  const {isReady, isLockEnabled, isUnlocked} = useAuth()
  const {isLoading: isLegalLoading} = useLegalAgreement()
  // Use `allWallets` (cross-group total) and gate on `!isWalletLoading` so a
  // transient state-publication that leaves the selected group momentarily
  // empty can't bounce us to onboarding after a tx-success `router.replace('/')`
  // Same idiom as DashboardScreen.tsx's onboarding redirect.
  const {identityEstablished} = usePnyxSession()
  const {isLoading: isWalletLoading, isReady: isWalletReady} = useWalletCore()
  // The identity wallet (not any funds wallet) is what makes an install
  // "onboarded" — funds wallets are optional imports, so an identity-only
  // install is fully onboarded and an install with funds wallets but no
  // identity is not.
  const hasWallets = identityEstablished === true
  const coldStartLandingLogged = useRef(false)
  const [onboardingChoice, setOnboardingChoice] = useState<'return' | null>()

  useEffect(() => {
    storage.get('@pnyx/init_new_or_return_done').then((choiceValue) => {
      // Only the import choice ('return') resumes into a stable screen; the
      // create paths ('quick' / 'phrase') hold their state in memory, so a
      // cold start mid-flow lands back on the entry screen to re-pick.
      if (choiceValue === 'return') {
        setOnboardingChoice(choiceValue)
      } else {
        setOnboardingChoice(null)
      }
    })
  }, [])

  if (
    !isReady ||
    !isWalletReady ||
    onboardingChoice === undefined ||
    isLegalLoading ||
    isWalletLoading ||
    identityEstablished === undefined
  ) {
    return (
      <GradientEffect style={styles.splash}>
        <PnyxPortraitLogo width={220} variant="light" />
      </GradientEffect>
    )
  }

  if (isLockEnabled && !isUnlocked) {
    return <ColdStartLockScreen />
  }

  // Log routing decision once per render cycle where all state is ready
  logger.debug('RootIndex routing', {
    origin: 'RootIndex',
    hasWallets,
    onboardingChoice,
    isLockEnabled,
    isUnlocked,
  })

  if (!hasWallets) {
    if (onboardingChoice === 'return') {
      return <Redirect href={'/onboarding' as Href} />
    }
    return <Redirect href={'/onboarding/new-or-return' as Href} />
  }

  const pendingIntent = pendingPushIntent.peek()
  const lastHomeTab = readLastHomeTabSync()
  const landing = postUnlockLanding({pendingIntent: pendingIntent ?? null, lastHomeTab})
  // One queryable snapshot of the post-unlock routing decision per mount.
  if (!coldStartLandingLogged.current) {
    coldStartLandingLogged.current = true
    logger.debug('RootIndex post-unlock landing', {
      origin: 'RootIndex',
      pendingIntentKind: pendingIntent?.kind ?? null,
      lastHomeTab,
      landing,
    })
  }
  if (pendingIntent) {
    logger.info(`[root-index] post-unlock redirect → ${landing} (pendingPushIntent=${pendingIntent.kind})`, {
      origin: 'RootIndex',
    })
  }

  return <Redirect href={landing as Href} />
}

function ColdStartLockScreen() {
  const {unlockSession} = useAuth()
  const {unlock} = useEnclaveUnlock()

  const handleSuccess = useCallback(() => {
    unlockSession()
    markSessionAuthenticated()
  }, [unlockSession])

  return (
    <BiometricFirstLockScreen
      onSuccess={handleSuccess}
      onRecovery={() => router.navigate('/(lock)/reset-wallet')}
      unlock={unlock}
      origin="ColdStartLockScreen"
    />
  )
}

const styles = StyleSheet.create(() => ({
  splash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
}))
