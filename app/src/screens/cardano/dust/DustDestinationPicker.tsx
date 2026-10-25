/**
 * Choosing where a wallet's DUST goes.
 *
 * Three ways, because the destination is a free choice rather than a property of this
 * wallet: one of the user's own wallets, Pnyx (a donation — it funds the community
 * features the app sponsors), or any address pasted in. Delegating to someone you do not
 * control is the documented mechanism, not an edge case, so pasting is a first-class option
 * rather than an escape hatch.
 *
 * @module
 */

import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Modal} from '../../../components/Modal'
import {SettingsPickerRow} from '../../../components/SettingsPickerRow'
import {TextArea} from '../../../components/TextArea'
import {Typography} from '../../../components/Typography'
import {useI18n} from '../../../providers'
import {type DestinationChoice, describeDestination} from '../../../services/midnight-dust'
import {dustPayloadOf} from './use-dust-destinations'

export type DustDestinationPickerProps = {
  readonly visible: boolean
  readonly choices: readonly DestinationChoice[]
  /** Payload of the currently-selected destination, for the tick. */
  readonly selectedPayload?: string | undefined
  readonly onSelect: (choice: DestinationChoice) => void
  readonly onDismiss: () => void
}

const shorten = (address: string): string =>
  address.length <= 24 ? address : `${address.slice(0, 14)}…${address.slice(-8)}`

export const DustDestinationPicker = ({
  visible,
  choices,
  selectedPayload,
  onSelect,
  onDismiss,
}: DustDestinationPickerProps) => {
  const {t} = useI18n()
  const [pasted, setPasted] = useState('')

  const owned = choices.filter((c) => c.owner.kind === 'self' || c.owner.kind === 'ownWallet')
  const pnyx = choices.find((c) => c.owner.kind === 'pnyx')

  // Validated by decoding, not by a prefix check: a string that looks like an address but
  // does not decode would be registered as a destination nobody can receive at.
  const pastedPayload = pasted.trim() === '' ? null : dustPayloadOf(pasted.trim())
  const pasteInvalid = pasted.trim() !== '' && pastedPayload === null
  // Pasting an address that is already listed is not a second option — it is that option.
  // Offering it twice put two filled radios on screen and invited the user to pick the
  // copy, which then read as "another address" despite being their own wallet.
  const pastedAlreadyListed = pastedPayload !== null && choices.some((c) => c.payload === pastedPayload)

  const label = (choice: DestinationChoice): string =>
    choice.owner.kind === 'self'
      ? t('midnightDust.owner.self')
      : choice.owner.kind === 'ownWallet'
        ? choice.owner.walletName
        : t('midnightDust.owner.pnyx')

  return (
    <Modal
      visible={visible}
      onClose={onDismiss}
      position="bottom"
      title={t('midnightDust.picker.title')}
      description={t('midnightDust.picker.intro')}
      testID="dust-destination-picker"
    >
      <View style={styles.body}>
        <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
          {t('midnightDust.picker.ownWalletsSection')}
        </Typography>
        {owned.map((choice) => (
          <SettingsPickerRow
            key={choice.payload}
            label={label(choice)}
            sublabel={shorten(choice.address)}
            selected={choice.payload === selectedPayload}
            onPress={() => onSelect(choice)}
            checkboxVariant="radio"
            testID={`dust-dest-${choice.owner.kind}`}
          />
        ))}

        {pnyx !== undefined ? (
          <>
            <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
              {t('midnightDust.picker.pnyxSection')}
            </Typography>
            <SettingsPickerRow
              label={t('midnightDust.owner.pnyx')}
              sublabel={t('midnightDust.picker.pnyxSublabel')}
              selected={pnyx.payload === selectedPayload}
              onPress={() => onSelect(pnyx)}
              checkboxVariant="radio"
              testID="dust-dest-pnyx"
            />
          </>
        ) : null}

        <Typography variant="bodyXs_medium" style={styles.sectionLabel}>
          {t('midnightDust.picker.pasteSection')}
        </Typography>
        {/* TextArea rather than TextInput: a bech32m DUST address is ~70 chars
            and overflowed a single line. */}
        <TextArea
          value={pasted}
          onChange={setPasted}
          placeholder={t('midnightDust.picker.pastePlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          isError={pasteInvalid}
          {...(pasteInvalid ? {message: t('midnightDust.picker.pasteInvalid')} : {})}
          testID="dust-dest-paste"
        />
        {pastedPayload !== null && pastedAlreadyListed ? (
          <Typography variant="bodyXs_regular" style={styles.note}>
            {t('midnightDust.picker.pasteAlreadyListed')}
          </Typography>
        ) : null}
        {pastedPayload !== null && !pastedAlreadyListed ? (
          <SettingsPickerRow
            label={t('midnightDust.picker.confirm')}
            sublabel={shorten(pasted.trim())}
            selected={pastedPayload === selectedPayload}
            onPress={() =>
              onSelect({
                payload: pastedPayload,
                address: pasted.trim(),
                // Resolve rather than assume external: an address can be one of the user's
                // own without having been picked from the list.
                owner: describeDestination(pastedPayload, choices),
              })
            }
            checkboxVariant="radio"
            testID="dust-dest-pasted"
          />
        ) : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create(({colors, spacing}) => ({
  body: {gap: spacing.spacing6, paddingBottom: spacing.spacing8},
  sectionLabel: {color: colors.textAlternative, textTransform: 'uppercase', paddingTop: spacing.spacing8},
  note: {color: colors.textAlternative},
}))
