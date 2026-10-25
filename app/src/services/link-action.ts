/**
 * What a link inside a message is asking for.
 *
 * A message body is a UTF-8 string, and a link in one is an action the app can
 * carry out — pay a request, delegate a stake, open a dApp, join a shared wallet.
 * Rendered raw it is a wall of URL: technically actionable, practically not. This
 * turns one into a description a card can show.
 *
 * **Standard links first.** `web+cardano:` is the Cardano URI family and most of
 * these already have an authority there: CIP-13 `pay` for a payment request and
 * `stake` for pool delegation, `drep` for a DRep, CIP-158 `browse` for a dApp
 * hand-off. Those are what every other wallet emits and reads, so a card that only
 * understood a Pnyx-specific spelling would be a card that works between two
 * copies of this app and nowhere else. The `pnyx://` scheme is kept for what has
 * no standard — the CIP-1854 co-signer exchange, which no CIP describes.
 *
 * Three properties matter more than tidiness, and they are the reasons this is a
 * classifier rather than a renderer that parses as it goes:
 *
 * - **Total.** A body that is not one of these *is* chat. `null` is the common
 *   answer, there are no heuristics, and nobody pasting a link into conversation
 *   can be mistaken for making a request.
 * - **Describes, never performs.** Every case yields a title, a plain sentence
 *   about what would happen, and the parameters worth reading — and nothing that
 *   executes. Acting is the screen's decision after a tap, on the real flow, with
 *   the real confirmation. A card that could act would be a message that spends
 *   money.
 * - **Refuses what it cannot describe.** A link whose own fields are blank or
 *   absurd is not rendered as a card, because a card that cannot say what it does
 *   is asking for consent to something unnamed. It falls back to chat, where the
 *   user sees the URL and decides for themselves.
 *
 * Shared by DM threads and circle channels: the same string means the same thing
 * in both, and a second classifier would be a second answer to the same question.
 *
 * @module
 */

import {
  Authorities,
  type BrandAction,
  isCardanoUri,
  type ParsedUri,
  PNYX_SCHEME,
  parse,
  parseBrandLink,
} from '@pnyx/links'
import {Effect, Either} from 'effect'
import {hostOfUrl} from '../utils/url-host'
import {parseEnvelope} from './cardano/cosign/envelope'
import type {TxEnvelope} from './cardano/cosign/types'
import {readCoSignerKey} from './cardano/multisig/cosigner-invite'
import {type SharedWalletDefinition, unpackDefinition} from './cardano/multisig/definition-link'
import {isPoolId} from './cardano/staking/pool-id'
import {txHashOf} from './cardano/tx-hash'
import {type DRepTarget, parseDRepTarget} from './cardano-pool-drep/drep-id'

/** A blank or absurd field means the card cannot say what it is for. */
const MAX_NAME = 64
/** Long enough for any real URL, short enough that a card can show its host. */
const MAX_URL = 2048

export type LinkAction =
  /**
   * Someone assembling a shared wallet, asking for our co-signer key.
   *
   * No fields: the request carries nothing, and the conversation it arrived in
   * already says who is asking.
   */
  | {readonly kind: 'multisig-invite'}
  /** Someone's CIP-1854 account key, usually answering such a request. */
  | {readonly kind: 'cosigner-key'; readonly accountXpubHex: string}
  /**
   * An invitation to message someone (`docs/ABUSE_MITIGATION.md` §5).
   *
   * ⚠️ The card cannot say **who** is inviting without opening the token, and it must not claim
   * anything it has not checked — the issuer is read out of the permit's own `sub`, never from the
   * link, and the service is what actually verifies it.
   */
  | {readonly kind: 'dm-invite'; readonly permit: string}
  /**
   * A request to be paid — CIP-13 `pay` or CIP-157 `pay/v1`. `lovelace` is `null`
   * for an open request: the URI carried no amount, so the payer chooses.
   *
   * No chain field, because neither CIP has one. A Cardano address states its own
   * network in its bytes, so the reader checks the address rather than a claim
   * beside it — and there is no way for the two to disagree.
   *
   * `paymentId` only ever arrives from CIP-157; CIP-13 has no such field.
   *
   * `asksForAssets` says a CIP-157 request also wanted native tokens **without
   * carrying which ones in a usable form**. It names them by CIP-14 fingerprint, a
   * one-way hash of (policy, name), recoverable only by matching against assets the
   * payer already holds — which this app does not do. The fingerprints are therefore
   * not surfaced (they would be unreadable noise), but the flag is: paying the ADA
   * and saying nothing would look complete and arrive short of what was asked for.
   */
  | {
      readonly kind: 'payment-request'
      readonly address: string
      readonly lovelace: bigint | null
      readonly message: string | undefined
      /** An invoice or order reference the requester wants echoed back. */
      readonly paymentId: string | undefined
      readonly asksForAssets: boolean
    }
  /**
   * A stake pool to delegate to — CIP-13 `stake`.
   *
   * `poolId` has decoded as a `pool1…` bech32 over a 28-byte key hash, so the
   * delegation flow can build a certificate from it. An id that does not is not
   * carded: the card would offer a delegation that fails at certificate build.
   */
  | {readonly kind: 'stake-delegation'; readonly poolId: string}
  /**
   * A DRep to delegate voting power to.
   *
   * `target` is the **canonical** form — CIP-129 and legacy CIP-105 share the
   * `drep` hrp, so only the canonical shape compares correctly against what the
   * account is already delegated to. `drepId` is kept for display, as received.
   *
   * Deliberately no display *name*: it would be a string of the sender's choosing
   * rendered next to someone else's id, which is a place to put a lie. The screen
   * resolves the name from the DRep register or shows the id.
   */
  | {readonly kind: 'drep-delegation'; readonly drepId: string; readonly target: DRepTarget}
  /** A dApp to open in the in-app browser — CIP-158 `browse`, or the brand link. */
  | {readonly kind: 'dapp'; readonly url: string; readonly host: string}
  /**
   * A faucet token claim — CIP-99 `claim`.
   *
   * The one link that *sends* something rather than receiving it: the claim is a
   * POST of the user's receiving address and the code to a server named by the
   * link. That is why the host is carried separately and refused when it will not
   * parse — the screen's whole consent question is "send your address to *whom*",
   * and a claim that cannot name the recipient cannot ask it.
   *
   * `params` are the link's own extra query parameters, which CIP-99 requires be
   * forwarded to the faucet unmodified.
   */
  | {
      readonly kind: 'claim'
      readonly faucetUrl: string
      readonly host: string
      readonly code: string
      readonly params: Readonly<Record<string, string>>
    }
  /**
   * A bare Cardano address someone wants paid — `web+cardano://address`.
   *
   * The CIP calls this "view an address", but an address arriving in a message is
   * one somebody wants used, and this app has no address viewer to send it to. So
   * it opens the payment sheet with no amount, which is exactly an open request,
   * and the card says "address" rather than dressing it up as a request for a sum
   * nobody named.
   */
  | {readonly kind: 'address'; readonly address: string}
  /**
   * A transaction to open in the app's own review. `/wallet/tx/<hash>` renders any
   * on-chain transaction, not only ours — the dev lookup screen is a hash field in
   * front of exactly that — so there is no reason to hand this to a browser.
   *
   * `hash` has passed {@link txHashOf}, so the screen it opens has something it can
   * actually fetch.
   */
  | {readonly kind: 'transaction'; readonly hash: string}
  /**
   * A block to look at. Unlike a transaction this has no in-app viewer, so the
   * honest destination is the explorer the user chose in settings — not one picked
   * here.
   */
  | {readonly kind: 'explorer'; readonly target: 'block'; readonly id: string}
  /**
   * A link this build can name but not carry out.
   *
   * Named rather than dropped: a wall of URL in a thread tells the reader nothing,
   * and "we know what this is and cannot do it" is a better answer than silence.
   * It offers no action, which is the point — every one of these is a flow this
   * build does not have, or one whose own entry point is the only safe way in.
   */
  /**
   * A shared-wallet transaction waiting for this device's signature.
   *
   * **Not a link, and it cannot be one.** An envelope carries the transaction
   * body, the native scripts authorising it and every witness gathered so far —
   * kilobytes. That fits no URI and no QR, so it travels as the message body
   * itself, which is also why it is read here rather than parsed at the screen:
   * the thread has to know a co-sign request is one to draw a card for it.
   */
  | {readonly kind: 'cosign-request'; readonly envelope: TxEnvelope}
  /**
   * An address to track as a watch-only wallet, with an optional label.
   *
   * The one hand-off that is safe to act on from a message, because it carries a
   * public address and nothing else: no key material, no signing capability, and
   * nothing the receiving wallet adds can be spent by the sender.
   */
  | {readonly kind: 'watch-only'; readonly address: string; readonly name: string | undefined}
  /**
   * An encrypted wallet backup (CIP-0301).
   *
   * Acted on, behind a warning. Restoring is not dangerous to *this* device — the
   * payload is encrypted and the importer needs its password — but a backup you
   * were handed is a seed its sender kept, and a shared seed is not a wallet you
   * control: anything funded there can be swept by whoever else holds it. The
   * warning says that; the decision is the reader's.
   */
  | {readonly kind: 'backup'; readonly link: string}
  /**
   * A whole shared-wallet definition: the roster, the spending rule and the
   * network its addresses derive from.
   *
   * Acted on, and safe to be: every value in it is public, so holding it lets
   * the reader watch the wallet and spend nothing. It is how a participant
   * receives the wallet they gave a key to, and how one who lost it gets it back.
   */
  | {readonly kind: 'shared-wallet'; readonly definition: SharedWalletDefinition}
  | {
      readonly kind: 'named-only'
      /** i18n key under `linkAction.namedOnly`. */
      readonly what: 'connect' | 'legacyTransfer' | 'transferTargets' | 'exchangeResult' | 'otherChain'
      /** The one detail worth showing — a chain, a provider, a faucet. */
      readonly detail: string | undefined
    }

const named = (value: string | undefined, max = MAX_NAME): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' || trimmed.length > max ? null : trimmed
}

/** Read a parsed brand action as something a card can describe. */
export const linkActionOf = (action: BrandAction, raw: string): LinkAction | null => {
  switch (action.useCase) {
    case 'invite': {
      // ⚠️ Two features share this use case. Discriminate on the feature, not the shape of the
      // params — a DM invite carries none of the multisig fields and would fall through as `null`,
      // which reads as "malformed link" for a link that is perfectly well formed.
      if (action.feature === 'dm') {
        const permit = named(action.params.permit, 4096)
        return permit === null ? null : {kind: 'dm-invite', permit}
      }
      return {kind: 'multisig-invite'}
    }

    case 'wallet': {
      // Through the codec, like a co-signer key: a definition that does not decode
      // into a valid roster and template is not a wallet, and a card describing
      // one would be describing nothing.
      const parsed = unpackDefinition(action.params.def)
      return Either.isRight(parsed) ? {kind: 'shared-wallet', definition: parsed.right} : null
    }

    case 'cosigner-key': {
      // Through the codec rather than the raw param: a key that will not decode
      // cannot be bound into a spending policy, so it is not offered as one.
      const parsed = readCoSignerKey(raw)
      return Either.isRight(parsed) ? {kind: 'cosigner-key', accountXpubHex: parsed.right} : null
    }

    case 'launch': {
      const url = named(action.params.dappUrl, MAX_URL)
      if (url === null) return null
      const host = hostOfUrl(url)
      // No host, no card. "Open a dApp" without saying where is the one thing a
      // card like this must never do.
      return host === null ? null : {kind: 'dapp', url, host}
    }

    case 'request/crypto': {
      // A partner shape rather than the standard one, but it carries an address and
      // an amount, so on Cardano it is a payment request like any other. On any
      // other chain it is named and not offered: this build sends on none of them.
      const {chain, address, amount} = action.params
      if (!chain.startsWith('cardano:')) return {kind: 'named-only', what: 'otherChain', detail: chain}
      const to = named(address, 256)
      if (to === null) return null
      return {
        kind: 'payment-request',
        address: to,
        lovelace: amount === undefined || amount === '' ? null : BigInt(amount),
        message: named(action.params.name, 256) ?? undefined,
        paymentId: undefined,
        asksForAssets: false,
      }
    }

    case 'request/ada-with-link': {
      // A CIP-13 URI wrapped in a brand link. Unwrapped and read by the same rule,
      // so the card is the one the inner link deserves — recursion of one step,
      // since the inner link is a `web+cardano:` URI and cannot nest another brand
      // link inside it.
      return readLinkAction(action.params.link)
    }

    // Superseded by CIP-13 `pay`, and it carries a list of targets this funnel has
    // no single-recipient reading of. Named, not acted on — and with no detail,
    // since a bare recipient count on its own line reads as noise.
    case 'request/ada':
      return {kind: 'named-only', what: 'transferTargets', detail: undefined}

    case 'order/show-create-result':
      return {kind: 'named-only', what: 'exchangeResult', detail: action.params.provider}
  }
}

/** Read a parsed `web+cardano:` URI as something a card can describe. */
export const linkActionOfUri = (uri: ParsedUri): LinkAction | null => {
  switch (uri.authority) {
    case 'pay': {
      const address = named(uri.address, 256)
      if (address === null) return null
      // A zero amount reads as open: a request for nothing is not a request for
      // zero. The parser already rejected a negative one.
      return {
        kind: 'payment-request',
        address,
        lovelace: uri.amount === undefined || uri.amount === 0n ? null : uri.amount,
        message: named(uri.message, 256) ?? undefined,
        paymentId: undefined,
        // CIP-13 predates native assets entirely, so it cannot have asked.
        asksForAssets: false,
      }
    }

    case 'pay-v1': {
      const address = named(uri.address, 256)
      if (address === null) return null
      // The rest of CIP-157 is a plain improvement on CIP-13 and does become a card:
      // a note (capped at 64 characters by the parser) and a payment reference. A
      // token request is carried as a *flag* — the fingerprints themselves are
      // unreadable and unusable, but the fact one was asked for has to reach the
      // payer or they would think the ADA settled it.
      return {
        kind: 'payment-request',
        address,
        lovelace: uri.lovelace === undefined || uri.lovelace === 0n ? null : uri.lovelace,
        message: uri.note,
        paymentId: uri.paymentId,
        asksForAssets: uri.assets.length > 0,
      }
    }

    case 'stake': {
      const poolId = named(uri.poolId, 128)
      // Through the decoder, not the string: a card that offers to delegate to
      // something that is not a pool id is a card whose action cannot run.
      return poolId === null || !isPoolId(poolId) ? null : {kind: 'stake-delegation', poolId}
    }

    case 'drep': {
      const drepId = named(uri.drepId, 128)
      if (drepId === null) return null
      // Canonicalised here rather than at the screen, for the same reason: an id
      // that will not parse cannot be delegated to, so it is not offered. This
      // also accepts the `abstain` / `no confidence` literals, which are real
      // delegation targets and not ids at all.
      const target = parseDRepTarget(drepId)
      return target === null ? null : {kind: 'drep-delegation', drepId, target}
    }

    case 'browse': {
      // The parser has already constrained this to http(s), so the host is the
      // only thing left to establish — and a card that cannot name where it goes
      // is not offered.
      const host = hostOfUrl(uri.uri)
      return host === null ? null : {kind: 'dapp', url: uri.uri, host}
    }

    case 'address': {
      const address = named(uri.address, 256)
      return address === null ? null : {kind: 'address', address}
    }

    case 'transaction': {
      // Through the hash rule, not the string: the review screen fetches by id, so
      // a card offering to open something that is not one would 404 after the tap.
      const hash = uri.hash === undefined ? null : txHashOf(uri.hash)
      return hash === null ? null : {kind: 'transaction', hash}
    }

    case 'block': {
      const id = named(uri.hash, 128)
      return id === null ? null : {kind: 'explorer', target: 'block', id}
    }

    // The one hand-off safe to act on from a message: a public address, nothing else.
    case 'watch':
      return {kind: 'watch-only', address: uri.address, name: uri.name}

    // Acted on behind a warning. The payload is encrypted and useless without its
    // password, so this device is not at risk; the risk is that a seed you were
    // handed is one its sender kept. The card says so and lets the reader decide.
    case 'backup':
      // Rebuilt from the payload rather than carried through: the classifier is
      // handed a parsed URI, and the scanner has no raw string to pass on anyway.
      // ⚠️ Not byte-identical to an inbound link: the exporter emits `?v=1&enc=…`
      // (the published CIP-0301 form) and this emits the parsed params in insertion
      // order. Both parse to the same envelope, and the only consumer re-parses.
      return {kind: 'backup', link: Authorities.Backup.build(uri.enc, uri.params)}

    // The only `web+cardano` authority this app answers by talking to a server. It
    // needs a host it can name, for the reason set out on the kind.
    case 'claim': {
      const host = hostOfUrl(uri.faucetUrl)
      return host === null ? null : {kind: 'claim', faucetUrl: uri.faucetUrl, host, code: uri.code, params: uri.params}
    }

    // Named, never acted on. Each is a flow this build does not have, or one whose
    // own entry point is the only safe way in.
    case 'connect':
      return {kind: 'named-only', what: 'connect', detail: undefined}
    case 'legacy-transfer':
      return {kind: 'named-only', what: 'legacyTransfer', detail: undefined}
  }
}

/**
 * Classify a message body, or `null` when it is ordinary conversation.
 *
 * `null` is by far the common case and is not a failure — every message rendered
 * in a thread or a channel goes through here.
 *
 * `web+cardano:` is tried first because it is the standard family and the one a
 * message is most likely to carry; `pnyx://` covers what no CIP describes.
 */
export const readLinkAction = (text: string): LinkAction | null => {
  const trimmed = text.trim()
  // A co-sign envelope is JSON, not a URI, so it is tried first and gated on the
  // one character that can start one. Without the gate every ordinary message
  // would pay for a `JSON.parse` on a string that was never going to be an
  // envelope, once per render of the thread.
  if (trimmed.startsWith('{')) {
    const envelope = Effect.runSync(Effect.either(parseEnvelope(trimmed)))
    return Either.isRight(envelope) ? {kind: 'cosign-request', envelope: envelope.right} : null
  }
  if (isCardanoUri(trimmed)) {
    const parsed = Effect.runSync(Effect.either(parse(trimmed)))
    return Either.isRight(parsed) ? linkActionOfUri(parsed.right) : null
  }
  const action = parseBrandLink(trimmed, PNYX_SCHEME)
  return action === null ? null : linkActionOf(action, trimmed)
}
