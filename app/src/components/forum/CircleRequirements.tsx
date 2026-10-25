/**
 * What a gated community asks of a wallet, in words.
 *
 * One implementation because it is asked in two places for two different reasons: the community
 * panel answers *"is this worth trying?"* before the join sheet is ever opened, and the sheet
 * answers *"which of my wallets do I prove it with?"* — the second needs the rules beside the
 * picker, so this is shown twice rather than moved.
 *
 * ⚠️ **Any one of these admits** (`accountSatisfiesAny`), and the subtitle says so. Read as a
 * checklist it would send someone off to satisfy all of them.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import type {TranslationKey} from '../../i18n/types'
import {useI18n} from '../../providers'
import {type RequirementLine, requirementLines} from '../../services/circle-invite-eligibility'
import type {InviteRule} from '../../services/pnyx-api'
import {ChamferSurface} from '../Chamfer'
import {Typography} from '../Typography'

export type CircleRequirementsProps = {
  /** The circle's rule set. `null` is "no self-service path", which renders nothing. */
  readonly rules: readonly InviteRule[] | null | undefined
  readonly testID?: string
}

export function CircleRequirements({rules, testID}: CircleRequirementsProps) {
  const {t} = useI18n()
  if (rules === undefined || rules === null || rules.length === 0) return null

  return (
    <View style={styles.section} testID={testID}>
      <Typography variant="bodySm_medium">{t('forum.join.requirementsTitle')}</Typography>
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('forum.join.requirementsAnyOf')}
      </Typography>
      {requirementLines(rules).map((line, index) => (
        <ChamferSurface
          // Rules are a set with at most one row per kind, so the kind is a stable key — except for
          // `unknown`, where the raw name is what distinguishes two of them.
          key={line.kind === 'unknown' ? `unknown-${line.raw}` : line.kind}
          size="auto"
          fillToken="backgroundAlternative"
          style={styles.requirement}
          testID={`invite-requirement-${index}`}
        >
          <Typography variant="bodySm_regular">{requirementText(line, t)}</Typography>
        </ChamferSurface>
      ))}
    </View>
  )
}

/** One requirement, in words. The ids are shown in full: a person has to compare them to their own. */
const requirementText = (
  line: RequirementLine,
  t: (key: TranslationKey, values?: Record<string, string>) => string,
) => {
  switch (line.kind) {
    case 'drep-delegated':
      return t('forum.join.requirementDrep', {drepId: line.drepId})
    case 'pool-member':
      return t('forum.join.requirementPool', {poolId: line.poolId})
    case 'ada-threshold':
      return t('forum.join.requirementAda', {ada: line.ada})
    case 'unknown':
      // A rule this build does not know, shown rather than dropped — a shorter list of requirements
      // than the community actually has is how somebody picks a wallet against the wrong rules.
      return t('forum.join.requirementUnknown', {kind: line.raw})
  }
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing.spacing8,
  },
  hint: {
    color: theme.colors.textMuted,
  },
  requirement: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
  },
}))
