/**
 * One asset and its amount on a single line: token identity on the left, the
 * figure right-aligned on the same baseline.
 *
 * The canonical amount-entry row — swap and the send funnel's allocation step
 * both use it. The floating-label `TextInput` is wrong here: it stacks its label
 * above the field, so a per-asset row rendered "tADA" on one line and the value
 * on the next, reading as two broken controls rather than one.
 *
 * Pass `onPressToken` when the asset is selectable (swap); omit it when the asset
 * is fixed (allocation), and the left side renders as plain text with no
 * affordance to press.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'
import {TextInputBase} from './TextInputBase'
import {TokenIcon} from './TokenIcon'
import {Typography} from './Typography'
import {UniIcon} from './UniIcon'

/**
 * A bare figure rather than a boxed input — the placeholder colour has to come
 * through a prop because it lands on a native TextInput prop, not a style.
 */
const AmountInput = withUnistyles(TextInputBase, (theme) => ({
  placeholderTextColor: theme.colors.textAlternative,
}))

export type AssetAmountRowProps = {
  /** Asset id for the icon; `''` for ADA. */
  readonly assetId: string
  /** Ticker or label shown next to the icon. */
  readonly label: string
  readonly value: string
  readonly onChangeText: (value: string) => void
  readonly placeholder?: string
  /** A line under the figure — fiat value, or a remaining/limit hint. */
  readonly subLabel?: string
  /** Makes the token side a picker. Omit for a fixed asset. */
  readonly onPressToken?: () => void
  readonly editable?: boolean
  readonly testID?: string
  readonly tokenTestID?: string
}

export const AssetAmountRow = ({
  assetId,
  label,
  value,
  onChangeText,
  placeholder = '0',
  subLabel,
  onPressToken,
  editable = true,
  testID,
  tokenTestID,
}: AssetAmountRowProps) => {
  const token = (
    <>
      <TokenIcon assetId={assetId} label={label} size={28} />
      <Typography variant="bodyMd_medium">{label}</Typography>
      {onPressToken !== undefined ? (
        <UniIcon name="rightThin" width={12} height={12} uniProps={(theme) => ({color: theme.colors.textMuted})} />
      ) : null}
    </>
  )

  return (
    <View style={styles.row}>
      {onPressToken !== undefined ? (
        <Pressable style={styles.token} onPress={onPressToken} testID={tokenTestID}>
          {token}
        </Pressable>
      ) : (
        <View style={styles.token}>{token}</View>
      )}
      <View style={styles.amountCol}>
        <AmountInput
          placeholder={placeholder}
          value={value}
          onChangeText={onChangeText}
          keyboardType="decimal-pad"
          textAlign="right"
          editable={editable}
          style={styles.amountInput}
          testID={testID}
        />
        {subLabel !== undefined ? (
          <Typography variant="bodyXs_regular" style={styles.subLabel}>
            {subLabel}
          </Typography>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create(({spacing, colors, fontSizes, fontFamily}) => ({
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.spacing12},
  token: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8, flexShrink: 0},
  amountCol: {flex: 1, alignItems: 'flex-end'},
  amountInput: {
    fontSize: fontSizes.headingSm,
    fontFamily: fontFamily.semiBold,
    color: colors.textDefault,
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingVertical: 0,
    minWidth: 80,
    textAlign: 'right',
  },
  subLabel: {color: colors.textMuted},
}))
