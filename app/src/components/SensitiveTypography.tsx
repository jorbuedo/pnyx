/**
 * SensitiveTypography — Typography that swaps its content for the privacy
 * placeholder (length-matched bullets, see `privacy-placeholder.ts`) when
 * privacy mode is on.
 *
 * Use at every call site that renders a fiat or crypto amount, address, or
 * any other value that should respect the global eye toggle. API mirrors
 * `Typography` — drop-in replacement, no extra props.
 *
 * @module
 */

import {usePrivacyMode} from '../hooks/usePrivacyMode'
import {flattenToString} from './sensitive-typography-flatten'
import {Typography, type TypographyProps} from './Typography'

export type SensitiveTypographyProps = TypographyProps

export const SensitiveTypography = ({children, ...rest}: SensitiveTypographyProps) => {
  const {isEnabled: isPrivacy, getPlaceholder} = usePrivacyMode()

  const masked = isPrivacy ? getPlaceholder(flattenToString(children)) : children

  return <Typography {...rest}>{masked}</Typography>
}
