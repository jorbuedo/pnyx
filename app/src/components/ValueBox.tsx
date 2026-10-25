/**
 * A long, exact value shown in full — an address, an `pnyx_id`, a backup link.
 *
 * The point is legibility of something the user may need to *compare character by character*, which
 * is why the value is boxed, centred and letter-spaced rather than set in monospace: a bech32 string
 * wrapping mid-token in body text is unreadable, and the app ships no mono face.
 *
 * One box for every such value. This started as three styles inside `ReceiveScreen`; the Id tab
 * needed the same treatment, and copying them would have been the fork
 * `CLAUDE.md` → "Standardization rule" warns about.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {useCopy} from '../providers/CopyProvider'
import {ChamferBackground} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

export type ValueBoxProps = {
  /** Rendered verbatim and never truncated — the caller chose this surface to show all of it. */
  readonly value: string
  /** Optional caption above the box; upper-cased by the style, so pass it in normal case. */
  readonly label?: string
  /**
   * Turns the box into a copy target: the whole box presses, and a copy icon marks it as one.
   *
   * Opt-in, because the affordance has to be *visible* to exist — a box that silently copies is a
   * box nobody presses. What lands on the clipboard is `value` itself; there is no separate text to
   * get out of step with what is on screen.
   */
  readonly copyFeedback?: string
  readonly testID?: string
}

export const ValueBox = ({value, label, copyFeedback, testID}: ValueBoxProps) => {
  const {theme} = useUnistyles()
  const {copiedText, copy} = useCopy()

  const surface = (
    <>
      <ChamferBackground
        size="auto"
        fill={theme.colors.backgroundAlternative}
        borderColor={theme.colors.borderDefaultWeak}
        borderWidth={theme.borderWidth.s}
      />
      {copyFeedback === undefined ? (
        <Typography variant="bodyXs_regular" style={styles.text} testID={testID}>
          {value}
        </Typography>
      ) : (
        <View style={styles.copyRow}>
          {/* The icon's width, mirrored on the leading edge: the value stays centred in the box
              rather than in what is left of it. */}
          <View style={styles.iconSpacer} />
          <Typography variant="bodyXs_regular" style={styles.copyText} testID={testID}>
            {value}
          </Typography>
          <UniIcon
            name={copiedText === value ? 'copyFilled' : 'copy'}
            size="sm"
            uniProps={(t) => ({color: copiedText === value ? t.colors.successDefault : t.colors.iconDefault})}
          />
        </View>
      )}
    </>
  )

  return (
    <View style={styles.block}>
      {label !== undefined && (
        <Typography variant="bodyXs_medium" style={styles.label}>
          {label}
        </Typography>
      )}
      {copyFeedback === undefined ? (
        <View style={styles.box}>{surface}</View>
      ) : (
        <Pressable style={styles.box} onPress={(event) => copy({text: value, event, feedback: copyFeedback})}>
          {surface}
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  block: {
    width: '100%',
    gap: theme.spacing.spacing8,
    // Centred to match the caption's original placement in ReceiveScreen, which this replaced.
    alignItems: 'center',
  },
  label: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  box: {
    width: '100%',
    padding: theme.spacing.spacing16,
  },
  text: {
    color: theme.colors.textAlternative,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  copyRow: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing8},
  iconSpacer: {width: 20},
  copyText: {
    flex: 1,
    color: theme.colors.textAlternative,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
}))
