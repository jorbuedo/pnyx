/**
 * ModalHeader component.
 *
 * Header section for Modal with title, description, and navigation buttons.
 *
 * @module
 */

import {memo, type ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {ButtonIcon, type ButtonIconVariant} from '../Buttons'
import {Typography} from '../Typography'
import {DragIndicator} from './DragIndicator'

export type ModalHeaderProps = {
  /** Modal title */
  title?: string | undefined
  /** Modal description */
  description?: string | undefined
  /** Close handler invoked when the drag indicator is tapped */
  onClose?: (() => void) | undefined
  /** Whether tapping the drag indicator closes the modal */
  dismissable?: boolean | undefined
  /** Whether to show the back button */
  showBackButton?: boolean | undefined
  /** Back button handler */
  onBack?: (() => void) | undefined
  /** Visual variant for the back button (defaults to `naked`). */
  backButtonVariant?: ButtonIconVariant | undefined
  /** Whether to show the drag indicator (for bottom sheet) */
  showDragIndicator?: boolean | undefined
  /** Horizontal alignment of the title/description block (defaults to `left`). */
  align?: 'left' | 'center' | undefined
  /**
   * Trailing control on the title line — a single icon button, not a row of them.
   * It shares the line rather than sitting above it so the sheet keeps one header
   * row; a second row costs vertical space every sheet pays for.
   */
  headerRight?: ReactNode | undefined
  /** Custom content to render in header */
  children?: ReactNode | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

/**
 * ModalHeader component.
 *
 * Renders a header section for modals with optional title, description,
 * back/close buttons, and drag indicator for bottom sheets.
 *
 * @example
 * ```tsx
 * <ModalHeader
 *   title="Confirm Transaction"
 *   description="Please review the details below"
 * />
 * ```
 */
export const ModalHeader = memo(
  ({
    title,
    description,
    onClose,
    dismissable = true,
    showBackButton = false,
    onBack,
    backButtonVariant = 'naked',
    showDragIndicator = false,
    align = 'left',
    headerRight,
    children,
    testID,
  }: ModalHeaderProps) => {
    const hasContent = title || description || children || headerRight

    if (!hasContent && !showBackButton && !showDragIndicator) {
      return null
    }

    return (
      <View style={styles.container(!!title || !!description)} testID={testID}>
        {showDragIndicator && <DragIndicator onPress={dismissable ? onClose : undefined} />}

        {showBackButton && (
          <View style={styles.navigationContainer(showDragIndicator)}>
            <View style={styles.navigation(showDragIndicator)}>
              <View style={styles.leftNav}>
                <ButtonIcon
                  icon="leftThin"
                  onPress={onBack}
                  variant={backButtonVariant}
                  size="md"
                  testID="modal-back-button"
                />
              </View>
            </View>
          </View>
        )}

        {(title || description || headerRight) && (
          <View style={styles.titleRow}>
            <View
              style={[
                styles.content(!!showBackButton || !!showDragIndicator),
                styles.titleColumn,
                align === 'center' && styles.centered,
              ]}
            >
              {title && (
                <Typography
                  variant="headingSm"
                  style={align === 'center' ? styles.centeredText : undefined}
                  testID="modal-title"
                >
                  {title}
                </Typography>
              )}
              {description && (
                <Typography
                  variant="bodyMd_regular"
                  style={[styles.description, align === 'center' && styles.centeredText]}
                  testID="modal-description"
                >
                  {description}
                </Typography>
              )}
            </View>
            {headerRight}
          </View>
        )}

        {children}
      </View>
    )
  },
)

/** `ButtonIcon size="md"` — the nav row must reserve exactly this. */
const BACK_BUTTON_SIZE = 28

const styles = StyleSheet.create(({colors, spacing}) => ({
  container: (hasTitleOrDescription: boolean) => ({
    paddingHorizontal: spacing.spacing16,
    width: '100%' as const,
    minHeight: hasTitleOrDescription ? 48 : 24,
  }),
  navigationContainer: (showDragIndicator: boolean) => ({
    // The nav row is absolutely positioned, so its own height has to be
    // reserved here or the back button lands on the title below. This box
    // already follows the drag indicator in flow, so `top: 0` starts beneath
    // it — the full button height is needed either way, only the extra top
    // offset differs. Reserving 0 here is what put the chevron on the title.
    height: showDragIndicator ? BACK_BUTTON_SIZE : spacing.spacing16 + BACK_BUTTON_SIZE,
    zIndex: 2,
  }),
  navigation: (showDragIndicator: boolean) => ({
    position: 'absolute' as const,
    top: showDragIndicator ? 0 : 16,
    left: 16,
    right: 16,
    zIndex: 2,
    flexDirection: 'row' as const,
    minHeight: 24,
  }),
  leftNav: {
    flex: 1,
    alignItems: 'flex-start' as const,
  },
  content: (hasTopContent: boolean) => ({
    minHeight: 48,
    justifyContent: 'center' as const,
    gap: spacing.spacing8,
    paddingTop: !hasTopContent ? spacing.spacing16 : 0,
  }),
  titleRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.spacing8,
  },
  // Takes the row's slack so the trailing control sits hard right and a long
  // title truncates against it rather than pushing it off the sheet.
  titleColumn: {
    flex: 1,
  },
  centered: {
    alignItems: 'center' as const,
  },
  centeredText: {
    textAlign: 'center' as const,
  },
  description: {
    color: colors.textAlternative,
  },
}))
