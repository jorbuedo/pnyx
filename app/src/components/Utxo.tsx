/**
 * A UTxO reference: the `txHash#index` that identifies one unspent output,
 * pressable to open its details (full hash, output index, what it holds, and a
 * link to the transaction that created it on an explorer).
 *
 * This is the counterpart to {@link Address} — same interaction, one
 * implementation shared by the review UTxOs tab and the UTxO list screen. The
 * amounts are passed in as nodes because each caller has its own asset-metadata
 * source.
 *
 * @module
 */

import {type ReactNode, useCallback, useState} from 'react'
import {Linking, Pressable, Text, View, type ViewStyle} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useI18n} from '../providers'
import {truncateMiddle} from '../utils/truncate'
import {Address} from './Address'
import {Button} from './Buttons'
import {Copiable} from './Copiable'
import {Modal} from './Modal'
import {Typography} from './Typography'

export type UtxoRefProps = {
  /**
   * The hash identifying this outpoint. Cardano: the transaction hash. Midnight: the **intent** hash — one
   * transaction carries several intents, so it is not the transaction and {@link hashLabelKey} says so.
   */
  readonly txHashHex: string
  /** Which label the hash is shown under, since it is not a transaction hash on every chain. */
  readonly hashLabelKey?: 'utxo.details.transaction' | 'utxo.details.intent' | undefined
  /** The output's position in that transaction/intent. */
  readonly index: number
  /**
   * Explorer page for the transaction that created this output, or `null` when there is none to offer.
   *
   * Required rather than derived here: this component is shared across chains now, and computing a Cardano
   * explorer URL by default would silently link a Midnight output to the wrong chain's explorer.
   */
  readonly explorerUrl: string | null
  /**
   * Open the in-app detail for the transaction that created this output. Absent when the chain has no such
   * screen — Midnight renders no `ReviewedTransaction`, so its outputs offer the explorer instead.
   */
  readonly onViewTransaction?: (() => void) | undefined
  /** The address holding it, shown in the details when the caller knows it. */
  readonly address?: string | undefined
  /** Derivation path of `address` — present only for our own addresses. */
  readonly derivationPath?: string | undefined
  /** What the UTxO holds, rendered by the caller (asset metadata differs per screen). */
  readonly amounts?: ReactNode
  /** Trailing row content (e.g. an amount summary in a list). */
  readonly rightAdornment?: ReactNode
  readonly style?: ViewStyle | undefined
}

/** `hash#index` for a row — kept as long as a row realistically fits. */
export const outpointLabel = (txHashHex: string, index: number): string =>
  `${truncateMiddle(txHashHex, 20, 10)}#${index}`

export const UtxoRef = ({
  txHashHex,
  hashLabelKey = 'utxo.details.transaction',
  index,
  address,
  derivationPath,
  amounts,
  rightAdornment,
  style,
  explorerUrl,
  onViewTransaction,
}: UtxoRefProps) => {
  const {t} = useI18n()
  const [visible, setVisible] = useState(false)
  const open = useCallback(() => setVisible(true), [])
  const close = useCallback(() => setVisible(false), [])

  return (
    <>
      <Pressable onPress={open} style={[styles.row, style]} accessibilityRole="button">
        <Typography variant="bodyXs_regular" style={styles.rowLabel} numberOfLines={1}>
          {outpointLabel(txHashHex, index)}
        </Typography>
        {rightAdornment}
      </Pressable>

      <Modal visible={visible} onClose={close} title={t('utxo.details.title')} position="bottom" showDragIndicator>
        <View style={styles.details}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t(hashLabelKey)}</Text>
            <Copiable text={txHashHex} feedback={t('utxo.details.transactionCopied')}>
              <Text style={styles.detailValue} numberOfLines={3}>
                {txHashHex}
              </Text>
            </Copiable>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('utxo.details.outputIndex')}</Text>
            <Text style={styles.detailValue}>{String(index)}</Text>
          </View>

          {address !== undefined ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{t('utxo.details.address')}</Text>
              {/* No nested modal: this sheet already carries the address's details. */}
              <Address address={address} showModal={false} />
            </View>
          ) : null}

          {derivationPath !== undefined ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{t('address.details.derivationPath')}</Text>
              <Text style={styles.detailValue}>{derivationPath}</Text>
            </View>
          ) : null}

          {amounts !== undefined ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>{t('utxo.details.contents')}</Text>
              {amounts}
            </View>
          ) : null}

          {/* The transaction that created this output — in the app where that screen exists, and on the
              explorer either way. Both, because they answer different questions: the review screen says
              what the transaction did to *this* wallet, the explorer says what it did on chain. */}
          {onViewTransaction !== undefined ? (
            <Button
              variant="nakedDefault"
              size="sm"
              label={t('utxo.details.viewTransaction')}
              rightIcon="chevronRight"
              onPress={() => {
                close()
                onViewTransaction()
              }}
              testID="utxo-view-transaction"
            />
          ) : null}

          {explorerUrl !== null ? (
            <Button
              variant="nakedDefault"
              size="sm"
              label={t('utxo.details.viewOnExplorer')}
              rightIcon="arrowUpRight"
              onPress={() => void Linking.openURL(explorerUrl)}
              testID="utxo-view-on-explorer"
            />
          ) : null}
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create(({spacing, colors, fontSizes, fontFamily}) => ({
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.spacing12},
  rowLabel: {flex: 1, color: colors.textMuted},
  details: {width: '100%', gap: spacing.spacing12},
  detailRow: {gap: spacing.spacing4},
  detailLabel: {fontSize: fontSizes.bodySm, fontFamily: fontFamily.regular, color: colors.textAlternative},
  detailValue: {fontSize: fontSizes.bodyMd, fontFamily: fontFamily.regular, color: colors.textDefault},
}))
