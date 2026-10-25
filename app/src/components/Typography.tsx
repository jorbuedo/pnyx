/**
 * Typography component.
 *
 * A Text wrapper that provides themed typography variants using Unistyles.
 *
 * For values that should respect the global privacy eye toggle, use
 * `SensitiveTypography` instead — Typography itself is intentionally
 * unaware of privacy state.
 *
 * @module
 */

import type {RefObject} from 'react'
import {Text, type TextProps} from 'react-native'
import {StyleSheet, type UnistylesVariants} from 'react-native-unistyles'

const styles = StyleSheet.create(({colors, textVariants}) => ({
  base: {
    color: colors.textDefault,
    variants: {
      variant: textVariants,
      singleLine: {
        singleLine: {
          flexShrink: 1,
        },
        manyLines: {},
      },
    },
  },
}))

export type TypographyVariant = keyof typeof styles extends 'base'
  ? NonNullable<UnistylesVariants<typeof styles>['variant']>
  : never

export type TypographyProps = Omit<UnistylesVariants<typeof styles>, 'singleLine'> &
  TextProps & {
    /** Truncate to single line with ellipsis */
    singleLine?: boolean
    /** Ref to the underlying Text component */
    ref?: RefObject<Text | null>
  }

/**
 * Typography component for consistent text styling.
 *
 * Uses Unistyles text variants which combine fontSize, lineHeight, and fontFamily
 * based on the current theme.
 *
 * @example
 * ```tsx
 * <Typography variant="headingLg">Large Heading</Typography>
 * <Typography variant="bodyMd_regular">Regular body text</Typography>
 * <Typography variant="bodySm_bold" singleLine>Bold truncated text</Typography>
 * ```
 */
export const Typography = ({
  children,
  variant = 'bodyMd_regular',
  singleLine = false,
  style,
  testID,
  ref,
  ...props
}: TypographyProps) => {
  styles.useVariants({
    variant,
    singleLine: singleLine ? 'singleLine' : 'manyLines',
  })

  return (
    <Text
      ref={ref}
      style={[styles.base, style]}
      allowFontScaling={false}
      testID={testID}
      numberOfLines={singleLine ? 1 : undefined}
      ellipsizeMode={singleLine ? 'tail' : undefined}
      {...props}
    >
      {children}
    </Text>
  )
}
