/**
 * TextArea component.
 *
 * A multiline text input with optional icon button.
 *
 * Performance: Consolidated animated styles to reduce useAnimatedStyle calls from 2 to 1.
 *
 * @module
 */

import {forwardRef, memo, useImperativeHandle, useRef, useState} from 'react'
import {type TextInput, View} from 'react-native'
import Animated, {useSharedValue} from 'react-native-reanimated'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import type {NewColorTokens} from '../theme/tokens'
import {ButtonIcon} from './Buttons'
import {ChamferBackground} from './Chamfer'
import {type Surface, useSurface} from './surface-context'
import {TextInputBase} from './TextInputBase'
import type {UniIconName} from './UniIcon'
import {WarningMessage, type WarningMessageVariant} from './WarningMessage'

/** Text area style variant */
export type TextAreaVariant = 'primary' | 'secondary'

export type TextAreaProps = {
  /** Current input value */
  value?: string | undefined
  /** Change handler */
  onChange?: ((value: string) => void) | undefined
  /** Visual style variant */
  variant?: TextAreaVariant | undefined
  /** Whether to fill available width */
  fullWidth?: boolean | undefined
  /** Placeholder text */
  placeholder?: string | undefined
  /** Whether the input is in error state */
  isError?: boolean | undefined
  /** Message to display below input */
  message?: string | undefined
  /** Warning message variant */
  messageVariant?: WarningMessageVariant | undefined
  /** Whether the input is disabled */
  isDisabled?: boolean | undefined
  /** Auto-capitalize mode */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters' | undefined
  /** Whether to auto-correct */
  autoCorrect?: boolean | undefined
  /** Whether to check spelling */
  spellCheck?: boolean | undefined
  /** Keyboard type */
  keyboardType?: 'default' | 'visible-password' | undefined
  /** Whether to auto-focus */
  autoFocus?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
  /** Whether to allow font scaling */
  allowFontScaling?: boolean | undefined
  /** Icon button name */
  btnIcon?: UniIconName | undefined
  /** Icon button color */
  btnIconColor?: string | undefined
  /** Icon button press handler */
  onPressIcon?: (() => void) | undefined
  /** Maximum character length */
  maxLength?: number | undefined
  /** Focus handler */
  onFocus?: (() => void) | undefined
  /** Blur handler */
  onBlur?: (() => void) | undefined
  /** Vertical text alignment */
  textAlignVertical?: 'auto' | 'top' | 'bottom' | 'center' | undefined
  /** Whether to select all text on focus (defaults to false) */
  selectTextOnFocus?: boolean | undefined
  /** Whether to blur input on submit/Enter (defaults to false for multiline) */
  blurOnSubmit?: boolean | undefined
  /** Called when submit button (Enter/Return) is pressed */
  onSubmitEditing?: (() => void) | undefined
}

/** Ref handle for TextArea - allows focusing the input */
export type TextAreaRef = {
  focus: () => void
}

/**
 * The input fills its box.
 *
 * A plain object, not part of the Unistyles sheet below: a Unistyles style does not reach
 * react-native-web's `TextInput` (it renders a `<textarea>` whose only CSS rule is RNW's own
 * base class), so `flex: 1` declared there never took effect and the control kept the
 * intrinsic height of `rows=2` — a 34px scroll area floating in a 140px box.
 */
const FILL_HEIGHT = {height: '100%'} as const

/**
 * The area's fill, by variant and by the surface it sits on.
 *
 * Same rule as `TextInput`, for the same reason: `backgroundFormField` *is* the
 * card colour, so inside a card the field disappeared into it. See
 * `surface-context`.
 */
const mapVariantToBgColor: Record<Surface, Record<TextAreaVariant, keyof NewColorTokens>> = {
  canvas: {primary: 'backgroundFormField', secondary: 'backgroundAlternativeFormField'},
  card: {primary: 'backgroundDefault', secondary: 'backgroundDefault'},
}

/**
 * TextArea component.
 *
 * A multiline text input for longer form content.
 *
 * @example
 * ```tsx
 * // Basic textarea
 * <TextArea
 *   value={notes}
 *   onChange={setNotes}
 *   placeholder="Enter your notes..."
 * />
 *
 * // With copy button
 * <TextArea
 *   value={address}
 *   onChange={setAddress}
 *   btnIcon="copy"
 *   onPressIcon={handleCopy}
 * />
 * ```
 */
export const TextArea = memo(
  forwardRef<TextAreaRef, TextAreaProps>(
    (
      {
        onChange,
        btnIcon,
        btnIconColor,
        onPressIcon,
        messageVariant,
        variant = 'primary',
        value = '',
        fullWidth = true,
        isError = false,
        message = '',
        isDisabled = false,
        placeholder = '',
        autoFocus = false,
        autoCapitalize,
        autoCorrect,
        spellCheck,
        keyboardType,
        maxLength,
        testID,
        onBlur,
        onFocus,
        textAlignVertical,
        allowFontScaling = false,
        selectTextOnFocus = false,
        blurOnSubmit = false,
        onSubmitEditing,
      },
      ref,
    ) => {
      const {theme} = useUnistyles()
      const surface = useSurface()
      const isFocused = useSharedValue(false)
      // The surface is painted, so the focus state must be readable at render time.
      const [hasFocus, setHasFocus] = useState(false)
      const inputRef = useRef<TextInput>(null)

      useImperativeHandle(ref, () => ({
        focus: () => inputRef.current?.focus(),
      }))

      const handleFocus = () => {
        isFocused.value = true
        setHasFocus(true)
        onFocus?.()
      }

      const handleBlur = () => {
        isFocused.value = false
        setHasFocus(false)
        onBlur?.()
      }

      const bgColor = theme.colors[mapVariantToBgColor[surface][variant]]

      return (
        <View style={styles.container(fullWidth)}>
          <Animated.View style={styles.animatedView(isDisabled)} onFocus={handleFocus} onBlur={handleBlur}>
            <ChamferBackground
              size="auto"
              fill={bgColor}
              {...(isDisabled
                ? {}
                : {
                    borderColor: isError && hasFocus ? theme.colors.errorDefault : theme.colors.borderDefaultStrong,
                    borderWidth: 2,
                  })}
            />
            <View style={styles.inputWrapper}>
              <TextInputBase
                ref={inputRef}
                style={[styles.textInputStyles, FILL_HEIGHT]}
                multiline
                onChangeText={onChange}
                value={value}
                onBlur={handleBlur}
                onFocus={handleFocus}
                selectionColor={theme.colors.secondaryDefault}
                editable={!isDisabled}
                selectTextOnFocus={selectTextOnFocus && !isDisabled}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.textAlternative}
                showSoftInputOnFocus={!isDisabled}
                scrollEnabled={!isDisabled}
                autoFocus={autoFocus}
                autoCapitalize={autoCapitalize}
                autoCorrect={autoCorrect}
                spellCheck={spellCheck}
                keyboardType={keyboardType}
                maxLength={maxLength}
                testID={testID}
                textAlignVertical={textAlignVertical}
                allowFontScaling={allowFontScaling}
                blurOnSubmit={blurOnSubmit}
                onSubmitEditing={onSubmitEditing}
              />
            </View>
            {btnIcon && (
              <View style={styles.btnIconWrapper}>
                <ButtonIcon
                  icon={btnIcon}
                  onPress={onPressIcon}
                  iconProps={{color: btnIconColor ?? theme.colors.iconDefault}}
                  isDisabled={isDisabled}
                  variant="naked"
                  size="md"
                />
              </View>
            )}
          </Animated.View>
          {/* Ternary, not `&&`: `message` defaults to '' and `'' && …` evaluates to '', which
              React renders as a text node — illegal as a direct child of a View. */}
          {message !== '' ? (
            <View style={styles.warningMessage}>
              {/* ⚠️ Defaults to the neutral variant, not `warning`. A `message` is a hint far more
                  often than an alert, and defaulting to warning put a ⚠️ triangle in warning yellow
                  beside plain guidance — a caller had to know to opt *out* of an alarm it never
                  asked for. `TextInput` had the same default and the same bug. */}
              <WarningMessage variant={messageVariant ?? 'default'} label={message} />
            </View>
          ) : null}
        </View>
      )
    },
  ),
)

const styles = StyleSheet.create(({colors, spacing, fontFamily, fontWeights, fontSizes}) => ({
  container: (fullWidth: boolean) => ({
    width: fullWidth ? ('100%' as const) : 340,
    flexDirection: 'column' as const,
    gap: spacing.spacing2,
  }),
  warningMessage: {
    paddingLeft: spacing.spacing16,
  },
  animatedView: (isDisabled: boolean) => ({
    justifyContent: 'center' as const,
    padding: spacing.spacing16,
    position: 'relative' as const,
    width: '100%' as const,
    height: 140,
    opacity: isDisabled ? 0.4 : 1,
    gap: spacing.spacing2,
  }),
  inputWrapper: {
    height: '100%' as const,
    flex: 1,
    justifyContent: 'space-between' as const,
  },
  btnIconWrapper: {
    alignItems: 'flex-end' as const,
  },
  textInputStyles: {
    borderColor: 'transparent',
    color: colors.textDefault,
    fontFamily: fontFamily.regular,
    fontWeight: fontWeights.regular as '400',
    fontSize: fontSizes.bodyMd,
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    borderWidth: 0,
    flex: 1,
    zIndex: 1,
  },
}))
