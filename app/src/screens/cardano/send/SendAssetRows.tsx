/**
 * The send flow's asset rows: token icon, label, amount, fiat, and a way to drop a token.
 *
 * Lifted out of `AmountsHubScreen` when compose mode needed the same rows *per funding
 * wallet*. Two copies would have been two answers to "what does an amount row look like",
 * and the copy I first wrote in the accordion — a bare text input with a hardcoded width —
 * was visibly not the same component. One implementation, a `values` prop, and the
 * accordion gets token icons and fiat for free.
 *
 * Amounts are read, never written here: tapping a row opens the amount editor, which is
 * the one place a figure is typed.
 *
 * @module
 */

import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Card} from '../../../components/Card'
import {Row} from '../../../components/Row'
import {SensitiveTypography} from '../../../components/SensitiveTypography'
import {TokenIcon} from '../../../components/TokenIcon'
import {Typography} from '../../../components/Typography'
import {UniIcon} from '../../../components/UniIcon'
import {useFormat, useI18n} from '../../../providers'
import {ADA_ID} from './state'

export type SendAssetRowsProps = {
  /** Asset id → quantity, in the asset's own base units. */
  readonly amounts: ReadonlyMap<string, bigint>
  /** Assets showing "Max" instead of a figure. Absent in compose mode, which has no send-all. */
  readonly sendAll?: ReadonlySet<string> | undefined
  readonly decimalsOf: (assetId: string) => number
  readonly labelOf: (assetId: string) => string
  /** Fiat for a quantity, or `null` when there is none to show. */
  readonly fiatOf?:
    | ((assetId: string, quantity: bigint, decimals: number) => {value: number; currency: string} | null)
    | undefined
  readonly onEdit: (assetId: string) => void
  /** Absent hides the remove affordance — ADA is never removable either way. */
  readonly onRemove?: ((assetId: string) => void) | undefined
  readonly testIDPrefix: string
}

export const SendAssetRows = ({
  amounts,
  sendAll,
  decimalsOf,
  labelOf,
  fiatOf,
  onEdit,
  onRemove,
  testIDPrefix,
}: SendAssetRowsProps) => {
  const {t} = useI18n()
  const format = useFormat()
  const assetIds = [...amounts.keys()]

  return (
    <Card>
      {assetIds.map((assetId, i) => {
        const decimals = decimalsOf(assetId)
        const quantity = amounts.get(assetId) ?? 0n
        const isMax = sendAll?.has(assetId) === true
        const fiat = quantity > 0n ? (fiatOf?.(assetId, quantity, decimals) ?? null) : null
        return (
          <Row
            key={assetId}
            withBorder={i < assetIds.length - 1}
            onPress={() => onEdit(assetId)}
            testID={`${testIDPrefix}-${assetId}`}
            leftContent={<TokenIcon assetId={assetId} label={labelOf(assetId)} size={36} />}
            label={labelOf(assetId)}
            rightContent={
              <View style={styles.right}>
                <View style={styles.amountCol}>
                  {isMax ? (
                    <Typography variant="bodyMd_medium" style={styles.maxTag}>
                      {t('cardanoSend.max')}
                    </Typography>
                  ) : (
                    <SensitiveTypography variant="bodyMd_medium">
                      {format(quantity, {preset: 'cryptoBalance', currency: labelOf(assetId), decimals})}
                    </SensitiveTypography>
                  )}
                  {fiat !== null && (
                    <SensitiveTypography variant="bodyXs_regular" style={styles.fiat}>
                      {format(fiat.value, {preset: 'fiatBalance', currency: fiat.currency})}
                    </SensitiveTypography>
                  )}
                </View>
                {/* ADA is never removable: a send with no ADA row has no amount at all. */}
                {assetId !== ADA_ID && onRemove !== undefined ? (
                  <Pressable hitSlop={8} onPress={() => onRemove(assetId)} testID={`${testIDPrefix}-remove-${assetId}`}>
                    <UniIcon
                      name="close"
                      width={16}
                      height={16}
                      uniProps={(theme) => ({color: theme.colors.iconDefault})}
                    />
                  </Pressable>
                ) : (
                  <UniIcon
                    name="chevronRight"
                    width={16}
                    height={16}
                    uniProps={(theme) => ({color: theme.colors.iconDefault})}
                  />
                )}
              </View>
            }
          />
        )
      })}
    </Card>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  right: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing12},
  amountCol: {alignItems: 'flex-end'},
  fiat: {color: colors.textAlternative},
  maxTag: {color: colors.primaryDefault},
}))
