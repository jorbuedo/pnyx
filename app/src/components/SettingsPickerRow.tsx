/**
 * SettingsPickerRow — single-select row for Preferences screens
 * (Theme, Language, Currency, Number Format).
 *
 * Single-select picker pattern:
 * each row is its **own** bordered card with a small gap between
 * siblings. The visual breathing room communicates "pick one" vs a
 * dense navigation list (`SettingsRow`). Selected state is expressed
 * with a primary-colored border, a muted tinted background, and a
 * filled checkmark on the right. Parent renders children in a gapped
 * `<View>` — no shared card wrapper.
 *
 * @module
 */

import type {ReactElement, ReactNode} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

export type SettingsPickerRowProps = {
  label: string
  labelAccessory?: ReactNode | undefined
  sublabel?: string | undefined
  trailingText?: string | undefined
  leftGlyph?: ReactNode | undefined
  selected: boolean
  checkboxVariant?: 'check' | 'radio'
  onPress: () => void
  /**
   * Offered but not choosable. The row stays visible and keeps its sublabel, which is where the
   * reason belongs: a choice that silently disappears reads as a bug, while one that is visibly
   * refused explains itself.
   */
  isDisabled?: boolean | undefined
  testID?: string | undefined
}

export const SettingsPickerRow = ({
  label,
  labelAccessory,
  sublabel,
  trailingText,
  leftGlyph,
  selected,
  checkboxVariant = 'check',
  onPress,
  isDisabled = false,
  testID,
}: SettingsPickerRowProps): ReactElement => {
  styles.useVariants({selected, isDisabled})

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      style={({pressed}) => [styles.row, pressed && !isDisabled && styles.rowPressed]}
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{selected, disabled: isDisabled}}
      accessibilityLabel={label}
    >
      <ChamferBackground
        size="auto"
        fillToken={selected && !isDisabled ? 'primaryMuted' : 'backgroundLayer1'}
        borderToken={selected && !isDisabled ? 'primaryDefault' : 'borderDefaultWeak'}
        borderWidth={1}
      />
      {leftGlyph ? <View style={styles.glyph}>{leftGlyph}</View> : null}
      <View style={styles.text}>
        <View style={styles.labelRow}>
          <Typography variant="bodyMd_medium">{label}</Typography>
          {labelAccessory}
        </View>
        {sublabel ? (
          <Typography variant="bodySm_regular" style={styles.sublabel}>
            {sublabel}
          </Typography>
        ) : null}
      </View>
      {trailingText ? (
        <Typography variant="bodyMd_regular" style={styles.trailingText}>
          {trailingText}
        </Typography>
      ) : null}
      <View style={styles.checkCircle}>
        {selected ? (
          checkboxVariant === 'check' ? (
            <UniIcon
              name="check"
              size="xs"
              uniProps={(theme) => ({color: theme.colors.primaryInverse})}
              testID={`${testID}-check`}
            />
          ) : (
            <View style={styles.radioCircle} testID={`${testID}-check`} />
          )
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create(({colors, spacing, borderRadius}) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing12,
    paddingHorizontal: spacing.spacing12,
    variants: {
      isDisabled: {
        true: {opacity: 0.45},
        false: {opacity: 1},
      },
    },
  },
  rowPressed: {
    opacity: 0.7,
  },
  glyph: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: spacing.spacing2,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.spacing8,
  },
  sublabel: {
    color: colors.textAlternative,
  },
  trailingText: {
    color: colors.textAlternative,
    fontVariant: ['tabular-nums'],
  },
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    variants: {
      selected: {
        true: {
          borderColor: colors.primaryDefault,
          backgroundColor: colors.primaryDefault,
        },
        false: {
          borderColor: colors.borderDefaultStrong,
          backgroundColor: 'transparent',
        },
      },
    },
  },
  radioCircle: {
    width: 18,
    height: 18,
    borderRadius: borderRadius.roundedCircle,
    backgroundColor: colors.primaryDefault,
    borderWidth: 3,
    borderColor: colors.backgroundDefault,
  },
}))
