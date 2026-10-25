/**
 * The visual half of {@link DateTimeField}: a read-only labelled box showing the
 * moment that was chosen, with a line under it for whatever the caller considers
 * the ground truth.
 *
 * Split from the field itself because only the picker differs between the native
 * and web builds — the surface is one implementation for both.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useFormatDate} from '../../hooks/useFormatDate'
import {TextInput} from '../TextInput'
import {Typography} from '../Typography'

const styles = StyleSheet.create(({spacing, colors}) => ({
  container: {gap: spacing.spacing2},
  hint: {color: colors.textAlternative, paddingLeft: spacing.spacing16},
}))

export type DateTimeFieldProps = {
  /** Floating label, e.g. "Not before". */
  label: string
  /** The chosen moment, or `null` when the field is unset. */
  value: Date | null
  /** Receives `null` when the user clears the field. */
  onChange: (value: Date | null) => void
  /**
   * A line under the field. The caller owns it, including what it says while
   * nothing is chosen: the box itself has no room for a placeholder, because a
   * field that never takes focus never floats its label off the value band.
   */
  hint?: string | undefined
  /** Names the clear affordance for a screen reader. */
  clearLabel: string
  /** Earliest moment the picker offers. */
  minimumDate?: Date | undefined
  testID?: string | undefined
}

type SurfaceProps = DateTimeFieldProps & {
  /** Opens the platform's picker. */
  onOpen: () => void
  /** The picker itself, when the platform mounts one into the tree. */
  children?: ReactNode
}

export const DateTimeFieldSurface = ({
  label,
  value,
  onChange,
  hint,
  clearLabel,
  onOpen,
  testID,
  children,
}: SurfaceProps) => {
  const {formatDateTime} = useFormatDate()

  return (
    <View style={styles.container}>
      <TextInput
        label={label}
        value={value === null ? '' : formatDateTime(value)}
        onPress={onOpen}
        fullWidth
        {...(value === null
          ? {rightIcon: 'clock' as const, onRightIcon: onOpen}
          : {
              rightIcon: 'close' as const,
              onRightIcon: () => onChange(null),
              rightIconAccessibilityLabel: clearLabel,
            })}
        {...(testID === undefined ? {} : {testID})}
      />
      {hint === undefined ? null : (
        <Typography variant="bodySm_regular" style={styles.hint}>
          {hint}
        </Typography>
      )}
      {children}
    </View>
  )
}
