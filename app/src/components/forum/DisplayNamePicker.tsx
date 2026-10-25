/**
 * "Appear as" picker used when creating or joining a community: your Pnyx identity
 * (disclosed — the same `pnyx_id` everywhere) or a per-community display name that
 * other communities can't link back.
 *
 * **The preview must be the identifier the server will actually record.** Disclosed members are
 * stored under the JWT subject, which is the `pnyx_id` (`docs/PNYX_IDENTITY_PLAN.md`) — this used
 * to show the Midnight *wallet* address, so the one screen where a user decides whether to disclose
 * was naming the wrong thing.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../../providers'
import {formatAuthor} from '../../services/pnyx-forum'
import {ChamferBackground} from '../Chamfer'
import {RadioMark} from '../RadioMark'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'

export type DisplayNameChoice = {
  readonly mode: 'wallet' | 'custom'
  readonly name: string
}

/** The `persona` request field for a choice — undefined = disclosed wallet identity. */
export const personaFromChoice = (choice: DisplayNameChoice): string | undefined =>
  choice.mode === 'custom' && choice.name.trim().length > 0 ? choice.name.trim() : undefined

/** A choice is submittable when disclosed, or when a custom name is non-empty. */
export const isChoiceValid = (choice: DisplayNameChoice): boolean =>
  choice.mode === 'wallet' || choice.name.trim().length > 0

type OptionProps = {
  readonly selected: boolean
  readonly title: string
  readonly description: string
  readonly onSelect: () => void
  readonly testID?: string | undefined
  readonly children?: React.ReactNode
}

function Option({selected, title, description, onSelect, testID, children}: OptionProps) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{selected}} onPress={onSelect} testID={testID}>
      <View style={styles.option}>
        <ChamferBackground
          size="auto"
          borderToken={selected ? 'primaryDefault' : 'borderDefaultWeak'}
          borderWidth={1}
        />
        <View style={styles.optionHeader}>
          <RadioMark selected={selected} />
          <Typography variant="bodyMd_medium">{title}</Typography>
        </View>
        <Typography variant="bodySm_regular" style={styles.optionDescription}>
          {description}
        </Typography>
        {children}
      </View>
    </Pressable>
  )
}

export type DisplayNamePickerProps = {
  readonly choice: DisplayNameChoice
  readonly onChange: (choice: DisplayNameChoice) => void
  /**
   * The `pnyx_id` that disclosing would publish, shown truncated. Optional because a session
   * without one cannot disclose at all — the option is then withheld rather than previewed against
   * a placeholder.
   */
  readonly identity?: string | undefined
  readonly testID?: string | undefined
}

export function DisplayNamePicker({choice, onChange, identity, testID}: DisplayNamePickerProps) {
  const {t} = useI18n()
  return (
    <View style={styles.container} testID={testID}>
      <Typography variant="bodySm_medium" style={styles.sectionLabel}>
        {t('forum.displayName.label')}
      </Typography>
      {identity !== undefined && (
        <Option
          selected={choice.mode === 'wallet'}
          title={t('forum.displayName.wallet')}
          description={t('forum.displayName.walletDescription', {identity: formatAuthor(identity)})}
          onSelect={() => onChange({...choice, mode: 'wallet'})}
          testID={testID ? `${testID}-wallet` : undefined}
        />
      )}
      <Option
        selected={choice.mode === 'custom'}
        title={t('forum.displayName.custom')}
        description={t('forum.displayName.customDescription')}
        onSelect={() => onChange({...choice, mode: 'custom'})}
        testID={testID ? `${testID}-custom` : undefined}
      >
        {choice.mode === 'custom' && (
          <TextInput
            value={choice.name}
            onChange={(name) => onChange({mode: 'custom', name})}
            placeholder={t('forum.displayName.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            fullWidth
            testID={testID ? `${testID}-input` : undefined}
          />
        )}
      </Option>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing.spacing8,
  },
  sectionLabel: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  option: {
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing12,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  optionDescription: {
    color: theme.colors.textAlternative,
  },
}))
