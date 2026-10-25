/**
 * A name claim, visible from wherever you are.
 *
 * ⚠️ **Rendered above the tabs on purpose.** A claim takes around a hundred seconds and can fail at
 * its last step; before this it was a `busy` boolean inside one screen's hook, so walking away from
 * the claim screen left nothing on screen at all and the failure arrived as a toast that had gone by
 * the time anyone looked.
 *
 * @module
 */

import {ActivityIndicator, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useClaimProgress} from '../hooks/useClaimProgress'
import {useI18n} from '../providers'
import {type ClaimProgress, clearClaim} from '../services/handle-claim-progress'
import {Typography} from './Typography'

/** One key per phase, so the copy can say what is actually happening rather than "please wait". */
const PHASE_KEY = {
  shell: 'you.handle.progress.shell',
  'awaiting-shell': 'you.handle.progress.awaitingShell',
  permit: 'you.handle.progress.permit',
  'awaiting-permit': 'you.handle.progress.awaitingPermit',
  bind: 'you.handle.progress.bind',
  relaying: 'you.handle.progress.relaying',
  'awaiting-row': 'you.handle.progress.awaitingRow',
} as const

export function ClaimProgressBanner() {
  const progress = useClaimProgress()
  // The variant hook must run on every render, so the nothing-to-show case is a separate component
  // rather than an early return above it.
  styles.useVariants({
    state: progress?.outcome === undefined ? 'running' : progress.outcome.kind === 'failed' ? 'failed' : 'done',
  })
  if (progress === undefined) return null
  return <ClaimBanner progress={progress} />
}

function ClaimBanner({progress}: {readonly progress: ClaimProgress}) {
  const {t} = useI18n()
  const failed = progress.outcome?.kind === 'failed'
  const done = progress.outcome !== undefined

  return (
    <Pressable
      style={styles.banner}
      onPress={() => clearClaim()}
      // Only a finished claim can be dismissed, so a running one is not offered as a button.
      disabled={!done}
      accessibilityRole={done ? 'button' : undefined}
      testID="claim-progress-banner"
    >
      {!done && <ActivityIndicator size="small" />}
      <View style={styles.text}>
        <Typography variant="bodySm_medium" numberOfLines={1}>
          {failed
            ? t('you.handle.progress.failedTitle', {name: progress.name})
            : done
              ? t('you.handle.progress.doneTitle', {name: progress.name})
              : t('you.handle.progress.title', {name: progress.name})}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.detail} numberOfLines={2}>
          {progress.outcome?.kind === 'failed'
            ? t(progress.outcome.reasonKey as 'you.handle.pending')
            : done
              ? t('you.handle.progress.doneDetail')
              : t(PHASE_KEY[progress.phase])}
        </Typography>
      </View>
      {done && (
        <Typography variant="bodyXs_medium" style={styles.dismiss}>
          {t('common.dismiss')}
        </Typography>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
    variants: {
      state: {
        running: {backgroundColor: theme.colors.backgroundAlternative},
        done: {backgroundColor: theme.colors.backgroundAlternative},
        failed: {backgroundColor: theme.colors.backgroundAlternative, borderBottomColor: theme.colors.errorDefault},
      },
    },
  },
  text: {flex: 1, gap: theme.spacing.spacing4},
  detail: {color: theme.colors.textAlternative},
  dismiss: {color: theme.colors.primaryDefault},
}))
