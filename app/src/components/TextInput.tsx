/**
 * TextInput component.
 *
 * A rich text input with animated label, icons, and validation states.
 *
 * Performance: Consolidated animated styles to reduce useAnimatedStyle calls from 4 to 2.
 *
 * @module
 */

import {forwardRef, useMemo, useState} from 'react'
import type {KeyboardTypeOptions, TextInput as RNTextInput, TextStyle, ViewStyle} from 'react-native'
import {Platform, Pressable, View} from 'react-native'
import Animated, {useAnimatedStyle, useSharedValue, withSpring} from 'react-native-reanimated'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import type {NewColorTokens} from '../theme/tokens'
import {ButtonIcon} from './Buttons'
import {type IconProp, renderIcon} from './Buttons/Button'
import {ChamferBackground} from './Chamfer'
import {CircleLoader} from './Loaders/CircleLoader'
import {type Surface, useSurface} from './surface-context'
import {TextInputBase} from './TextInputBase'
import {Typography} from './Typography'
import type {UniIconProps} from './UniIcon'
import {WarningMessage, type WarningMessageVariant} from './WarningMessage'

/** Text input style variant */
export type TextInputVariant = 'primary' | 'secondary'

/** Text input size preset */
export type TextInputSize = 'md' | 'sm'

export type TextInputProps = {
  /** Current input value */
  value?: string | undefined
  /** Change handler */
  onChange?: ((value: string) => void) | undefined
  /** Visual style variant */
  variant?: TextInputVariant | undefined
  /** Whether to fill available width */
  fullWidth?: boolean | undefined
  /** Size preset */
  size?: TextInputSize | undefined
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
  /** Autofill hint. Set to `'off'` on sensitive password fields to suppress iOS AutoFill suggestions. */
  autoComplete?: 'off' | 'password' | 'username' | 'email' | 'one-time-code' | 'new-password' | undefined
  /** Whether to auto-focus */
  autoFocus?: boolean | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
  /** Whether to allow font scaling */
  allowFontScaling?: boolean | undefined
  /** Floating label text */
  label?: string | undefined
  /** Left icon press handler */
  onLeftIcon?: (() => void) | undefined
  /** Left icon */
  leftIcon?: IconProp | undefined
  /** Left icon color */
  leftIconColor?: string | undefined
  /** Right icon press handler */
  onRightIcon?: (() => void) | undefined
  /** Right icon */
  rightIcon?: IconProp | undefined
  /** Right icon color */
  rightIconColor?: string | undefined
  /** Names the right icon's action for a screen reader. Without it the button is announced unnamed. */
  rightIconAccessibilityLabel?: string | undefined
  /** Extra right icon press handler */
  onRightExtraIcon?: (() => void) | undefined
  /** Extra right icon */
  rightExtraIcon?: IconProp | undefined
  /** Extra right icon color */
  rightExtraIconColor?: string | undefined
  /** Whether to hide text (password input) */
  secureTextEntry?: boolean | undefined
  /** Placeholder text color */
  placeholderTextColor?: string | undefined
  /** Press handler (makes input act as button) */
  onPress?: (() => void) | undefined
  /** Unit label (e.g., "ADA") */
  unitLabel?: string | undefined
  /** Keyboard type */
  keyboardType?: KeyboardTypeOptions | undefined
  /** Number of lines for message */
  messageNumberOfLines?: number | undefined
  /** Focus handler */
  onFocus?: (() => void) | undefined
  /** Blur handler */
  onBlur?: (() => void) | undefined
  /** Maximum character length */
  maxLength?: number | undefined
  /** Whether to select text on focus */
  selectTextOnFocus?: boolean | undefined
  /** Whether to show loading spinner */
  isLoading?: boolean | undefined
  /** Text alignment within the input */
  textAlign?: 'left' | 'center' | 'right' | undefined
  /** Extra style applied to the animated container (border + background). Use to override borderRadius per call site. */
  inputContainerStyle?: ViewStyle | undefined
  /**
   * Extra style applied to the inner `<TextInput>` element itself (text glyph layer).
   * Use sparingly — most consumers should not need this. Useful when a screen needs
   * a custom (typically tighter) lineHeight to compensate for a non-default outer
   * height: the default `lineHeight: bodyMd` (22) is tuned for the 56-tall md variant
   * and renders bottom-heavy if the outer container is shrunk via `inputContainerStyle`.
   */
  inputStyle?: TextStyle | undefined
}

/**
 * The field's fill, by variant and by the surface it sits on.
 *
 * ⚠️ **On a card the field takes the *canvas* colour.** `backgroundFormField` is
 * the card colour — correct against the canvas, and invisible inside a card,
 * where a field's edge disappeared and a form read as flat text. Inverting it
 * holds in both themes: dark is #080C18 canvas against a #141A2E card, light is
 * #F5F7FA canvas against a #FFFFFF card, so the field is always the darker of
 * the two.
 *
 * Both variants collapse to one token on a card — there is no second surface
 * below the canvas to distinguish them with, and inventing one would be a colour
 * the theme does not define.
 */
const mapVariantToBgColor: Record<Surface, Record<TextInputVariant, keyof NewColorTokens>> = {
  canvas: {primary: 'backgroundFormField', secondary: 'backgroundAlternativeFormField'},
  card: {primary: 'backgroundDefault', secondary: 'backgroundDefault'},
}

/** Maps variant to pressed background color token, per surface. */
const mapVariantToPressedBgColor: Record<Surface, Record<TextInputVariant, keyof NewColorTokens>> = {
  canvas: {primary: 'backgroundPressed', secondary: 'backgroundAlternativePressed'},
  card: {primary: 'backgroundDefaultPressed', secondary: 'backgroundDefaultPressed'},
}

/**
 * Outer height of `animatedContainer` per {@link TextInputSize} — keep in sync with that style’s `variants.size` heights.
 */
const webLabeledFieldOuterHeightPx: Record<TextInputSize, number> = {
  md: 56,
  sm: 40,
}

/**
 * Where a floated label sits, and how much room the value keeps clear of it.
 *
 * ⚠️ **One decision, three consumers.** The label's spring animates to
 * {@link FLOATED_LABEL_TOP} and renders in a {@link FLOATED_LABEL_BAND} line box;
 * the native padding and the web padding both start the value at
 * {@link floatedValueTopPx}. When those numbers lived apart, the label and the
 * value overlapped by 8px on every labelled field in the app, and fixing one copy
 * left the others crowded.
 *
 * The gap comes out of the space *below* the value, not out of the field's
 * height: an md field is 56 tall, so 4 (above the label) + 16 (label) + 8 (gap) +
 * 22 (value line) leaves 6 beneath it. The value was previously 4px under the
 * label with 10px going to waste at the bottom, which read as the two being
 * jammed together.
 */
const FLOATED_LABEL_TOP = 4
/** `lineHeights.bodyXs`, hard-coded here because a token cannot be read at module scope. */
const FLOATED_LABEL_BAND = 16
/** Breathing room between the label and the value. The whole point of this block. */
const LABEL_VALUE_GAP = 8
/** Where the value's line box starts, measured from the top of the field. */
const floatedValueTopPx = FLOATED_LABEL_TOP + FLOATED_LABEL_BAND + LABEL_VALUE_GAP

/**
 * TextInput component.
 *
 * A full-featured text input with animated floating label, icons,
 * validation messages, and loading states.
 *
 * @example
 * ```tsx
 * // Basic input
 * <TextInput
 *   label="Email"
 *   value={email}
 *   onChange={setEmail}
 *   placeholder="Enter your email"
 * />
 *
 * // With icons and validation
 * <TextInput
 *   label="Password"
 *   value={password}
 *   onChange={setPassword}
 *   secureTextEntry
 *   rightIcon="eye"
 *   onRightIcon={togglePasswordVisibility}
 *   isError={!!passwordError}
 *   message={passwordError}
 * />
 * ```
 */
export const TextInput = forwardRef<RNTextInput, TextInputProps>(
  (
    {
      onChange,
      leftIcon,
      leftIconColor,
      rightExtraIcon,
      rightExtraIconColor,
      rightIcon,
      rightIconColor,
      rightIconAccessibilityLabel,
      messageVariant,
      onLeftIcon,
      onRightExtraIcon,
      onRightIcon,
      variant = 'primary',
      value = '',
      fullWidth = false,
      label = '',
      secureTextEntry = false,
      isError = false,
      message = '',
      isDisabled = false,
      size = 'md',
      placeholder = '',
      autoCapitalize,
      autoCorrect,
      autoComplete,
      onPress,
      unitLabel,
      placeholderTextColor,
      keyboardType,
      messageNumberOfLines,
      onFocus,
      onBlur,
      autoFocus,
      testID,
      maxLength,
      allowFontScaling = false,
      selectTextOnFocus,
      isLoading = false,
      textAlign,
      inputContainerStyle,
      inputStyle,
    },
    ref,
  ) => {
    const {theme} = useUnistyles()
    // Which surface this field sits on — a Card declares it, everything else is canvas.
    const surface = useSurface()
    styles.useVariants({size} as Parameters<typeof styles.useVariants>[0])
    const isFocused = useSharedValue(false)
    const isPressed = useSharedValue(false)
    // React mirror of the focus shared value — the placeholder visibility below
    // needs a re-render, which reanimated shared values don't trigger.
    const [hasFocus, setHasFocus] = useState(false)
    // Same reason as `hasFocus`: the field's surface is painted rather than styled,
    // so the press state has to be readable at render time.
    const [isPressedState, setIsPressed] = useState(false)

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
    const handlePressIn = () => {
      isPressed.value = true
      setIsPressed(true)
    }
    const handlePressOut = () => {
      isPressed.value = false
      setIsPressed(false)
    }

    const bgColor = theme.colors[mapVariantToBgColor[surface][variant]]
    const pressedBgColor = theme.colors[mapVariantToPressedBgColor[surface][variant]]

    // Consolidated label animation styles (position + typography)
    const animatedLabelStyles = useAnimatedStyle(() => {
      const onTop = isFocused.value || value.length > 0
      return {
        transform: [{translateY: withSpring(onTop ? FLOATED_LABEL_TOP : 14, {overshootClamping: true, mass: 0.1})}],
        fontSize: onTop ? theme.fontSizes.bodySm : theme.fontSizes.bodyMd,
        fontFamily: onTop ? theme.fontFamily.medium : theme.fontFamily.regular,
        // ⚠️ `bodyXs` (16), not `bodySm` (20) — the value's offset is measured against this band.
        // See FLOATED_LABEL_BAND: floated, the label runs y=4..20 and the value starts at
        // `floatedValueTopPx`. A 20px box here would run the label into it again.
        lineHeight: onTop ? theme.lineHeights.bodyXs : theme.lineHeights.bodyMd,
        fontWeight: (onTop ? theme.fontWeights.medium : theme.fontWeights.regular) as '400',
        width: onTop ? ('100%' as const) : ('auto' as const),
      }
    })

    const handledIconProps: Omit<UniIconProps, 'name'> = {
      size: 'sm',
    }

    /**
     * RN Web: full `height`/`width` keeps the whole row focusable. Browsers often bottom-pin single-line
     * text when `line-height` is shorter than the band below `padding-top` (notably password fields).
     * Match `lineHeight` to that band (`inner height − paddingTop`) so glyphs and caret sit centered there.
     *
     * The value starts at {@link floatedValueTopPx} so it clears the floated label with a real gap
     * rather than crowding it.
     * `type="password"` still often renders bullets low; a small `translateY` nudges them up
     * without shrinking the hit target.
     */
    const webLabeledInputLayout = useMemo((): TextStyle | undefined => {
      if (!label || Platform.OS !== 'web') return undefined
      const outerPx = webLabeledFieldOuterHeightPx[size]
      const verticalBorderPx = isDisabled ? 0 : theme.borderWidth.m * 2
      const innerPx = outerPx - verticalBorderPx
      // Same offset the native path pads by, so a field is not spaced differently
      // per platform. `sm` has no room for a floated label at all (4 + 16 + 8 + 22
      // exceeds 40), so it keeps as much of the gap as fits rather than pushing the
      // value out of the box.
      const paddingTopPx = size === 'md' ? floatedValueTopPx : Math.min(floatedValueTopPx, innerPx - 22)
      const lineBandPx = Math.max(1, innerPx - paddingTopPx)
      return {
        paddingTop: paddingTopPx,
        lineHeight: lineBandPx,
        height: '100%',
        width: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        verticalAlign: 'top',
        ...(secureTextEntry ? {transform: [{translateY: size === 'md' ? -3 : -2}]} : {}),
      } as unknown as TextStyle
    }, [label, size, isDisabled, secureTextEntry, theme.borderWidth.m])

    /**
     * RN Web: unlabeled fields (placeholder-only, e.g. pool search) do not use {@link webLabeledInputLayout}.
     * Symmetric vertical padding centers the single line inside the fixed outer height so text/placeholder
     * align with left/right icons; browsers otherwise top-pin glyphs in a stretched flex row.
     */
    const webUnlabeledInputLayout = useMemo((): TextStyle | undefined => {
      if (label || Platform.OS !== 'web') return undefined
      const outerPx = webLabeledFieldOuterHeightPx[size]
      const verticalBorderPx = isDisabled ? 0 : theme.borderWidth.m * 2
      const innerPx = outerPx - verticalBorderPx
      const lineHeightPx = theme.lineHeights.bodyMd
      const padV = Math.max(0, Math.floor((innerPx - lineHeightPx) / 2))
      return {
        paddingTop: padV,
        paddingBottom: padV,
        lineHeight: lineHeightPx,
        height: '100%',
        width: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
      } as unknown as TextStyle
    }, [label, size, isDisabled, theme.borderWidth.m, theme.lineHeights.bodyMd])

    const nativeUnlabeledInputLayout = useMemo((): TextStyle | undefined => {
      if (label || Platform.OS === 'web') return undefined
      return {
        lineHeight: theme.fontSizes.bodyMd + 2,
        paddingTop: 0,
        paddingBottom: 0,
      }
    }, [label, theme.fontSizes.bodyMd])

    return (
      <View style={styles.container(fullWidth)}>
        <Animated.View
          style={[styles.animatedContainer(isDisabled), inputContainerStyle]}
          onFocus={handleFocus}
          onBlur={handleBlur}
        >
          <ChamferBackground
            size="auto"
            fill={isPressedState && !isDisabled ? pressedBgColor : bgColor}
            {...(isDisabled
              ? {}
              : {
                  borderColor:
                    isError && hasFocus
                      ? theme.colors.errorDefault
                      : hasFocus
                        ? theme.colors.primaryDefault
                        : isPressedState
                          ? pressedBgColor
                          : bgColor,
                  borderWidth: theme.borderWidth.m,
                })}
          />
          {leftIcon ? (
            <View style={styles.inputWrapper}>
              <ButtonIcon
                icon={leftIcon}
                size="sm"
                iconProps={{color: leftIconColor ?? theme.colors.iconDefault}}
                onPress={onLeftIcon}
                variant="naked"
                noFocus
              />
            </View>
          ) : null}

          <View style={styles.inputContainer}>
            {label ? (
              <Animated.Text
                style={[animatedLabelStyles, styles.labelContainer, styles.labelTextStyles]}
                allowFontScaling={allowFontScaling}
              >
                {label}
              </Animated.Text>
            ) : null}
            {isLoading ? (
              <View style={styles.loaderContainer}>
                <CircleLoader size="sm" />
              </View>
            ) : (
              <TextInputBase
                ref={ref}
                autoFocus={autoFocus}
                keyboardType={keyboardType}
                style={[
                  styles.textInputField,
                  label && Platform.OS !== 'web' ? styles.textInputPadNativeFloatingLabel : null,
                  webLabeledInputLayout,
                  webUnlabeledInputLayout,
                  nativeUnlabeledInputLayout,
                  inputStyle,
                ]}
                // ⚠️ A **prop**, not the style. RN maps this to the Android view's
                // gravity; inside a flattened style array it does nothing, which is
                // why the padding above appeared to be ignored — the field kept
                // centring its glyphs and the value sat under the label whatever
                // the padding said. `TextArea` has always passed it as a prop.
                {...(label && Platform.OS !== 'web' ? {textAlignVertical: 'top' as const} : {})}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                onChangeText={onChange}
                value={value}
                onBlur={handleBlur}
                onFocus={handleFocus}
                secureTextEntry={secureTextEntry}
                editable={!(isDisabled || onPress)}
                // Secure fields must never select-all on focus: on Android the
                // selection is re-applied after the first keystroke's controlled
                // re-render, so the second character replaces the first and the
                // leading password char is silently lost. Non-secure fields keep
                // select-on-focus (quick replace for amounts/search).
                selectTextOnFocus={selectTextOnFocus ?? (!(isDisabled || onPress) && !secureTextEntry)}
                // With a floating label the resting label occupies the value band —
                // showing the placeholder too renders both on top of each other.
                // The placeholder only appears once the label has floated up.
                placeholder={label && !hasFocus ? '' : placeholder}
                placeholderTextColor={placeholderTextColor || theme.colors.textAlternative}
                selectionColor={theme.colors.secondaryDefault}
                autoCapitalize={autoCapitalize}
                autoCorrect={autoCorrect}
                autoComplete={autoComplete}
                testID={testID}
                maxLength={maxLength}
                allowFontScaling={allowFontScaling}
                textAlign={textAlign}
                {...(!label && Platform.OS === 'android'
                  ? {textAlignVertical: 'center' as const, includeFontPadding: false}
                  : {})}
              />
            )}

            {onPress ? <Pressable onPress={onPress} style={styles.pressableContainer} /> : null}
          </View>
          <View style={styles.rightIconContainer}>
            {rightExtraIcon ? (
              onRightExtraIcon ? (
                <ButtonIcon
                  icon={rightExtraIcon}
                  size="sm"
                  iconProps={{color: rightExtraIconColor ?? theme.colors.iconDefault}}
                  onPress={onRightExtraIcon}
                  variant="naked"
                  noFocus
                />
              ) : (
                renderIcon(rightExtraIcon, {
                  ...handledIconProps,
                  color: rightExtraIconColor ?? theme.colors.iconDefault,
                })
              )
            ) : null}
            {rightIcon ? (
              <ButtonIcon
                icon={rightIcon}
                size="sm"
                iconProps={{color: rightIconColor ?? theme.colors.iconDefault}}
                onPress={onRightIcon}
                variant="naked"
                noFocus
                {...(rightIconAccessibilityLabel === undefined
                  ? {}
                  : {containerProps: {accessibilityRole: 'button', accessibilityLabel: rightIconAccessibilityLabel}})}
              />
            ) : null}
            {unitLabel ? (
              <Typography variant="bodyMd_medium" style={styles.unitLabel(isError)}>
                {unitLabel}
              </Typography>
            ) : null}
          </View>
        </Animated.View>
        {message ? (
          <View style={styles.warningMessage}>
            <WarningMessage
              // Neutral by default — see the note in `TextArea`, which had the identical bug.
              variant={messageVariant ?? 'default'}
              label={message}
              numberOfLines={messageNumberOfLines ?? 0}
              testID={testID ? `${testID}-message` : `default-warning-message`}
            />
          </View>
        ) : null}
      </View>
    )
  },
)

const styles = StyleSheet.create(({colors, spacing, fontFamily, fontWeights, fontSizes, lineHeights}) => ({
  container: (fullWidth: boolean) => ({
    width: fullWidth ? ('100%' as const) : 340,
    flexDirection: 'column' as const,
    gap: spacing.spacing2,
  }),
  warningMessage: {
    paddingLeft: spacing.spacing16,
  },
  animatedContainer: (isDisabled: boolean) => ({
    opacity: isDisabled ? 0.4 : 1,
    alignContent: 'center' as const,
    flexDirection: 'row' as const,
    paddingHorizontal: spacing.spacing16,
    gap: spacing.spacing8,
    position: 'relative' as const,
    width: '100%' as const,
    variants: {
      size: {
        // KEEP IN SYNC WITH webLabeledFieldOuterHeightPx
        md: {height: 56},
        sm: {height: 40},
      },
    },
  }),
  inputWrapper: {
    justifyContent: 'center' as const,
  },
  labelContainer: {
    position: 'absolute' as const,
    top: 0,
  },
  labelTextStyles: {
    color: colors.textAlternative,
  },
  inputContainer: {
    height: '100%' as const,
    flex: 1,
    position: 'relative' as const,
  },
  loaderContainer: {
    flex: 1,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  textInputField: {
    borderColor: 'transparent',
    color: colors.textDefault,
    fontFamily: fontFamily.regular,
    fontWeight: fontWeights.regular as '400',
    fontSize: fontSizes.bodyMd,
    lineHeight: lineHeights.bodyMd,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    borderWidth: 0,
    outlineWidth: 0,
    flex: 1,
    zIndex: 1,
  },
  textInputPadNativeFloatingLabel: {
    // Not a token: a computed offset (label top + label band + gap). A token that
    // happened to equal it would drift the moment either part changed.
    //
    // ⚠️ It must live **in this sheet**. `TextInputBase` flattens its style array,
    // and a plain object handed in alongside these entries is dropped on the way
    // through — the padding silently did nothing, which is most of why this looked
    // unfixable. The matching `textAlignVertical` is the mirror image: a *prop*,
    // because in a style it does nothing. See the render.
    paddingTop: floatedValueTopPx,
    // Android reserves space above and below the glyphs for the font's own metrics,
    // which would sit on top of an offset measured in layout pixels.
    includeFontPadding: false,
  },
  pressableContainer: {
    flex: 1,
    position: 'absolute' as const,
    zIndex: 2,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%' as const,
    height: '100%' as const,
  },
  rightIconContainer: {
    gap: spacing.spacing16,
    flexDirection: 'row' as const,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  unitLabel: (isError: boolean) => ({
    color: isError ? colors.errorDefault : colors.textAlternative,
  }),
}))
