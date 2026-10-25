/**
 * Onboarding step: choose the name people see.
 *
 * **It comes straight after the avatar, because by then the identity exists.** The avatar step is
 * where `C` is chosen — every tile is a complete identity — so this screen is naming the identity
 * that was just picked rather than collecting a field the app will decide what to do with.
 *
 * ⚠️ **This is a nickname, not a registered handle.** Nobody owns it, nothing is unique about it, and
 * two people may pick the same one — there is no registry to ask, for the same reason there is none
 * for handles. Registering it on chain is the `handles` vertical, which the mainnet launch does not
 * ship; when it does, registering is exactly "validate the name you already show", which is why this
 * screen runs the *same* `validateHandle` rather than a looser rule of its own. A name accepted here
 * can always be registered later.
 *
 * **Skippable, and the write is not awaited.** A name goes to the row with `setPrimaryName`, which
 * needs the identity shell deployed and a sponsored relay — none of which belongs between a new user
 * and the app. So the choice is recorded and `nickname-flush` completes it once a session exists.
 * Pressing Continue therefore never fails here, and never spins.
 *
 * @module
 */

import {validateHandle} from '@pnyx/contract-client/handle'
import {useCallback, useMemo, useState} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {TextInput} from '../../src/components/TextInput'
import {Typography} from '../../src/components/Typography'
import {useOnboardingAuthNavigation} from '../../src/hooks/useOnboardingAuthNavigation'
import {logger} from '../../src/logger'
import {useI18n} from '../../src/providers'
import {REJECTION_KEY} from '../../src/services/handle-rejection-key'
import {writePendingNickname} from '../../src/services/nickname-pending'

const ORIGIN = 'choose-name'

export default function ChooseNameScreen() {
  const {t} = useI18n()
  const {navigateToAuthSetup} = useOnboardingAuthNavigation()
  const [typed, setTyped] = useState('')
  const [continuing, setContinuing] = useState(false)

  const trimmed = typed.trim()
  // An empty field is the skip case, not a refusal: showing "too short" before anything is typed
  // tells someone off for not having started.
  const checked = useMemo(() => (trimmed === '' ? undefined : validateHandle(typed)), [typed, trimmed])
  const rejection = checked !== undefined && !checked.ok ? checked.reason : undefined

  const proceed = useCallback(
    (nickname: string | undefined) => {
      if (continuing) return
      // Set before the work so the press registers on the frame it happened; the guard is the other
      // half, since a disabled-looking button still takes a second tap.
      setContinuing(true)
      if (nickname !== undefined) {
        // Deliberately not awaited: the row write happens later, and onboarding must not wait on
        // storage either. A failure to record is logged inside and costs the retry, not the step.
        void writePendingNickname(nickname)
      } else {
        logger.info('onboarding skipped the nickname step', {origin: ORIGIN})
      }
      void navigateToAuthSetup('push', '/onboarding/preparing').finally(() => setContinuing(false))
    },
    [continuing, navigateToAuthSetup],
  )

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      style={styles.safeArea}
      contentContainerStyle={styles.scrollContent}
      stickyFooter={
        <StickyFooter>
          <Button
            // Carries the biometrics action now that it has moved off the avatar step: this is the
            // last tap before the enclave ceremony in `preparing`.
            label={t('onboarding.secureWithBiometrics.continueButton')}
            onPress={() => checked?.ok === true && proceed(checked.display)}
            isLoading={continuing}
            isDisabled={checked === undefined || !checked.ok || continuing}
            size="xl"
            fullWidth
            testID="onboarding-nickname-continue"
          />
          <Button
            label={t('onboarding.chooseName.skip')}
            onPress={() => proceed(undefined)}
            isDisabled={continuing}
            variant="nakedDefault"
            size="xl"
            fullWidth
            testID="onboarding-nickname-skip"
          />
        </StickyFooter>
      }
    >
      <Typography variant="bodyMd_regular" style={styles.subtitle}>
        {t('onboarding.chooseName.subtitle')}
      </Typography>
      <TextInput
        value={typed}
        onChange={setTyped}
        fullWidth
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder={t('onboarding.chooseName.placeholder')}
        isError={rejection !== undefined}
        message={rejection !== undefined ? t(REJECTION_KEY[rejection]) : t('onboarding.chooseName.hint')}
        testID="onboarding-nickname-input"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing20,
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  subtitle: {textAlign: 'center', color: theme.colors.textAlternative},
}))
