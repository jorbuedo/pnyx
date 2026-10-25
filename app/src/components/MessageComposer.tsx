/**
 * The shared message composer: a multiline input plus a send button, as a sticky footer.
 *
 * One implementation for the community channel and the DM thread, per the standardization rule.
 * Extracted from `app/community/[id]/[channel].tsx`, so it keeps that screen's hard-won details:
 * the footer owns the bottom safe-area inset (`SafeAreaViewWrapper` drops its `bottom` edge
 * whenever a `stickyFooter` is set, and no tab bar sits under these screens), and the send button
 * carries a hit slop so it stays comfortably tappable at the screen edge.
 *
 * The reply bar is *not* part of this component — replies are a channel concept. Anything a caller
 * needs above the input row goes through {@link MessageComposerProps.above}, which keeps the
 * variation in the caller rather than forking the component.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'
import {ButtonIcon} from './Buttons'
import {ChamferBackground} from './Chamfer'
import {TextInputBase} from './TextInputBase'

const ComposerInput = withUnistyles(TextInputBase, (theme) => ({
  placeholderTextColor: theme.colors.textMuted,
}))

export type MessageComposerProps = {
  readonly value: string
  readonly onChangeText: (value: string) => void
  readonly onSend: () => void
  readonly placeholder: string
  /** Accessibility label for the send button — threaded from a caller that has `t`. */
  readonly sendLabel: string
  readonly isSending: boolean
  /** Rendered above the input row (e.g. the channel's reply bar). */
  readonly above?: ReactNode
  readonly testIDPrefix?: string
}

export function MessageComposer({
  value,
  onChangeText,
  onSend,
  placeholder,
  sendLabel,
  isSending,
  above,
  testIDPrefix = 'composer',
}: MessageComposerProps) {
  return (
    <View style={styles.composer}>
      {above}
      <View style={styles.composerRow}>
        <View style={styles.composerInputWrap}>
          <ChamferBackground size="auto" fillToken="backgroundAlternative" />
          <ComposerInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            style={styles.composerInput}
            multiline
            maxLength={10_000}
            testID={`${testIDPrefix}-input`}
          />
        </View>
        <ButtonIcon
          icon="send"
          variant="primary"
          size="lg"
          hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
          onPress={onSend}
          isDisabled={value.trim().length === 0 || isSending}
          isLoading={isSending}
          containerProps={{accessibilityLabel: sendLabel}}
          testID={`${testIDPrefix}-send`}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  composer: {
    backgroundColor: theme.colors.backgroundDefault,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderDefaultWeak,
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing8,
    paddingBottom: rt.insets.bottom + theme.spacing.spacing8,
    gap: theme.spacing.spacing8,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing.spacing8,
  },
  composerInputWrap: {
    flex: 1,
    maxHeight: 120,
  },
  composerInput: {
    color: theme.colors.textDefault,
    backgroundColor: 'transparent',
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing8,
    maxHeight: 120,
  },
}))
