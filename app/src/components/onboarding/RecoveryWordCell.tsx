/**
 * Single cell in the recovery-phrase grid: a numbered, lowercased word input
 * with an error-aware border. Keyboard semantics (Backspace fall-through,
 * Enter autocomplete) are forwarded to the parent — see `useRecoveryPhraseInput`.
 *
 * @module
 */

import {type NativeSyntheticEvent, TextInput as RNTextInput, type TextInputKeyPressEventData, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {platformIsAndroid} from '../../platform'
import {ChamferBackground} from '../Chamfer'
import {Typography} from '../Typography'

const COLUMNS = 3
/** Eyebrow / segmented-control measurements. */
const CELL_NUMBER_TOP_PX = 14
const CELL_NUMBER_LEFT_PX = 12
const CELL_INPUT_HEIGHT_PX = 44
const CELL_INPUT_PADDING_LEFT_PX = 28

export type RecoveryWordCellProps = {
  index: number
  value: string
  /** True iff the committed value is non-empty and not in the BIP-39 wordlist. */
  hasError: boolean
  /** True only for cell 1 — opens the keyboard on screen mount. */
  autoFocus?: boolean
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
  /** Fired on Enter/Return — used to autocomplete a partial word + advance focus. */
  onSubmit: () => void
  /** Forwarded so the parent can detect Backspace-on-empty and jump focus. */
  onKeyPress: (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => void
  registerRef: (ref: RNTextInput | null) => void
  testID: string
}

export const RecoveryWordCell = ({
  index,
  value,
  hasError,
  autoFocus = false,
  onChange,
  onFocus,
  onBlur,
  onSubmit,
  onKeyPress,
  registerRef,
  testID,
}: RecoveryWordCellProps) => {
  styles.useVariants({error: hasError})
  return (
    <View style={styles.cell}>
      <View style={styles.inputSurface} pointerEvents="none">
        <ChamferBackground
          size="auto"
          fillToken="backgroundAlternativeHover"
          borderToken={hasError ? 'errorDefault' : 'borderInteractive'}
          borderWidth={1}
        />
      </View>
      <Typography variant="bodyXs_regular" style={styles.number}>
        {index + 1}
      </Typography>
      <RNTextInput
        ref={registerRef}
        value={value}
        onChangeText={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onSubmitEditing={onSubmit}
        onKeyPress={onKeyPress}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType={platformIsAndroid ? 'visible-password' : 'default'}
        returnKeyType="next"
        // No `maxLength` here — the per-cell length cap is applied in JS by
        // `handleWordChange`. Setting `maxLength` causes the underlying HTML
        // input on web/extension to truncate a full mnemonic paste BEFORE our
        // multi-word-distribution code can see it.
        style={styles.input}
        testID={testID}
      />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  cell: {
    width: `${100 / COLUMNS}%`,
    paddingRight: theme.spacing.spacing8,
    position: 'relative',
  },
  number: {
    position: 'absolute',
    top: CELL_NUMBER_TOP_PX,
    left: CELL_NUMBER_LEFT_PX,
    zIndex: 1,
    variants: {
      error: {
        true: {color: theme.colors.errorDefault},
        false: {color: theme.colors.textMuted},
      },
    },
  },
  // The surface sits in its own layer: a chamfer cannot be painted behind the
  // glyphs of a TextInput, which draws its own background.
  //
  // That layer is absolutely positioned, and on web such a box paints over its in-flow
  // siblings whatever the DOM order — which hid the typed word behind the fill. The
  // paint layer's own `zIndex: -1` cannot escape this wrapper, so the input is raised
  // instead. A View sibling would not have needed it: react-native-web positions those.
  inputSurface: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: CELL_INPUT_HEIGHT_PX,
  },
  input: {
    height: CELL_INPUT_HEIGHT_PX,
    zIndex: 1,
    paddingLeft: CELL_INPUT_PADDING_LEFT_PX,
    paddingRight: theme.spacing.spacing12,
    fontFamily: theme.textVariants.bodyMd_medium.fontFamily,
    fontSize: theme.textVariants.bodyMd_medium.fontSize,
    backgroundColor: 'transparent',
    color: theme.colors.textDefault,
  },
}))
