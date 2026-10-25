/**
 * BalanceBlock — the wallet balance hero: an uppercase label matching
 * SectionHeader's size, a large
 * fit-to-width amount, and an optional fiat sub-line. Shared by the Wallets-tab
 * home and the Cardano portfolio.
 *
 * Amount + fiat render through {@link SensitiveTypography} so they honour the
 * global privacy (hide-numbers) toggle. Pass `onTogglePrivacy` to surface an
 * eye button next to the label (Wallets home); omit it for a static hero
 * (Portfolio). `amount === null` shows a loading spinner; `unavailable` shows
 * `unavailableText` instead.
 *
 * @module
 */

import type {ReactElement} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {dotsFor} from '../hooks/privacy-placeholder'
import {useFitFontSize} from '../hooks/useFitFontSize'
import {usePrivacyMode} from '../hooks/usePrivacyMode'
import {Skeleton} from './Loaders/Skeleton'
import {SensitiveTypography} from './SensitiveTypography'
import {Typography, type TypographyProps} from './Typography'
import {UniIcon} from './UniIcon'

export type BalanceBlockProps = {
  readonly label: string
  /** Formatted primary amount; `null` renders a loading spinner. */
  readonly amount: string | null
  /** Formatted fiat sub-line; omit or `null` to hide. */
  readonly fiat?: string | null | undefined
  /** When true, renders `unavailableText` instead of the amount/spinner. */
  readonly unavailable?: boolean | undefined
  readonly unavailableText?: string | undefined
  /** Tap handler for the amount (e.g. open the portfolio). */
  readonly onPress?: (() => void) | undefined
  /** Show + wire the eye toggle next to the label. */
  readonly onTogglePrivacy?: (() => void) | undefined
  /** Accessibility label for the privacy toggle. */
  readonly togglePrivacyLabel?: string | undefined
  readonly togglePrivacyTestID?: string | undefined
  /** Amount typography variant — supplies the display font family/weight (default `displayXs`). */
  readonly amountVariant?: TypographyProps['variant'] | undefined
  /** Largest amount size, used for short numbers; shrinks from here as digits grow (default 46). */
  readonly maxAmountFontSize?: number | undefined
  /** Smallest size the amount shrinks to before it would overflow (default 24). */
  readonly minAmountFontSize?: number | undefined
  /** Test ID for the pressable amount. */
  readonly testID?: string | undefined
}

export const BalanceBlock = ({
  label,
  amount,
  fiat,
  unavailable = false,
  unavailableText,
  onPress,
  onTogglePrivacy,
  togglePrivacyLabel,
  togglePrivacyTestID,
  amountVariant = 'displayXs',
  maxAmountFontSize = 46,
  minAmountFontSize = 24,
  testID,
}: BalanceBlockProps): ReactElement => {
  // Read the toggle rather than take it as a prop: the amount masks through
  // SensitiveTypography, which reads the same context, and a prop could disagree
  // with it — sizing the text for eight dots while twelve digits render.
  const {isEnabled: isPrivate} = usePrivacyMode()

  // Size the amount off the string that actually renders: when privacy is on
  // the value is masked to a short dot placeholder (≤ 8 chars), so the fit
  // math must count the dots, not the hidden digits, or it would over-shrink.
  const displayText = amount == null ? '' : isPrivate ? dotsFor(amount) : amount
  const {fontSize, onLayout} = useFitFontSize({
    text: displayText,
    maxFontSize: maxAmountFontSize,
    minFontSize: minAmountFontSize,
  })

  const labelRow = (
    <View style={styles.labelRow}>
      <Typography variant="bodySm_medium" style={styles.label}>
        {label}
      </Typography>
      {onTogglePrivacy ? (
        <UniIcon
          name={isPrivate ? 'hide' : 'reveal'}
          width={18}
          height={18}
          uniProps={(theme) => ({color: theme.colors.textMuted})}
        />
      ) : null}
    </View>
  )

  const amountBody = (
    <>
      <SensitiveTypography
        variant={amountVariant}
        style={[styles.amount, {fontSize, lineHeight: fontSize * 1.25}]}
        numberOfLines={1}
      >
        {amount ?? ''}
      </SensitiveTypography>
      {fiat != null ? (
        <SensitiveTypography variant="bodyMd_regular" style={styles.fiat}>
          {fiat}
        </SensitiveTypography>
      ) : null}
    </>
  )

  return (
    <View style={styles.container} onLayout={onLayout}>
      {onTogglePrivacy ? (
        <Pressable
          onPress={onTogglePrivacy}
          hitSlop={8}
          accessibilityLabel={togglePrivacyLabel}
          testID={togglePrivacyTestID}
        >
          {labelRow}
        </Pressable>
      ) : (
        labelRow
      )}

      {unavailable ? (
        <Typography variant="bodyMd_regular" style={styles.muted}>
          {unavailableText}
        </Typography>
      ) : amount === null ? (
        <View style={styles.loader}>
          <Skeleton show width={148} height={32} radius={8}>
            {null}
          </Skeleton>
          <Skeleton show width={72} height={16} radius={6}>
            {null}
          </Skeleton>
        </View>
      ) : onPress ? (
        <Pressable onPress={onPress} testID={testID}>
          {amountBody}
        </Pressable>
      ) : (
        <View testID={testID}>{amountBody}</View>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: 'center',
    paddingVertical: theme.spacing.spacing12,
    gap: theme.spacing.spacing4,
  },
  labelRow: {flexDirection: 'row', alignItems: 'center', gap: theme.spacing.spacing4},
  label: {color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8},
  amount: {color: theme.colors.textDefault, textAlign: 'center'},
  fiat: {color: theme.colors.textMuted, textAlign: 'center'},
  muted: {color: theme.colors.textMuted},
  loader: {marginVertical: theme.spacing.spacing8, alignItems: 'center', gap: theme.spacing.spacing8},
}))
