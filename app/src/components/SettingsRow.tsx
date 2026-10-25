/**
 * SettingsRow component.
 *
 * The settings-flavoured vocabulary over {@link Row}: `description` rather than
 * `subtitle`, `showBorder` rather than `withBorder`, and `children` for the right
 * slot. It maps onto Row rather than re-implementing the row anatomy, so padding,
 * border, press feedback and typography stay defined in one place.
 *
 * Unlike a list row, a settings description wraps — the copy explains a setting
 * and truncating it loses the explanation.
 *
 * @module
 */

import type {ReactElement, ReactNode} from 'react'

import type {NewColorTokens} from '../theme/tokens'
import {Row} from './Row'
import type {UniIconName} from './UniIcon'

export type SettingsRowProps = {
  label: string
  description?: string | undefined
  leftIcon?: UniIconName | undefined
  /** Arbitrary left content, when an icon name is not enough. */
  leftSlot?: ReactNode | undefined
  /** Rendered beside the label, on the same line. */
  labelAccessory?: ReactNode | undefined
  /** Right-hand content: a toggle, a value, a chevron. */
  children?: ReactNode | undefined
  onPress?: (() => void) | undefined
  showBorder?: boolean | undefined
  testID?: string | undefined
  iconColor?: keyof NewColorTokens | null | undefined
  size?: 'md' | 'lg'
  /** Paints the label in the error colour, and tints `leftIcon` to match. */
  destructive?: boolean | undefined
}

export const SettingsRow = ({
  label,
  description,
  leftIcon,
  leftSlot,
  labelAccessory,
  children,
  onPress,
  showBorder = false,
  testID,
  iconColor = 'iconDefault',
  size = 'md',
  destructive = false,
}: SettingsRowProps): ReactElement => (
  <Row
    label={label}
    subtitle={description}
    leftContent={leftSlot}
    leftIcon={leftIcon}
    iconColor={destructive ? 'errorDefault' : iconColor}
    labelAccessory={labelAccessory}
    rightContent={children}
    onPress={onPress}
    withBorder={showBorder}
    size={size}
    destructive={destructive}
    singleLine={false}
    testID={testID}
  />
)
