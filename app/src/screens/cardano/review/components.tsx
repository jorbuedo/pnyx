/**
 * Shared review sub-components: a titled section, a labelled key/value row, an
 * asset line (image + signed amount + fiat), and a copyable mono id. The section
 * header and the key/value rows compose the shared {@link SectionHeader} /
 * {@link DataRow} primitives so review rows read identically to the rest of the
 * app. `AssetLine` stays bespoke: a token image + a direction-coloured signed
 * amount + fiat, kept flush with the DataRows in the same card.
 *
 * @module
 */

import type {AddressRef, ReviewedAmount} from '@pnyx/tx-review'
import type {ReactNode} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Address} from '../../../components/Address'
import {Copiable} from '../../../components/Copiable'
import {DataRow} from '../../../components/Row'
import {SectionHeader} from '../../../components/SectionHeader'
import {TokenIcon} from '../../../components/TokenIcon'
import {Typography} from '../../../components/Typography'
import {useI18n} from '../../../providers'
import {useEnrichment} from './enrichment'
import {truncateMiddle} from './format'

const styles = StyleSheet.create(({spacing, colors}) => ({
  section: {gap: spacing.spacing8, paddingVertical: spacing.spacing8},
  assetLine: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8, paddingVertical: spacing.spacing4},
  assetIcon: {borderRadius: spacing.spacing12},
  assetText: {flex: 1},
  amountCol: {alignItems: 'flex-end'},
  positive: {color: colors.successDefault},
  negative: {color: colors.textDefault},
  fiat: {color: colors.textAlternative},
  mono: {color: colors.textDefault},
}))

export const Section = ({
  title,
  rightSlot,
  children,
}: {
  readonly title: string
  readonly rightSlot?: ReactNode
  readonly children: ReactNode
}) => (
  <View style={styles.section}>
    <SectionHeader title={title} {...(rightSlot === undefined ? {} : {rightSlot})} />
    {children}
  </View>
)

export const KeyValueRow = ({
  label,
  value,
  mono,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) => (
  <DataRow
    label={label}
    size="md"
    value={
      mono ? (
        <Typography variant="bodySm_regular" style={styles.mono}>
          {truncateMiddle(value)}
        </Typography>
      ) : (
        value
      )
    }
  />
)

/**
 * An address in a review row, with everything the review knows about it behind
 * the tap: derivation path, payment + stake credentials, the reward address it
 * delegates through, and whether it is a contract.
 */
export const ReviewAddress = ({address}: {readonly address: AddressRef}) => {
  const {t} = useI18n()
  const {inspect} = useEnrichment()
  const i = inspect(address)
  return (
    <Address
      address={address.bech32 ?? address.hex}
      {...(i.derivationPath !== undefined && {derivationPath: i.derivationPath})}
      {...(i.spendingKey !== undefined && {spendingKey: i.spendingKey})}
      {...(i.stakingKey !== undefined && {stakingKey: i.stakingKey})}
      {...(i.rewardAddress !== undefined && {rewardAddress: i.rewardAddress})}
      {...(i.isScript !== undefined && {isScript: i.isScript})}
      {...(i.knownScript !== undefined && {knownLabel: t(`txReview.knownScripts.${i.knownScript}` as never)})}
    />
  )
}

/** A copyable full id (mono), middle-truncated for display. */
export const CopyableId = ({label, value}: {readonly label: string; readonly value: string}) => (
  <DataRow
    label={label}
    size="md"
    value={
      <Copiable text={value}>
        <Typography variant="bodySm_regular" style={styles.mono}>
          {truncateMiddle(value)}
        </Typography>
      </Copiable>
    }
  />
)

/** One asset amount: token image + signed crypto amount + fiat under it. */
export const AssetLine = ({
  amount,
  showSign = true,
}: {
  readonly amount: ReviewedAmount
  readonly showSign?: boolean
}) => {
  const {describe} = useEnrichment()
  const d = describe(amount)
  const cryptoText = showSign ? d.cryptoText : d.amountText
  // A UTxO row states a balance, not a delta: `+€33` on an input being spent was
  // claiming a gain.
  const fiatText = showSign ? d.fiatText : d.fiatAmountText
  return (
    <View style={styles.assetLine}>
      <TokenIcon assetId={d.assetId ?? ''} label={d.ticker} size={28} />
      <View style={styles.assetText}>
        <Typography variant="bodyMd_medium">{d.ticker}</Typography>
      </View>
      <View style={styles.amountCol}>
        <Typography
          variant="bodyMd_medium"
          style={amount.quantity > 0n && showSign ? styles.positive : styles.negative}
        >
          {cryptoText}
        </Typography>
        {fiatText !== null ? (
          <Typography variant="bodySm_regular" style={styles.fiat}>
            {fiatText}
          </Typography>
        ) : null}
      </View>
    </View>
  )
}
