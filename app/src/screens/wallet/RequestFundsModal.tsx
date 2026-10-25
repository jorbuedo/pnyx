/**
 * Asking for a specific amount at this wallet's address.
 *
 * The output is a **CIP-13 `web+cardano://pay` URI** — the Cardano standard for a
 * payment request, so it works as a QR, a deep link, or a message pasted into a DM,
 * and every other wallet can read it. A Pnyx-specific link would only be payable by
 * another copy of this app. Whoever receives it lands in the send flow with the
 * recipient and amount filled in and confirms on the ordinary review screen;
 * nothing here can move money, it asks.
 *
 * The amount goes through the shared number parser rather than `parseFloat`, so a
 * comma-decimal locale types the amount its keyboard produces and the link still
 * carries lovelace. What crosses the wire is `parsed.canonical`, a bigint — the
 * decimal string is only ever what the user sees.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {ChamferBackground} from '../../components/Chamfer'
import {Modal} from '../../components/Modal'
import {QRCard} from '../../components/QRCard'
import {TextInputBase} from '../../components/TextInputBase'
import {Typography} from '../../components/Typography'
import {ValueBox} from '../../components/ValueBox'
import {useCopy, useI18n, useNumberParser} from '../../providers'
import {buildFundsRequest, MAX_NOTE_LENGTH} from '../../services/cardano/funds-request'

const QR_SIZE = 200
const ADA_DECIMALS = 6

export type RequestFundsModalProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly addressBech32: string
  readonly onShare: (link: string) => void
}

export const RequestFundsModal = ({visible, onClose, addressBech32, onShare}: RequestFundsModalProps) => {
  const {t} = useI18n()
  const {copy} = useCopy()
  const parseNumber = useNumberParser()
  const [text, setText] = useState('')
  const [note, setNote] = useState('')

  const parsed = useMemo(
    () => parseNumber(text, {decimals: ADA_DECIMALS, precision: ADA_DECIMALS}),
    [parseNumber, text],
  )

  const built = useMemo(
    () => buildFundsRequest({addressBech32, lovelace: parsed.canonical, note}),
    [addressBech32, parsed.canonical, note],
  )

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('receive.request.title')}
      testID="request-funds-modal"
    >
      <View style={styles.body}>
        <Typography variant="bodySm_regular" style={styles.hint}>
          {t('receive.request.hint')}
        </Typography>
        <View style={styles.inputWrap}>
          <ChamferBackground size="auto" fillToken="backgroundAlternative" />
          <TextInputBase
            value={parsed.inputValue}
            onChangeText={setText}
            placeholder="0"
            keyboardType="decimal-pad"
            style={styles.input}
            testID="request-funds-amount"
          />
        </View>
        {/* An empty amount is a request the payer decides, not an error — so the
            link exists either way and the copy says which one it is. */}
        <Typography variant="bodyXs_regular" style={styles.hint}>
          {parsed.canonical > 0n ? t('receive.request.forAmount') : t('receive.request.anyAmount')}
        </Typography>

        {/* A note forces the CIP-157 shape, because CIP-13 cannot carry one. Left
            empty the request stays CIP-13, which more wallets read — so the field is
            optional and its cost is stated rather than hidden. */}
        <View style={styles.inputWrap}>
          <ChamferBackground size="auto" fillToken="backgroundAlternative" />
          <TextInputBase
            value={note}
            onChangeText={setNote}
            placeholder={t('receive.request.notePlaceholder')}
            maxLength={MAX_NOTE_LENGTH}
            style={styles.noteInput}
            testID="request-funds-note"
          />
        </View>

        {built.ok ? (
          <>
            <Typography variant="bodyXs_regular" style={styles.hint}>
              {built.standard === 'cip157' ? t('receive.request.standardCip157') : t('receive.request.standardCip13')}
            </Typography>
            <QRCard value={built.link} size={QR_SIZE} testID="request-funds-qr" />
            <ValueBox label={t('receive.request.linkLabel')} value={built.link} />
            <Button
              variant="primary"
              label={t('receive.request.copy')}
              leftIcon="copy"
              fullWidth
              onPress={() => copy({text: built.link, feedback: t('receive.request.copied')})}
              testID="request-funds-copy"
            />
            <Button
              variant="secondary"
              label={t('receive.share')}
              leftIcon="shareOutline"
              fullWidth
              onPress={() => onShare(built.link)}
              testID="request-funds-share"
            />
          </>
        ) : (
          <Typography variant="bodySm_regular" style={styles.error} testID="request-funds-problem">
            {t('receive.request.unavailable')}
          </Typography>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  body: {gap: theme.spacing.spacing12, alignItems: 'stretch'},
  hint: {color: theme.colors.textMuted},
  error: {color: theme.colors.errorDefault},
  noteInput: {
    color: theme.colors.textDefault,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
  },
  inputWrap: {},
  input: {
    color: theme.colors.textDefault,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
    fontSize: 24,
  },
}))
