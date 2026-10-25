/**
 * The name field itself — type a name, see what it costs, claim it.
 *
 * Lives on the claim screen rather than the ID tab: what a name costs depends on its length, and the
 * lengths and the permits you hold are what make that legible. The tab offers the claim as the
 * trailing action on its name row (`IdScreen`) and links here.
 *
 * Claim only. Once a name is held it is shown on the identity card and released from the modal behind
 * it — **one name per identity** (product decision, 2026-08-13). The contract itself allows aliases,
 * since `names` is many-to-one with `IdentityRow.name` naming the primary; nothing in the UI offers one.
 *
 * @module
 */

import {validateHandle} from '@pnyx/contract-client/handle'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {Card} from '../../components/Card'
import {ChamferBackground} from '../../components/Chamfer'
import {TextInputBase} from '../../components/TextInputBase'
import {Typography} from '../../components/Typography'
import {useHandleOffer} from '../../hooks/useHandleOffer'
import {useI18n} from '../../providers'
import type {HandleOffer} from '../../services/handle-offer-rule'
import {REJECTION_KEY} from '../../services/handle-rejection-key'
import {TIER_NAME_KEY} from '../../services/handle-tier-display'
import type {WalletPermits} from '../../services/permit-balances'
import {permitClaimDecision} from '../../services/permit-claim-rule'

type Props = {
  readonly busy: boolean
  readonly onClaim: (name: string) => void
  /** Every funds wallet's permits, so a priced name can name the wallet that could pay for it. */
  readonly wallets: readonly WalletPermits[]
  /** The wallet a claim would run against right now. */
  readonly selected: {readonly groupId: string; readonly accountIndex: number} | undefined
}

export function HandleClaimForm({busy, onClaim, wallets, selected}: Props) {
  const {t} = useI18n()
  const [input, setInput] = useState('')
  const offer = useHandleOffer(input)
  // ⚠️ Free, or already yours. A priced tier is real and someone can hold it, but `buyPermit` is not on
  // the device rail — so offering the button would be offering something that cannot land. `yours` is
  // the other claimable case and needs no purchase at all: the name is bound and only the row write
  // that displays it is missing.
  const resumable = offer?.kind === 'yours'
  const canClaim = !busy && validateHandle(input).ok && (offer?.kind === 'free' || resumable)

  const offerLine = (o: HandleOffer | undefined): string | undefined => {
    if (input.trim() === '' || !validateHandle(input).ok) return undefined
    if (o === undefined) return t('you.handle.offerChecking')
    switch (o.kind) {
      case 'yours':
        return t('you.handle.offerYours')
      case 'taken':
        return t('you.handle.offerTaken')
      case 'reserved':
        return o.permanent ? t('you.handle.offerBurned') : t('you.handle.offerBanned')
      case 'free':
        return t('you.handle.offerFree')
      case 'priced': {
        // A priced name is only claimable with a permit, and a permit sits in one wallet. So the line
        // says which wallet to switch to when one holds it — "costs X" alone would be true and useless
        // to somebody who already owns what they need.
        const decision = permitClaimDecision({offer: o, wallets, selected})
        if (decision.kind === 'switch-wallet') {
          return t('you.handle.screen.switchWallet', {wallet: decision.wallet.label})
        }
        if (decision.kind === 'no-permit') return t('you.handle.screen.noPermit')
        // Names the ticket rather than quoting a price: a price with no way to act on it invites the
        // question this app deliberately cannot answer.
        return t('you.handle.offerPriced', {
          name: t(`you.handle.screen.tierName.${TIER_NAME_KEY[o.tier]}` as 'you.handle.screen.tierName.gold'),
        })
      }
      case 'unavailable':
        return t('you.handle.offerUnavailable')
      case 'no-namespace':
        return t('you.handle.offerNoNamespace')
      case 'unknown':
        return t('you.handle.offerUnknown')
      // A name that does not validate is covered by the hint below, so this says nothing extra.
      case 'invalid':
        return undefined
      default: {
        const unhandled: never = o
        return unhandled
      }
    }
  }
  const line = offerLine(offer)

  // Every naming rule surfaces here, as you type, instead of as a list of prohibitions under an empty
  // field. `empty` is excluded on purpose: a field you have not filled in yet is not an error.
  const checked = validateHandle(input)
  const invalid =
    input.trim() === '' || checked.ok || checked.reason === 'empty' ? undefined : REJECTION_KEY[checked.reason]

  return (
    <Card style={styles.card} testID="id-handle-card">
      {/* While the claim runs, the field becomes the explanation. An editable input beside a spinner
          invites a second name nothing would do anything with, and it hid the two things worth
          knowing: the wait is real — a proof is built on this device before anything reaches the
          chain — and it survives leaving this screen, because the work is a promise rather than a
          property of what is on screen. The name stays visible in the notice, so the card still says
          what it is doing. */}
      {busy ? (
        <Callout
          variant="info"
          message={t('you.handle.claimingNotice', {name: input.trim()})}
          testID="id-handle-claiming"
        />
      ) : (
        <View style={styles.inputWrap}>
          <ChamferBackground size="auto" fillToken="backgroundDefault" />
          <TextInputBase
            value={input}
            onChangeText={setInput}
            placeholder={t('you.handle.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            testID="id-handle-input"
          />
        </View>
      )}
      <Button
        label={busy ? t('you.handle.working') : resumable ? t('you.handle.finish') : t('you.handle.claim')}
        variant="primary"
        onPress={() => onClaim(input)}
        isDisabled={!canClaim}
        isLoading={busy}
        fullWidth
        testID="id-handle-claim"
      />
      {!busy && invalid !== undefined && (
        <Typography variant="bodyXs_regular" style={styles.invalid} testID="id-handle-invalid">
          {t(invalid)}
        </Typography>
      )}
      {!busy && invalid === undefined && line !== undefined && (
        <Typography variant="bodyXs_regular" style={styles.offer} testID="id-handle-offer">
          {line}
        </Typography>
      )}
      {!busy && (
        <Typography variant="bodyXs_regular" style={styles.muted}>
          {t('you.handle.hint')}
        </Typography>
      )}
    </Card>
  )
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: '100%',
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing16,
  },
  muted: {color: theme.colors.textAlternative},
  offer: {color: theme.colors.textDefault},
  invalid: {color: theme.colors.errorDefault},
  inputWrap: {},
  input: {
    color: theme.colors.textDefault,
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing12,
  },
}))
