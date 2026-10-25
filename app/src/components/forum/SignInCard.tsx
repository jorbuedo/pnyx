/**
 * Sign-in gate card for the forum surfaces. Triggers the enclave-gated SIWM
 * flow and renders each failure bucket with distinct copy (service unreachable
 * vs sign-in rejected vs wallet unlock failed).
 *
 * ⚠️ **`compact` is a strip, not a gate.** Same action, same failure copy, one row — for a surface
 * that has real content to show without a session and must not bury it behind a card. The retry a
 * signed-out surface needs *is* this button, so the variant is a prop rather than a second component
 * that would drift from the failure buckets above.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n, usePnyxSession} from '../../providers'
import type {SignInFailure} from '../../services/pnyx-session'
import {Button} from '../Buttons'
import {Card} from '../Card'
import {Typography} from '../Typography'

const ERROR_KEY: Record<
  SignInFailure,
  | 'forum.signIn.errorUnreachable'
  | 'forum.signIn.errorMisconfigured'
  | 'forum.signIn.errorRejected'
  | 'forum.signIn.errorWallet'
  | 'forum.signIn.errorUnknown'
> = {
  unreachable: 'forum.signIn.errorUnreachable',
  misconfigured: 'forum.signIn.errorMisconfigured',
  rejected: 'forum.signIn.errorRejected',
  wallet: 'forum.signIn.errorWallet',
  unknown: 'forum.signIn.errorUnknown',
}

export function SignInCard({
  testID,
  compact = false,
  message,
}: {
  testID?: string
  /** One row — copy and the sign-in button — for a surface that stays usable while signed out. */
  compact?: boolean
  /** What the compact strip says when sign-in has not failed; the failure copy always wins. */
  message?: string
}) {
  const {t} = useI18n()
  const {signIn, isSigningIn, signInError} = usePnyxSession()

  if (compact) {
    return (
      <View style={styles.compact} testID={testID}>
        <View style={styles.compactText}>
          <Typography
            variant="bodyXs_regular"
            style={signInError === undefined ? styles.body : styles.error}
            numberOfLines={2}
            testID={signInError !== undefined && testID !== undefined ? `${testID}-error` : undefined}
          >
            {signInError === undefined ? (message ?? t('forum.signIn.body')) : t(ERROR_KEY[signInError])}
          </Typography>
        </View>
        <Button
          label={t('forum.signIn.button')}
          variant="secondary"
          size="sm"
          onPress={() => void signIn()}
          isLoading={isSigningIn}
          testID={testID ? `${testID}-button` : undefined}
        />
      </View>
    )
  }

  return (
    <Card variant="outlined" style={styles.card} testID={testID}>
      <View style={styles.content}>
        <Typography variant="bodyLg_medium">{t('forum.signIn.title')}</Typography>
        <Typography variant="bodySm_regular" style={styles.body}>
          {t('forum.signIn.body')}
        </Typography>
        {signInError !== undefined && (
          <Typography variant="bodySm_regular" style={styles.error} testID={testID ? `${testID}-error` : undefined}>
            {t(ERROR_KEY[signInError])}
          </Typography>
        )}
        <Button
          label={t('forum.signIn.button')}
          onPress={() => void signIn()}
          isLoading={isSigningIn}
          fullWidth
          testID={testID ? `${testID}-button` : undefined}
        />
      </View>
    </Card>
  )
}

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing.spacing16,
  },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing12,
  },
  compactText: {
    flex: 1,
  },
  content: {
    gap: theme.spacing.spacing8,
  },
  body: {
    color: theme.colors.textAlternative,
  },
  error: {
    color: theme.colors.errorDefault,
  },
}))
