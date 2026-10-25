/**
 * QuickAction — a chamfered action button stacking its icon above its label, and
 * QuickActions, the row that lays several of them out. The wallet's primary
 * Send / Receive (/ Swap …) actions on the Wallets home and the Cardano portfolio.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground, HIGHLIGHT_BRACKETS} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon, type UniIconName} from './UniIcon'

export type QuickActionItem = {
  readonly key: string
  readonly icon: UniIconName
  readonly label: string
  readonly onPress: () => void
  /** Optional long-press shortcut (e.g. Receive long-press copies the address). */
  readonly onLongPress?: (() => void) | undefined
  readonly testID?: string | undefined
}

export type QuickActionProps = Omit<QuickActionItem, 'key'>

export const QuickAction = ({icon, label, onPress, onLongPress, testID}: QuickActionProps): ReactElement => (
  <Pressable
    style={({pressed}) => [styles.action, pressed && styles.pressed]}
    onPress={onPress}
    onLongPress={onLongPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    testID={testID}
  >
    {/* Brackets are **additive** — the surface stays. Tried naked first and it does not read as a
          button: with no fill the arms float either side of the icon rather than enclosing it, and
          there is no tap affordance left. The same is true of the cards this borrows from, where a
          highlighted one keeps its card background and gains brackets on top.
          Tokens rather than resolved colours, so Unistyles paints the `Path` and this component keeps
          the native theme update instead of re-rendering in JS on every `setTheme`. */}
    <ChamferBackground size="auto" fillToken="backgroundAlternative" brackets={HIGHLIGHT_BRACKETS} />
    <UniIcon name={icon} width={26} height={26} uniProps={(t) => ({color: t.colors.textDefault})} />
    <Typography variant="bodyMd_medium" style={styles.label} numberOfLines={1}>
      {label}
    </Typography>
  </Pressable>
)

export type QuickActionsProps = {
  readonly actions: readonly QuickActionItem[]
}

export const QuickActions = ({actions}: QuickActionsProps): ReactElement => (
  <View style={styles.row}>
    {actions.map(({key, ...action}) => (
      <QuickAction key={key} {...action} />
    ))}
  </View>
)

const styles = StyleSheet.create((theme) => ({
  // Full width so the actions divide the row evenly; without it the row shrinks to
  // its content and the labels truncate.
  row: {flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.spacing12, width: '100%'},
  action: {
    flex: 1,
    // Fills the row on a phone, but stops the actions sprawling on a tablet.
    maxWidth: 84,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.spacing4,
    paddingVertical: theme.spacing.spacing8,
    paddingHorizontal: theme.spacing.spacing4,
  },
  pressed: {opacity: 0.7, transform: [{scale: 0.95}]},
  label: {color: theme.colors.textDefault},
}))
