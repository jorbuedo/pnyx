/**
 * On-chain mirror status badge for communities, memberships, polls, and votes.
 * Absent chain ref = chain mirroring disabled (pure content-plane mode) — renders
 * nothing. Ported from the legacy forum prototype onto the shell's theme/i18n.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import type {ChainRef} from '../../services/pnyx-api'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {chainBadgeState} from './chain-badge-state'

const BADGE_BORDER_COLOR = {
  pending: 'borderDefaultWeak',
  confirmed: 'successDefault',
  failed: 'errorDefault',
  outdated: 'errorDefault',
} as const

const LABEL_KEY = {
  pending: 'forum.chain.pending',
  confirmed: 'forum.chain.confirmed',
  failed: 'forum.chain.failed',
  outdated: 'forum.chain.outdated',
} as const

export type ChainBadgeProps = {
  readonly chain?: ChainRef | null | undefined
  /** Optional label prefix, e.g. the "Your vote" badge on a poll. */
  readonly prefix?: string | undefined
  /**
   * Makes the badge itself the affordance — a failed settlement is where the user already looks, so
   * the retry lives on the tag rather than as a second control beside it. Threaded with its own
   * accessibility label because the visible text says the state, not the action.
   */
  /**
   * Overrides a settled state when the contract is from an older compile.
   *
   * ⚠️ Only `'outdated'` changes anything: `'unknown'` means the service has not resolved the digest,
   * which is not evidence the template matches and must not be rendered as reassurance — but neither
   * is it a problem to announce. It renders as whatever the chain status already said.
   */
  readonly template?: 'current' | 'outdated' | 'unknown' | undefined
  readonly onPress?: (() => void) | undefined
  readonly pressLabel?: string | undefined
  readonly testID?: string | undefined
}

export function ChainBadge({chain, prefix, template, onPress, pressLabel, testID}: ChainBadgeProps) {
  const {t} = useI18n()
  const state = chainBadgeState({status: chain?.status, template})
  styles.useVariants({status: state ?? 'pending'})
  if (!chain || state === undefined) return null
  const label = t(LABEL_KEY[state])
  const body = (
    <>
      <ChamferBackground size="auto" borderToken={BADGE_BORDER_COLOR[state]} borderWidth={1} />
      <View style={styles.dot} />
      <Typography variant="bodyXs_medium" style={styles.label} numberOfLines={1}>
        {prefix === undefined ? label : `${prefix} · ${label}`}
      </Typography>
    </>
  )
  if (onPress === undefined) {
    return (
      <View style={styles.badge} testID={testID}>
        {body}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pressLabel}
      hitSlop={8}
      style={styles.badge}
      testID={testID}
    >
      {body}
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing4,
    alignSelf: 'flex-start',
    paddingHorizontal: theme.spacing.spacing8,
    paddingVertical: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.roundedCircle,
    variants: {
      status: {
        pending: {backgroundColor: theme.colors.textMuted},
        confirmed: {backgroundColor: theme.colors.successDefault},
        failed: {backgroundColor: theme.colors.errorDefault},
        outdated: {backgroundColor: theme.colors.errorDefault},
      },
    },
  },
  label: {
    variants: {
      status: {
        pending: {color: theme.colors.textMuted},
        confirmed: {color: theme.colors.successDefault},
        failed: {color: theme.colors.errorDefault},
      },
    },
  },
}))
