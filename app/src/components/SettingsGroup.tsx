/**
 * SettingsGroup — v2 settings section wrapper.
 *
 * Layout: optional uppercase section label + content container.
 * - `variant="card"` (default) wraps children in a Card and **draws the hairline dividers itself**,
 *   between each `SettingsRow` child and the next — the consolidated list pattern used across
 *   Settings (Security, Notifications, About, Wallet Detail, etc.).
 *
 * ⚠️ **A card child's own `showBorder` is ignored, on purpose.** "Am I the last row?" is a fact about
 * siblings, and a row cannot see its siblings — so every call site had to restate the list's shape by
 * hand, and three of the Menu screen's twenty rows got it wrong: two said nothing (the prop defaults
 * to `false`, so they drew no divider) and one said `false` with a row still after it, merging two
 * entries into a block. It fails silently and only in the invisible direction, which is why it went
 * unnoticed. The group knows the order, so the group decides.
 *
 * Conditional children cost nothing here: `Children.toArray` drops `null`, so a row rendered as
 * `{flag ? <SettingsRow/> : null}` simply is not in the list, and the row before it becomes last
 * without anyone recomputing an index.
 *
 * `showBorder` stays meaningful for a `SettingsRow` used **outside** a group.
 * - `variant="stacked"` skips the outer Card and just stacks children with a
 *   small gap — for surfaces where each row is its own Card (Connected dApps).
 * - `rightSlot` renders arbitrary trailing content next to the label (e.g. a
 *   live session count).
 *
 * @module
 */

import {Children, cloneElement, isValidElement, type ReactElement, type ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Card} from './Card'
import {SectionHeader, type SectionHeaderLink} from './SectionHeader'
import {SettingsRow} from './SettingsRow'
import {dividerFlags} from './settings-group-dividers'

export type SettingsGroupProps = {
  /** Optional uppercase label rendered above the content. */
  readonly label?: string | undefined
  /** Trailing content rendered on the right of the label row (e.g. count). */
  readonly rightSlot?: ReactNode | undefined
  /** `SettingsRow` children (or any rows that match the settings-row grammar). */
  readonly children: ReactNode
  /**
   * Layout variant:
   * - `card` (default): children wrapped in a Card with dividers.
   * - `stacked`: children stacked with a small gap; each child renders its own surface.
   */
  readonly variant?: 'card' | 'stacked' | undefined
  /**
   * Trailing action in the header row, rendered the way `SectionHeader` renders every other one.
   * Prefer this over putting a `Button` in `rightSlot`: a button's minimum height inflates the row
   * past the chamfer tab, which reads as a gap between the header and the card.
   */
  readonly link?: SectionHeaderLink | undefined
  /** Test ID for e2e testing. */
  readonly testID?: string | undefined
}

/**
 * Give every `SettingsRow` a divider except the last one.
 *
 * Only rows are touched: a group may hold an empty-state `View` or a footnote, and those neither
 * want a divider nor understand the prop.
 */
const withDividers = (children: ReactNode): ReactNode => {
  const items = Children.toArray(children)
  const flags = dividerFlags(items.map(isRow))
  return items.map((child, index) => (isRow(child) ? cloneElement(child, {showBorder: flags[index] === true}) : child))
}

const isRow = (child: ReactNode): child is ReactElement<{showBorder?: boolean}> =>
  isValidElement(child) && child.type === SettingsRow

export const SettingsGroup = ({
  label,
  rightSlot,
  link,
  children,
  variant = 'card',
  testID,
}: SettingsGroupProps): ReactElement => {
  const hasHeader = label != null || rightSlot != null || link != null
  return (
    <View style={styles.wrapper} testID={testID}>
      {hasHeader ? (
        <SectionHeader {...(label ? {title: label} : {})} {...(link ? {link} : {})} rightSlot={rightSlot} />
      ) : null}
      {variant === 'card' ? (
        <Card style={styles.card}>{withDividers(children)}</Card>
      ) : (
        <View style={styles.stacked}>{children}</View>
      )}
    </View>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  wrapper: {},
  card: {
    paddingVertical: spacing.spacing4,
  },
  stacked: {
    gap: spacing.spacing8,
  },
}))
