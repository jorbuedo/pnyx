/**
 * Copiable wrapper component.
 *
 * Wraps content with copy-to-clipboard functionality and visual feedback.
 * Shows a copy icon that toggles to a success icon while copying.
 *
 * @module
 */

import * as React from 'react'
import {Text, TouchableOpacity, View, type ViewStyle} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {useCopy} from '../providers/CopyProvider'
import {UniIcon} from './UniIcon'

export type CopiableProps = {
  /** Text to copy to clipboard */
  text: string
  /** Optional label displayed on the left */
  title?: string
  /**
   * How much of the row the label takes, against the value's `1`. Default `1` — an even split.
   *
   * Opt-in so a caller can give a long value more room without moving every other labelled row in the
   * app. ⚠️ A caller that also renders a *sibling* row by hand has to use the same number, or the two
   * stop lining up.
   */
  titleFlex?: number
  /** Content to display (before the copy button) */
  children?: React.ReactNode
  /** Optional style override for the container */
  style?: ViewStyle
  /** Optional feedback message for the copy toast */
  feedback?: string
  /** Callback fired after successful copy */
  onCopy?: () => void
  /** Optional press handler for the content area */
  onPress?: () => void
  /** Icon size (default: 20) */
  iconSize?: number
  /**
   * Replaces the copy button at the end of the row.
   *
   * For a row whose trailing action is something other than copying — the ID tab's name row offers
   * *claiming* the name while it is unclaimed, which is the action worth a tap there. A prop rather
   * than a second component, so one row layout keeps serving every labelled value in the app.
   *
   * It owns its own metrics: the copy button's 24×24 icon box is not applied, because what replaces
   * it is not necessarily an icon.
   */
  trailing?: React.ReactNode
  /** Test ID forwarded to the copy button, or to {@link trailing} when one is given. */
  testID?: string
}

/**
 * Wrapper component that makes content copyable.
 *
 * Layout: [Title] [Children] [Copy Icon]
 *
 * @example
 * ```tsx
 * <Copiable text={address} feedback="Address copied!">
 *   <Text>{truncatedAddress}</Text>
 * </Copiable>
 * ```
 */
export const Copiable = ({
  children,
  style,
  text,
  title,
  titleFlex,
  feedback,
  onCopy,
  onPress,
  iconSize = 20,
  trailing,
  testID,
}: CopiableProps) => {
  const {copiedText, copy} = useCopy()

  const handleCopy = React.useCallback(
    (event: import('react-native').GestureResponderEvent) => {
      copy({text, event, ...(feedback !== undefined && {feedback})})
      onCopy?.()
    },
    [copy, text, feedback, onCopy],
  )

  return (
    <View style={[styles.container, style]}>
      {title !== undefined && (
        <View style={[styles.titleContainer, titleFlex !== undefined && {flex: titleFlex}]}>
          <Text style={styles.title}>{title}</Text>
        </View>
      )}

      {children === undefined ? null : onPress ? (
        <TouchableOpacity onPress={onPress} activeOpacity={0.5} style={styles.childrenPressable}>
          {children}
        </TouchableOpacity>
      ) : (
        <View style={styles.childrenContainer}>{children}</View>
      )}

      {trailing !== undefined ? (
        <View testID={testID}>{trailing}</View>
      ) : (
        <TouchableOpacity onPress={handleCopy} activeOpacity={0.5} style={styles.copyButton} testID={testID}>
          {copiedText === text ? (
            <UniIcon
              name="copyFilled"
              width={iconSize}
              height={iconSize}
              uniProps={(theme) => ({color: theme.colors.successDefault})}
            />
          ) : (
            <UniIcon
              name="copy"
              width={iconSize}
              height={iconSize}
              uniProps={(theme) => ({color: theme.colors.iconDefault})}
            />
          )}
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  titleContainer: {
    flex: 1,
  },
  title: {
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.regular,
    color: theme.colors.textAlternative,
  },
  childrenContainer: {
    flex: 1,
  },
  childrenPressable: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.spacing.spacing8,
  },
  // 24×24 box around the 20px glyph — keep in sync with ButtonIcon's `sm`
  // metrics so trailing icon columns (copy under QR/trash) align vertically.
  copyButton: {
    padding: theme.spacing.spacing2,
  },
}))
