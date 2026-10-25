/**
 * NumpadButton component.
 *
 * Individual button for numeric input pad.
 *
 * @module
 */

import {ImpactFeedbackStyle, impactAsync} from 'expo-haptics'
import {memo, type ReactElement, type ReactNode, useState} from 'react'
import {Pressable, View} from 'react-native'
import Animated, {useAnimatedStyle, useSharedValue, withSpring} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'

import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'
import {UniIcon, type UniIconName} from '../UniIcon'

export type NumpadButtonProps = {
  /** Button value (number or special key) */
  value?: string | undefined
  /** Icon to display instead of value */
  icon?: UniIconName | undefined
  /** Custom content */
  children?: ReactNode | undefined
  /** Press handler */
  onPress?: (() => void) | undefined
  /** Long press handler */
  onLongPress?: (() => void) | undefined
  /** Whether button is disabled */
  isDisabled?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * NumpadButton component.
 *
 * A single button in the numpad grid.
 *
 * @example
 * ```tsx
 * <NumpadButton value="5" onPress={() => handleInput('5')} />
 * <NumpadButton icon="backspace" onPress={handleBackspace} />
 * ```
 */
export const NumpadButton = memo(
  ({value, icon, children, onPress, onLongPress, isDisabled = false, testID}: NumpadButtonProps): ReactElement => {
    const scale = useSharedValue(1)
    // Plain state, not a shared value: the press fill is a chamfered SVG rather
    // than an animated background colour, so it is mounted/unmounted rather
    // than interpolated.
    const [isPressed, setIsPressed] = useState(false)

    const handlePressIn = () => {
      scale.value = withSpring(0.92, {damping: 15, stiffness: 300})
      setIsPressed(true)
      if (!isDisabled) {
        impactAsync(ImpactFeedbackStyle.Light)
      }
    }

    const handlePressOut = () => {
      scale.value = withSpring(1, {damping: 15, stiffness: 300})
      setIsPressed(false)
    }

    const animatedStyle = useAnimatedStyle(() => ({transform: [{scale: scale.value}]}))

    return (
      <Pressable
        onPress={isDisabled ? undefined : onPress}
        onLongPress={isDisabled ? undefined : onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={isDisabled}
        accessibilityRole="button"
        testID={testID}
        style={styles.buttonContainer}
      >
        <Animated.View style={[styles.button(isDisabled), animatedStyle]}>
          {isPressed && (
            <View style={styles.pressFill} pointerEvents="none">
              <ChamferBackground size="auto" fillToken="primaryMuted" />
            </View>
          )}
          {children ??
            (icon ? (
              <UniIcon name={icon} size="md" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
            ) : (
              <Typography variant="headingMd" style={styles.textDefault}>
                {value}
              </Typography>
            ))}
        </Animated.View>
      </Pressable>
    )
  },
)

const styles = StyleSheet.create(({colors}) => ({
  buttonContainer: {
    minWidth: 72,
    flex: 1,
  },
  button: (isDisabled: boolean) => ({
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: isDisabled ? 0.4 : 1,
  }),
  pressFill: {
    ...StyleSheet.absoluteFillObject,
  },
  textDefault: {
    color: colors.textDefault,
  },
}))
