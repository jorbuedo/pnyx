/**
 * Address display component.
 *
 * Displays a blockchain address with the last characters highlighted, middle
 * truncation, and copy-to-clipboard functionality.
 *
 * @module
 */

import * as React from 'react'
import {Text, type TextStyle, View, type ViewStyle} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {useI18n} from '../providers'
import {addressRuns} from '../utils/truncate'
import {Copiable} from './Copiable'
import {Modal} from './Modal'
import {QRCard} from './QRCard'
import {Tag} from './Tag'
import {UniIcon} from './UniIcon'

export type AddressProps = {
  /** The address to display */
  address: string
  /** Optional style for the container */
  style?: ViewStyle
  /** Optional style for the text */
  textStyle?: TextStyle
  /** Optional right adornment (icon, button, etc.) */
  rightAdornment?: React.ReactNode
  /** Whether to show the address modal on press (default: true) */
  showModal?: boolean
  /** Custom modal title */
  modalTitle?: string
  /** Derivation path info (optional) */
  derivationPath?: string
  /** Staking key (optional, for Cardano addresses) */
  stakingKey?: string
  /** Spending key (optional, for Cardano addresses) */
  spendingKey?: string
  /** The reward (stake) address this address delegates through (Cardano). */
  rewardAddress?: string
  /**
   * Payment credential is a script, not a key — the address is a contract, and
   * `spendingKey` is a script hash. Absent when the caller could not inspect it.
   */
  isScript?: boolean
  /** Name of a contract we deployed ourselves. Never a third-party guess. */
  knownLabel?: string
  /** Feedback message for copy action */
  feedback?: string
  /** Leading characters to keep before the ellipsis (see `addressRuns`). */
  headChars?: number
  /** Caption rendered to the left by {@link Copiable}, for a labelled row. */
  title?: string
  /** Forwarded to {@link Copiable} — how much of the row the caption takes. Default is an even split. */
  titleFlex?: number
  /**
   * Whether tapping copies, with the copy affordance shown (default: true).
   *
   * `false` for an address inside something already pressable — a card that opens
   * its own sheet, say. Two nested tap targets is one the user cannot reliably
   * hit, and the copy belongs on the surface that shows the address in full.
   */
  copiable?: boolean
}

/**
 * Address display component with copy functionality.
 *
 * Features:
 * - Last characters highlighted in primary color
 * - Middle truncation with ellipsis (see `addressRuns`)
 * - Tap to copy with visual feedback
 * - Optional modal with QR code and full address details
 *
 * @example
 * ```tsx
 * <Address
 *   address="addr1qx..."
 *   feedback="Address copied!"
 * />
 * ```
 */
export const Address = ({
  address,
  style,
  textStyle,
  rightAdornment,
  showModal = true,
  modalTitle,
  derivationPath,
  stakingKey,
  spendingKey,
  rewardAddress,
  isScript,
  knownLabel,
  feedback,
  headChars,
  title,
  titleFlex,
  copiable = true,
}: AddressProps) => {
  const {t} = useI18n()
  const [modalVisible, setModalVisible] = React.useState(false)
  const resolvedModalTitle = modalTitle ?? t('address.details.title')
  const resolvedFeedback = feedback ?? t('address.details.copied')

  const handlePress = React.useCallback(() => {
    if (showModal) {
      setModalVisible(true)
    }
  }, [showModal])

  const handleCloseModal = React.useCallback(() => {
    setModalVisible(false)
  }, [])

  const runs = addressRuns(address, headChars)

  const body = (
    <View style={[styles.container, style]}>
      {isScript === true && (
        <View accessible accessibilityLabel={t('address.details.script')} style={styles.scriptIcon}>
          <UniIcon name="fileText" size="xxs" uniProps={(theme) => ({color: theme.colors.textAlternative})} />
        </View>
      )}
      {/* The head is the only run that may be clipped — `ellipsizeMode="clip"` so the platform
          cannot add a second ellipsis beside ours. See `addressRuns`. */}
      <View style={styles.addressContainer}>
        <Text numberOfLines={1} ellipsizeMode="clip" style={[styles.prefix, textStyle]}>
          {runs.head}
        </Text>
        {runs.elided && (
          <Text numberOfLines={1} style={[styles.middle, textStyle]}>
            {`…${runs.tail}`}
          </Text>
        )}
        <Text style={styles.suffix}>{runs.highlight}</Text>
      </View>
      {rightAdornment !== undefined && (
        <>
          <View style={styles.spacer} />
          {rightAdornment}
        </>
      )}
    </View>
  )

  return (
    <>
      {copiable ? (
        <Copiable
          text={address}
          feedback={resolvedFeedback}
          {...(title === undefined ? {} : {title})}
          {...(titleFlex === undefined ? {} : {titleFlex})}
          {...(showModal && {onPress: handlePress})}
        >
          {body}
        </Copiable>
      ) : (
        body
      )}

      <Modal
        visible={modalVisible}
        onClose={handleCloseModal}
        title={resolvedModalTitle}
        position="bottom"
        showDragIndicator
      >
        <AddressModalContent
          address={address}
          {...(derivationPath !== undefined && {derivationPath})}
          {...(stakingKey !== undefined && {stakingKey})}
          {...(spendingKey !== undefined && {spendingKey})}
          {...(rewardAddress !== undefined && {rewardAddress})}
          {...(isScript !== undefined && {isScript})}
          {...(knownLabel !== undefined && {knownLabel})}
        />
      </Modal>
    </>
  )
}

type AddressModalContentProps = {
  address: string
  derivationPath?: string
  stakingKey?: string
  spendingKey?: string
  rewardAddress?: string
  isScript?: boolean
  knownLabel?: string
}

const AddressModalContent = ({
  address,
  derivationPath,
  stakingKey,
  spendingKey,
  rewardAddress,
  isScript,
  knownLabel,
}: AddressModalContentProps) => {
  const {t} = useI18n()
  return (
    <View style={styles.modalContent}>
      <QRCard value={address} size={160} />

      {isScript !== undefined || knownLabel !== undefined ? (
        <View style={styles.tagRow}>
          {knownLabel !== undefined && <Tag label={knownLabel} variant="primary" size="sm" />}
          {isScript !== undefined && (
            <Tag
              label={isScript ? t('address.details.script') : t('address.details.keyControlled')}
              variant="secondary"
              size="sm"
            />
          )}
        </View>
      ) : null}

      <View style={styles.detailsContainer}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>{t('address.details.address')}</Text>
          <Copiable text={address} feedback={t('address.details.copied')}>
            <Text style={styles.detailValue} numberOfLines={3}>
              {address}
            </Text>
          </Copiable>
        </View>

        {derivationPath !== undefined && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('address.details.derivationPath')}</Text>
            <Text style={styles.detailValue}>{derivationPath}</Text>
          </View>
        )}

        {spendingKey !== undefined && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>
              {isScript === true ? t('address.details.scriptHash') : t('address.details.spendingKey')}
            </Text>
            <Copiable text={spendingKey} feedback={t('address.details.spendingKeyCopied')}>
              <Text style={styles.detailValue} numberOfLines={2}>
                {spendingKey}
              </Text>
            </Copiable>
          </View>
        )}

        {stakingKey !== undefined && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('address.details.stakingKey')}</Text>
            <Copiable text={stakingKey} feedback={t('address.details.stakingKeyCopied')}>
              <Text style={styles.detailValue} numberOfLines={2}>
                {stakingKey}
              </Text>
            </Copiable>
          </View>
        )}

        {rewardAddress !== undefined && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('address.details.rewardAddress')}</Text>
            <Copiable text={rewardAddress} feedback={t('address.details.rewardAddressCopied')}>
              <Text style={styles.detailValue} numberOfLines={2}>
                {rewardAddress}
              </Text>
            </Copiable>
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  scriptIcon: {
    marginRight: theme.spacing.spacing4,
  },
  addressContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingRight: theme.spacing.spacing4,
  },
  // ⚠️ `textAlign: 'right'` is not cosmetic. This is the only run that shrinks, and Android ends a
  // single line on a whole character — so the drawn line is up to one character narrower than the box
  // flexbox handed it, while the ellipsis starts at the box edge. Left-aligned, that slack opens a gap
  // *inside* the address (`pnyx_id1s …ta9424dq`), which reads as two values rather than one truncated
  // one. Aligned right, the same slack lands before the head, where it is indistinguishable from the
  // row's own spacing.
  prefix: {
    flexShrink: 1,
    textAlign: 'right',
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.regular,
    color: theme.colors.textAlternative,
  },
  // No `flexShrink`: the ellipsis and the tail are what a reader checks an address by, so they hold
  // their width and the head gives way instead.
  middle: {
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.regular,
    color: theme.colors.textAlternative,
  },
  suffix: {
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.medium,
    color: theme.colors.primaryDefault,
  },
  spacer: {
    width: theme.spacing.spacing8,
  },
  // Modal styles
  modalContent: {
    gap: theme.spacing.spacing16,
    alignItems: 'center',
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing8,
    alignSelf: 'flex-start',
  },
  detailsContainer: {
    width: '100%',
    gap: theme.spacing.spacing12,
  },
  detailRow: {
    gap: theme.spacing.spacing4,
  },
  detailLabel: {
    fontSize: theme.fontSizes.bodySm,
    fontFamily: theme.fontFamily.regular,
    color: theme.colors.textAlternative,
  },
  detailValue: {
    fontSize: theme.fontSizes.bodyMd,
    fontFamily: theme.fontFamily.regular,
    color: theme.colors.textDefault,
  },
}))
