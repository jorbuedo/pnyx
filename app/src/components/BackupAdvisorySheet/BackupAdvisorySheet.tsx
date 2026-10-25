/**
 * BackupAdvisorySheet — the interstitial shown when someone activates a wallet that has no backup.
 *
 * ⚠️ **It answers a tap, not a screen visit.** It used to open by itself when the Wallet Selection
 * screen was focused, once per session, about whichever wallet it found first — so it could talk
 * about a wallet the user had not touched, and a session flag existed to stop it nagging. Now the
 * card the user pressed decides what it says, and both buttons carry that tap forward, so there is
 * nothing to suppress.
 *
 * Presentational: the screen owns activation and navigation, because "activate, then open the backup
 * flow" is a sequence only the caller can order correctly.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import {Button} from '../Buttons'
import {ChamferBackground} from '../Chamfer'
import {Modal} from '../Modal'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'

export type BackupAdvisorySheetProps = {
  /** The wallet the user pressed. `null` keeps the sheet closed. */
  walletName: string | null
  /**
   * Abandoned — backdrop or drag.
   *
   * ⚠️ Not the same as "Later": pressing a button is consent to the switch, swiping a sheet away is
   * changing your mind, and silently activating another wallet on a dismiss would be the second.
   */
  onDismiss: () => void
  /** "Later" — carry out what was tapped, backup untouched. */
  onLater: () => void
  /** "Back up now" — carry it out, then open the backup flow. */
  onBackUpNow: () => void
}

export function BackupAdvisorySheet({walletName, onDismiss, onLater, onBackUpNow}: BackupAdvisorySheetProps) {
  const {t} = useI18n()

  return (
    <Modal position="bottom" visible={walletName !== null} onClose={onDismiss} showDragIndicator>
      <View style={styles.body}>
        {/* Shield icon */}
        <View style={styles.iconMark}>
          <ChamferBackground size="auto" fillToken="errorMuted" borderToken="errorBorder" borderWidth={1} />
          <UniIcon name="securityWarning" size="lg" uniProps={(theme) => ({color: theme.colors.errorDefault})} />
        </View>

        {/* Title */}
        <Typography variant="headingSm" style={styles.title}>
          {t('walletSelection.backupAdvisory.title')}
        </Typography>

        {/* Description */}
        <Typography variant="bodyMd_regular" style={styles.description}>
          {t('walletSelection.backupAdvisory.descriptionStart')}
          <Typography variant="bodyMd_bold" style={styles.description}>
            {' '}
            {walletName ?? ''}{' '}
          </Typography>
          {t('walletSelection.backupAdvisory.descriptionEnd')}
        </Typography>

        {/* Buttons */}
        <View style={styles.btnRow}>
          <View style={styles.btnWrap}>
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              label={t('walletSelection.backupAdvisory.later')}
              onPress={onLater}
              testID="backup-advisory-later"
            />
          </View>
          <View style={styles.btnWrap}>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              label={t('walletSelection.backupAdvisory.backUpNow')}
              onPress={onBackUpNow}
              testID="backup-advisory-back-up-now"
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create(({colors, spacing}) => ({
  body: {
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingBottom: spacing.spacing8,
  },
  iconMark: {
    width: 64,
    height: 64,
    marginTop: spacing.spacing16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.spacing4,
  },
  title: {
    textAlign: 'center',
  },
  description: {
    color: colors.textDefault,
  },
  btnRow: {
    flexDirection: 'row',
    gap: spacing.spacing12,
    marginTop: spacing.spacing8,
    width: '100%',
  },
  btnWrap: {
    flex: 1,
  },
}))
