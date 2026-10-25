/**
 * Toggle component.
 *
 * An animated toggle switch using react-native-reanimated.
 *
 * @module
 */

import {memo, useState} from 'react'
import {Pressable, View} from 'react-native'
import Animated, {Easing, useAnimatedStyle, withTiming} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

/** Available toggle size options */
export type ToggleSize = 'sm' | 'md'

/** Maps size to knob translation distance */
const sizeToKnobRange: Record<ToggleSize, number> = {
  sm: 16,
  md: 22,
}

/** Maps size to container dimensions */
const sizeToContainer: Record<ToggleSize, {width: number; height: number}> = {
  sm: {width: 36, height: 22},
  md: {width: 51, height: 31},
}

/** Maps size to knob dimensions */
const sizeToKnob: Record<ToggleSize, {width: number; height: number}> = {
  sm: {width: 18, height: 18},
  md: {width: 27, height: 27},
}

export type ToggleProps = {
  /** Whether the toggle is checked/on */
  checked: boolean
  /** Change handler */
  onChange: (value: boolean) => void
  /** Whether the toggle is disabled */
  disabled?: boolean | undefined
  /** Size preset */
  size?: ToggleSize | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * Toggle component.
 *
 * An animated switch that smoothly transitions between on/off states.
 *
 * @example
 * ```tsx
 * <Toggle checked={isEnabled} onChange={setIsEnabled} />
 * <Toggle checked={value} onChange={setValue} size="sm" />
 * <Toggle checked={false} onChange={() => {}} disabled />
 * ```
 */
export const Toggle = memo(({checked, onChange, size = 'md', disabled = false, testID}: ToggleProps) => {
  const [pressed, setPressed] = useState(false)

  const handlePressIn = () => {
    setPressed(true)
  }

  const handlePressOut = () => {
    setPressed(false)
  }

  const handleChange = () => {
    if (disabled) {
      return
    }
    onChange(!checked)
  }

  // Discrete fill/border swap (no interpolation) — driven by Unistyles variants so
  // the surface repaints via the native shadow tree on theme switch without a JS
  // re-render. Only the knob's translateX is animated on the UI thread.
  const tone = pressed ? (checked ? 'checkedPressed' : 'uncheckedPressed') : checked ? 'checked' : 'unchecked'
  styles.useVariants({tone})

  const knobAnimatedStyles = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateX: withTiming(checked ? sizeToKnobRange[size] : 2, {
            duration: 300,
            easing: Easing.out(Easing.exp),
          }),
        },
      ],
    }
  })

  const containerDimensions = sizeToContainer[size]
  const knobDimensions = sizeToKnob[size]

  return (
    <Pressable
      style={[styles.container, containerDimensions]}
      onPress={handleChange}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      testID={testID}
      accessibilityRole="switch"
      accessibilityState={{checked, disabled}}
    >
      <View style={[styles.containerBackground, {opacity: disabled ? 0.3 : 1}]}>
        <Animated.View style={[styles.knob, knobDimensions, knobAnimatedStyles]} />
      </View>
    </Pressable>
  )
})

// On-state fill is `primaryDefault` (resolves to primary600 in light / primary500 in
// dark — the brighter dark accent, no manual
// isDark branch needed). Off-state uses a neutral elevated surface + visible border, not
// `primaryAlternative` (which in dark is a saturated brand blue indistinguishable from
// the on-state). On-state border matches the fill so it disappears.
const styles = StyleSheet.create(({borderRadius, spacing, colors}) => ({
  container: {
    // Base container - dimensions applied inline
  },
  containerBackground: {
    borderRadius: spacing.spacing16,
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    borderWidth: 1,
    variants: {
      tone: {
        checked: {backgroundColor: colors.primaryDefault, borderColor: colors.primaryDefault},
        unchecked: {backgroundColor: colors.backgroundAlternativeMuted, borderColor: colors.borderInteractive},
        checkedPressed: {backgroundColor: colors.primaryPressed, borderColor: colors.primaryPressed},
        uncheckedPressed: {
          backgroundColor: colors.backgroundAlternativePressed,
          borderColor: colors.borderInteractive,
        },
      },
    },
  },
  knob: {
    borderRadius: borderRadius.rounded16,
    backgroundColor: colors.primaryInverse,
    // dimensions applied inline
  },
}))
