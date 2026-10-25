/**
 * Preparing-account loader.
 *
 * ⚠️ **Deliberately indeterminate.** This replaced a three-step ladder whose transitions ran off a
 * fixed 2.6-second timeline — windows at 150/900, 1000/1800, 1900/2600 ms — with no connection to
 * the work being done. Its own note conceded the arc could reach "done" while creation was still
 * running, so the ladder was reporting progress it did not have. An honest loader for an
 * indeterminate wait is one that does not claim to know how far along it is.
 *
 * What turns instead is {@link ClockLogomark}: the Pnyx mark resting alternately on its own form and
 * on Midnight's, a second apart. It carries the wait *and* says what the account is being made of,
 * which three lines of ticking copy did not.
 *
 * ⚠️ It turns for as long as the screen is mounted (`cycles={-1}`), so `uiautomator dump` cannot
 * reach an idle state here — see `ClockLogomark`'s `cycles`. Accepted on this screen and nowhere
 * else: it is transient, has no controls to drive, and anything automating onboarding is waiting for
 * the screen *after* it.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {useI18n} from '../../providers'
import {ClockLogomark} from '../illustrations'
import {Typography} from '../Typography'

type Props = {
  /**
   * When false the mark is held still. Defaults to true.
   *
   * Kept from the previous API; nothing sets it today.
   */
  active?: boolean
  /**
   * Copy set: 'identity' on the first run (the identity is being established — no multichain wallet
   * group), 'wallet' for the add-wallet flow (identity/wallet split).
   */
  variant?: 'wallet' | 'identity'
}

export function PreparingAnimation({active = true, variant = 'wallet'}: Props) {
  const {t} = useI18n()

  return (
    <View style={styles.container}>
      <ClockLogomark width={96} cycles={active ? -1 : 0} />
      <View style={styles.textContainer}>
        <Typography variant="headingLg" style={styles.title}>
          {t(
            variant === 'identity'
              ? 'onboarding.preparing.identity.creatingTitle'
              : 'onboarding.preparing.creatingTitle',
          )}
        </Typography>
        <Typography variant="bodyMd_regular" style={styles.subtitle}>
          {t(
            variant === 'identity'
              ? 'onboarding.preparing.identity.creatingSubtitle'
              : 'onboarding.preparing.creatingSubtitle',
          )}
        </Typography>
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.spacing24,
    gap: theme.spacing.spacing24,
  },
  textContainer: {
    alignItems: 'center',
    gap: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing24,
  },
  title: {
    textAlign: 'center',
    color: theme.colors.textDefault,
  },
  subtitle: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
    maxWidth: 320,
  },
}))
