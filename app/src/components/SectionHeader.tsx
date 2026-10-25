/**
 * SectionHeader — an uppercase muted section title with an optional
 * right-aligned link (e.g. "See all"). Pairs with a Card/list of rows for
 * content sections such as the Wallets-home portfolio and recent-activity
 * blocks. For settings-style grouped lists use {@link SettingsGroup}, which
 * bundles its own header; reach for SectionHeader when the section needs a
 * trailing call-to-action.
 *
 * Pass `collapse` to make the section foldable: the whole header becomes the
 * hit target and a chevron leads the title, so two sections on one screen fold
 * the same way and still read as siblings.
 *
 * @module
 */

import type {ReactElement, ReactNode} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferSurface} from './Chamfer'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

export type SectionHeaderLink = {
  readonly label: string
  readonly onPress: () => void
  readonly testID?: string | undefined
}

export type SectionHeaderCollapse = {
  readonly isCollapsed: boolean
  readonly onToggle: () => void
  /** Announced to a screen reader — the header is a button, so it needs to say what it does. */
  readonly accessibilityLabel: string
  readonly testID?: string | undefined
}

export type SectionHeaderProps = {
  /** Omit to keep the row (so a trailing slot stays right-aligned) with no band. */
  readonly title?: string | undefined
  readonly link?: SectionHeaderLink | undefined
  /** Muted right-aligned text (e.g. a count). Ignored when `link` is set. */
  readonly trailingText?: string | undefined
  /** Arbitrary trailing content, when neither a link nor plain text fits. */
  readonly rightSlot?: ReactNode | undefined
  /** When set, the header folds its section. */
  readonly collapse?: SectionHeaderCollapse | undefined
}

export const SectionHeader = ({title, link, trailingText, rightSlot, collapse}: SectionHeaderProps): ReactElement => {
  const body = (
    <>
      {title === undefined ? (
        <View />
      ) : (
        <ChamferSurface size={0} cut="slashEnd" fillToken="backgroundAlternative" style={styles.titleGroup}>
          {collapse !== undefined && (
            <UniIcon
              name={collapse.isCollapsed ? 'chevronRight' : 'chevronDown'}
              size="sm"
              uniProps={(theme) => ({color: theme.colors.textMuted})}
            />
          )}
          {/* ⚠️ `singleLine`, always. A section title is a short label, and a wrapped
              one breaks out of the chamfer tab drawn behind it — which happened to
              whichever header was mounted *after* the first layout pass, not to the
              longest text, because a Text's wrap is baked at measure time. */}
          <Typography variant="bodySm_medium" singleLine style={styles.title}>
            {title}
          </Typography>
        </ChamferSurface>
      )}
      {link ? (
        <Pressable onPress={link.onPress} hitSlop={8} testID={link.testID}>
          <Typography variant="bodySm_medium" style={styles.link}>
            {link.label}
          </Typography>
        </Pressable>
      ) : trailingText !== undefined ? (
        <Typography variant="bodySm_medium" style={styles.trailing}>
          {trailingText}
        </Typography>
      ) : (
        (rightSlot ?? null)
      )}
    </>
  )

  return collapse === undefined ? (
    <View style={styles.header}>{body}</View>
  ) : (
    <Pressable
      onPress={collapse.onToggle}
      style={styles.header}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{expanded: !collapse.isCollapsed}}
      accessibilityLabel={collapse.accessibilityLabel}
      testID={collapse.testID}
    >
      {body}
    </Pressable>
  )
}

const styles = StyleSheet.create((theme) => ({
  // The trailing action stops where the card below starts its cut, rather than at
  // the card's nominal edge — `chamferSizeForHeight` caps at 12, which is what any
  // card-sized surface takes off its top-right corner.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: theme.spacing.spacing12,
  },
  // A full-height slash consumes its own height in width, so the right padding
  // has to clear the diagonal *before* it starts giving the text any room —
  // spacing40 is roughly the ~24pt band plus a spacing16 gap.
  titleGroup: {
    flexDirection: 'row',
    // So a long title truncates inside the tab instead of forcing the row wider
    // than the surface it sits on.
    flexShrink: 1,
    alignItems: 'center',
    gap: theme.spacing.spacing4,
    paddingLeft: theme.spacing.spacing12,
    paddingRight: theme.spacing.spacing40,
    paddingVertical: theme.spacing.spacing6,
  },
  title: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '600',
  },
  link: {color: theme.colors.primaryDefault},
  trailing: {color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '600'},
}))
