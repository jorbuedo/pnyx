/**
 * QR action router.
 *
 * Navigates to the appropriate screen based on a parsed QR action.
 *
 * A payment request opens the send funnel with the recipient and amount filled in.
 * The standard shape is **CIP-13 `web+cardano://pay`** — what the wallet's own
 * Receive screen emits and what every other Cardano wallet reads; the brand
 * `transfer/request/crypto` still routes because partners send it.
 *
 * It lands on `/wallet/link-action`, **not** the funnel: the request has to be told
 * which wallet to pay from — the selected one is a leftover from whatever the user
 * was doing, quite possibly a shared or watch-only wallet — and the address's own
 * bech32 prefix says whether a network switch is needed. That screen asks both and
 * hands off; the funnel then still runs its amount step, its review and its
 * ceremony. Everything reaching this router is untrusted input, so nothing on the
 * path from here to a signature is skipped.
 *
 * A delegation link — CIP-13 `stake` or `drep` — lands on the same screen for the
 * same reason: which wallet's stake account is the open question, and the target
 * is only a suggestion until the staking screen's own confirm and review.
 *
 * **A scanned link goes through the same classifier a messaged one does.**
 * `readLinkAction` decides what a URI is and refuses what it cannot honour, so a
 * QR and a card in a thread cannot disagree about the same string.
 *
 * That last property is the one this file kept breaking. Every shape the
 * classifier can describe now *lands* — on the sheet, saying what it is — and an
 * "unsupported" alert is reserved for what the classifier itself refuses. Four
 * things used to be refused here that a DM card had described all along: the two
 * superseded transfer shapes (one of which wraps a CIP-13 URI this app can pay),
 * an exchange result, and a bare Cardano address. The multisig pair had no branch
 * at all and fell to `default: return false`, which a deep link turned into a
 * silent bounce to home.
 *
 * @module
 */

import type {BrandAction, ParsedUri} from '@pnyx/links'
import {Alert} from 'react-native'
import type {TranslationProvider} from '../i18n'
import {logger} from '../logger'
import {registerLinkActionSubject} from '../screens/cardano/link-action-handoff'
import {linkActionOf, linkActionOfUri} from '../services/link-action'
import {linkActionSubjectFor} from './link-action-subject'
import type {QrAction} from './qr-parser'
import {hostOfUrl} from './url-host'

// expo-router 56 no longer exports the `ImperativeRouter` type; derive it from the `router` singleton.
type Router = typeof import('expo-router').router

/**
 * The scanned URI, read by the same rule a message body is read by.
 *
 * Takes the parse the scanner already did rather than re-reading the raw string:
 * two parses of one code is two chances to disagree about it.
 */
const subjectFromUri = (parsed: ParsedUri) => {
  const action = linkActionOfUri(parsed)
  return action === null ? null : linkActionSubjectFor(action, 'scan')
}

/**
 * The scanned brand link, read by the same rule a message body is read by.
 *
 * Needs `raw` as well as the parsed action because a co-signer key is decoded from
 * the link itself — `parseCoSignerValue` takes the string, not the split params,
 * so that one shape cannot be classified from `action` alone.
 */
const subjectFromBrand = (action: BrandAction, raw: string) => {
  const read = linkActionOf(action, raw)
  return read === null ? null : linkActionSubjectFor(read, 'scan')
}

export type CryptoTransferPaymentRequest = {
  chain: string
  address: string
  amount?: string
  token?: string
  asset?: string
  message?: string
  redirectTo?: string
  sourceWalletGroupId?: string
  sourceWalletAccountIndex?: string
  onProceed: () => void
}

export type HandleQrActionOptions = {
  onCryptoTransferPaymentRequest?: (request: CryptoTransferPaymentRequest) => void
  /**
   * Where the payload came from, which decides how much consent it needs.
   *
   * A **scan** is already a deliberate act — the user pointed a camera at this —
   * so a browse link opens the browser and a backup opens restore, because both
   * came from something in front of them.
   *
   * A **deep link** did not: someone else's URL opened the app. Nothing acts on
   * its own there. Everything lands on the sheet first, including the kinds a scan
   * would have carried out, and *especially* a backup — an external link must not
   * be able to drop anyone into a restore flow.
   */
  source?: 'scan' | 'deep-link'
}

/**
 * Handle a parsed QR action by navigating to the appropriate screen.
 *
 * @returns true if navigation was handled, false if the action was unknown/unsupported
 */
export function handleQrAction(
  action: QrAction,
  router: Router,
  t: TranslationProvider['t'],
  options?: HandleQrActionOptions,
): boolean {
  const external = options?.source === 'deep-link'

  /** Land on the sheet instead of acting. Used for everything from a deep link. */
  const land = (subject: ReturnType<typeof subjectFromUri>): boolean => {
    if (subject === null) return false
    router.navigate({pathname: '/wallet/link-action', params: {subject: registerLinkActionSubject(subject)}})
    return true
  }

  switch (action.type) {
    case 'address': {
      // The same reading `web+cardano://address` gets, because it is the same
      // address: an open payment request, amount left to the payer. This branch used
      // to alert "no funds features", which stopped being true at the multi-chain
      // pivot and made a bare address behave differently from the URI wrapping it.
      const subject = linkActionSubjectFor({kind: 'address', address: action.address}, 'scan')
      if (subject === null) {
        logger.info('QR scan: address that cannot be paid to', {network: action.network})
        Alert.alert(t('scan.errors.unsupportedTitle'), t('scan.errors.unsupportedLink'))
        return false
      }
      logger.info('QR scan: bare address as an open payment request', {network: action.network})
      return land(subject)
    }

    case 'cardanoUri': {
      const {parsed, raw} = action

      switch (parsed.authority) {
        case 'backup': {
          // A scanned backup came from something in front of the user — their own
          // export — so it still goes straight to restore, passing the original URL
          // through because the restore screen re-parses it.
          //
          // An external link is the opposite: restoring a stranger's backup installs
          // their wallet on this device. It lands on the sheet, which names it and
          // offers nothing.
          if (external) {
            logger.info('[DeepLink] encrypted backup URI — landing rather than restoring')
            return land(subjectFromUri(parsed))
          }
          logger.info('QR scan: encrypted backup URI')
          router.navigate({pathname: '/onboarding/restore-from-backup', params: {link: raw}})
          return true
        }

        // Every payment and delegation URI, through the one classifier. `pay` and
        // `pay/v1` are payment requests; `stake` and `drep` are delegations, and
        // both are refused by the classifier when the id will not decode — a
        // scanned target that cannot become a certificate must not open a screen
        // offering to delegate to it.
        case 'pay':
        case 'pay-v1':
        case 'stake':
        case 'drep': {
          const subject = subjectFromUri(parsed)
          if (subject === null) {
            logger.info('QR scan: cardano URI the classifier will not act on', {authority: parsed.authority})
            Alert.alert(t('scan.errors.unsupportedTitle'), t('scan.errors.unsupportedLink'))
            return false
          }
          logger.info('QR scan: cardano link action', {authority: parsed.authority, kind: subject.kind})
          router.navigate({pathname: '/wallet/link-action', params: {subject: registerLinkActionSubject(subject)}})
          return true
        }

        case 'browse': {
          // CIP-0158. The parser has already enforced http(s)-only, so the only
          // question left is consent: a scan opens it, an external link asks first.
          logger.info('QR scan: CIP-0158 browse URI', {uri: parsed.uri, external})
          if (external) return land(subjectFromUri(parsed))
          router.navigate({pathname: '/browser', params: {url: parsed.uri}})
          return true
        }

        default: {
          // Everything the classifier can name — a page to look at, an address, a
          // kind this build cannot carry out. It lands and says what it is rather
          // than alerting "unsupported" at a link the app understands perfectly.
          const subject = subjectFromUri(parsed)
          if (subject !== null) {
            logger.info('QR scan: cardano URI landed on the sheet', {authority: parsed.authority, kind: subject.kind})
            return land(subject)
          }
          logger.info('QR scan: unsupported cardano URI authority', {authority: parsed.authority})
          Alert.alert(t('scan.errors.unsupportedTitle'), t('scan.errors.unsupportedLink'))
          return false
        }
      }
    }

    case 'brandLink': {
      const {action: brandAction, raw} = action

      if (brandAction.params.isSandbox === true && !__DEV__) {
        logger.info('QR scan: ignoring sandbox brand link in production', {useCase: brandAction.useCase})
        return false
      }

      /** Land this brand shape, or alert when the classifier will not describe it. */
      const landBrand = (): boolean => {
        const subject = subjectFromBrand(brandAction, raw)
        if (subject === null) {
          logger.info('QR scan: brand link the classifier will not describe', {useCase: brandAction.useCase})
          Alert.alert(t('scan.errors.unsupportedTitle'), t('scan.errors.unsupportedLink'))
          return false
        }
        logger.info('QR scan: brand link landed on the sheet', {useCase: brandAction.useCase, kind: subject.kind})
        return land(subject)
      }

      switch (brandAction.useCase) {
        case 'launch': {
          // The only brand shape with an "act" to withhold: a scan opens the browser
          // because the user pointed a camera at it, an external link asks first.
          logger.info('QR scan: brand browser launch', {dappUrl: brandAction.params.dappUrl, external})
          if (external) return landBrand()
          router.navigate({pathname: '/browser', params: {url: brandAction.params.dappUrl}})
          return true
        }

        // A partner payment shape, now read by the classifier like everything else.
        // On Cardano it becomes the same payment subject as before; on any other
        // chain the classifier names the chain, which beats the "unsupported" alert
        // that used to stand here. The comment justifying the hand-built subject —
        // "this brand shape is deliberately not a card" — stopped being true when it
        // became one.
        case 'request/crypto':
        // Superseded by CIP-13 `pay`, and described rather than refused.
        // `request/ada` carries a target list this funnel has no single-recipient
        // reading of, so it is named and offered nothing; `ada-with-link` nests a
        // CIP-13 URI the classifier unwraps into exactly the payment a DM card has
        // always shown for it.
        case 'request/ada':
        case 'request/ada-with-link':
        case 'order/show-create-result':
        // The two `pnyx://` shapes, which had no branch at all: they reached
        // `default: return false`, and `deep-link.tsx` turned that into a silent
        // bounce to home — so an invitation to join a shared wallet arrived as
        // nothing. The sheet gives a co-signer key its screen and an invite no
        // button, for the reason set out there.
        case 'invite':
        case 'cosigner-key':
        // A shared-wallet definition lands on the sheet like the other two: it
        // names the wallet and its roster, and the reader decides whether to add
        // it. Nothing in it can spend, so the gate is about consent, not risk.
        case 'wallet':
          return landBrand()

        default: {
          // The `never` is the point: it holds only while the cases above cover every
          // `BrandAction['useCase']`, so adding a brand shape without deciding how it
          // arrives from outside the app is a compile error here rather than a link
          // that quietly does nothing — which is exactly how the multisig pair got
          // lost. The old `default: return false` said nothing and caught nothing.
          const undecided: never = brandAction
          logger.warn('QR scan: brand link with no gate decision', {useCase: (undecided as BrandAction).useCase})
          return false
        }
      }
    }

    case 'url': {
      logger.info('QR scan: opening URL', {url: action.url, external})
      if (external) {
        const host = hostOfUrl(action.url)
        // No host, no card — the same refusal the classifier applies, so an
        // external link cannot open a page the sheet could not name.
        if (host !== null) return land({kind: 'other', action: {kind: 'dapp', url: action.url, host}})
      }
      router.navigate({pathname: '/browser', params: {url: action.url}})
      return true
    }

    case 'pnyxId': {
      // ⚠️ **`/dm/new` is the confirmation, so this needs no sheet.** It seeds the recipient field and
      // starts nothing — the user still sees whose id they scanned and taps to open the conversation.
      // There is no account to pick either: a DM is always from the identity wallet, never a funds
      // one. `external` is not branched on for the same reason, and because a bare id is not a URI
      // and so cannot arrive as a deep link in the first place.
      logger.info('QR scan: a pnyx_id, opening a new conversation with it', {external})
      router.navigate({pathname: '/dm/new', params: {peer: action.pnyxId}})
      return true
    }

    case 'unknown': {
      logger.info('QR scan: unrecognized content', {raw: action.raw})
      Alert.alert(t('scan.errors.unknown'), t('scan.errors.unknownMessage'))
      return false
    }
  }
}
