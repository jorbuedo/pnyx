/**
 * The review surface for a **message** signature (CIP-8 / CIP-30 `signData`).
 *
 * Phase 16 item 41 routes every user- or dApp-prompted signature through
 * `TxReviewScreen`; this renders the subject when that signature is over bytes
 * rather than a transaction.
 *
 * Two rules it exists to hold:
 *
 * - **Render only what the bytes prove.** `payloadHex` is authored by the
 *   requester, so nothing here may present a requester-supplied *summary*. It
 *   shows the output of `decodeSignDataPayload`: parsed SIWE fields when the
 *   payload really is a login message, the plain text when it is printable UTF-8,
 *   and otherwise the raw hex, labelled as uninterpretable rather than dressed up.
 * - **Borrow no transaction chrome.** No fee, no balance impact, no party tiers.
 *   A signed message moves nothing, and a transaction-shaped surface around it
 *   would imply otherwise (`Don't lie to the user`).
 *
 * The origin is shown as **unverified** on purpose: it is a self-declared string
 * from the requester, and item 29's scanned-request path will make that matter
 * more, not less.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Callout} from '../../../components/Callout'
import {Card} from '../../../components/Card'
import type {DecodedSignData} from '../../../components/DappBrowser/sign-data-decode'
import {SectionHeader} from '../../../components/SectionHeader'
import {Typography} from '../../../components/Typography'
import type {TranslationKey} from '../../../i18n/types'
import {useI18n} from '../../../providers'
import {signingAddressDisplay} from './signing-address-display'

const styles = StyleSheet.create(({spacing, colors}) => ({
  root: {gap: spacing.spacing12},
  // The header sits flush on its card — they read as one surface, and the root gap between them made
  // the label look like it belonged to the notice above instead.
  titled: {gap: 0},
  card: {gap: spacing.spacing12, padding: spacing.spacing16},
  field: {gap: spacing.spacing4},
  label: {color: colors.textAlternative},
  mono: {color: colors.textAlternative},
}))

const Field = ({label, value}: {readonly label: string; readonly value: string}) => (
  <View style={styles.field}>
    <Typography variant="bodySm_regular" style={styles.label}>
      {label}
    </Typography>
    <Typography variant="bodySm_regular">{value}</Typography>
  </View>
)

export type MessageReviewProps = {
  readonly message: DecodedSignData
  /** Raw address bytes whose key will sign — rendered as bech32, which is the form its owner can check. */
  readonly addressHex: string
  /** Requesting origin, or `null` when the request carries none. */
  readonly origin: string | null
  /** Who asked — the producer's word, never the requester's. See `ReviewMessageLeg`. */
  readonly requestedBy: 'app' | 'external'
}

/**
 * ⚠️ **`origin: null` means two different things, and only one of them is a warning.** An in-app
 * action has no site to name; an external request may simply have declined to give one. Saying
 * "something is asking you, its source is unverified" about the app the user is holding is the app
 * lying about itself — and it spends the warning that matters on the case that does not need it.
 */
const noticeText = (
  t: (key: TranslationKey, values?: Record<string, string>) => string,
  requestedBy: 'app' | 'external',
  origin: string | null,
): string => {
  if (requestedBy === 'app') return t('txReview.message.noticeInApp')
  return origin === null ? t('txReview.message.noticeNoOrigin') : t('txReview.message.notice', {origin})
}

export const MessageReview = ({message, addressHex, origin, requestedBy}: MessageReviewProps) => {
  const {t} = useI18n()

  return (
    <View style={styles.root} testID="message-review">
      <Callout variant="info" message={noticeText(t, requestedBy, origin)} testID="message-review-notice" />
      <View style={styles.titled}>
        <SectionHeader title={t('txReview.message.title')} />
        <Card variant="outlined" style={styles.card}>
          {message.kind === 'siwe' ? (
            <>
              <Field label={t('txReview.dapp.signInDomain')} value={message.fields.domain} />
              <Field label={t('txReview.dapp.signDataAddress')} value={message.fields.address} />
              {message.fields.statement !== null ? (
                <Field label={t('txReview.dapp.signInStatement')} value={message.fields.statement} />
              ) : null}
              {message.fields.uri !== null ? (
                <Field label={t('txReview.dapp.signInUri')} value={message.fields.uri} />
              ) : null}
              {message.fields.nonce !== null ? (
                <Field label={t('txReview.dapp.signInNonce')} value={message.fields.nonce} />
              ) : null}
              {message.fields.issuedAt !== null ? (
                <Field label={t('txReview.dapp.signInIssuedAt')} value={message.fields.issuedAt} />
              ) : null}
            </>
          ) : message.kind === 'utf8' ? (
            <Field label={t('txReview.dapp.signDataMessage')} value={message.text} />
          ) : (
            <View style={styles.field}>
              <Typography variant="bodySm_regular" style={styles.label}>
                {t('txReview.dapp.signDataRaw')}
              </Typography>
              <Typography variant="bodySm_regular" style={styles.mono} numberOfLines={8}>
                {message.hex}
              </Typography>
              <Typography variant="bodySm_regular" style={styles.label}>
                {t('txReview.message.rawWarning')}
              </Typography>
            </View>
          )}
          <Field label={t('txReview.message.signingWith')} value={signingAddressDisplay(addressHex)} />
        </Card>
      </View>
    </View>
  )
}
