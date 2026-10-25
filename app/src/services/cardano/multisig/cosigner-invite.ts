/**
 * Publishing and reading a co-signer key.
 *
 * The payload is public — an account xpub is exposed the moment the wallet
 * transacts — so this was never about secrecy.
 *
 * **It carries the key and nothing else.** It used to travel with a display name
 * the sender proposed and the CIP-1854 account index it was taken at. The name
 * belongs to whoever is assembling the roster: a name chosen by the person asking
 * to be admitted to a spending policy arrived pre-filled in the list the builder
 * was meant to be checking. The account index decorated nothing — addresses
 * derive from the xpub, and a shared wallet records the builder's account index
 * rather than each sender's.
 *
 * One key, three carriers: a QR code, a `pnyx://` deep link, and the share sheet
 * all render the same string, and one reader accepts any of them — including a
 * bare `acct_shared_xvk…` from another wallet's QR.
 *
 * @module
 */

import {buildBrandLink, type MultisigCoSignerKey, PNYX_SCHEME, parseBrandLink} from '@pnyx/links'
import {Either} from 'effect'
import {decodeAccountXvk, encodeAccountXvk} from './shared-key'

export type InviteParseError = {readonly kind: 'not-a-cosigner-link'} | {readonly kind: 'bad-key'}

/**
 * The shareable link for a co-signer key.
 *
 * `https` is offered so the link still resolves for someone who does not have
 * the app installed; the app scheme is the default because it opens directly.
 */
export const buildCoSignerLink = (
  accountXpubHex: string,
  scheme: typeof PNYX_SCHEME | 'https' = PNYX_SCHEME,
): Either.Either<string, InviteParseError> => {
  const key = encodeAccountXvk(accountXpubHex)
  if (Either.isLeft(key)) return Either.left({kind: 'bad-key'})
  const params: MultisigCoSignerKey = {key: key.right}
  return Either.right(buildBrandLink({feature: 'multisig', useCase: 'cosigner-key', params}, scheme))
}

/**
 * Read a scanned, pasted or received value as a co-signer key.
 *
 * Accepts the deep link *or* a bare `acct_shared_xvk…`, because a QR from another
 * wallet carries the bech32 alone. Two functions used to split that job — one for
 * each carrier — which meant every caller had to try both and decide what a
 * failure of the first meant.
 *
 * A link from an older build carries a name and an account index; both are
 * ignored here rather than refused, so an invite answered from a phone that has
 * not been updated still works.
 */
export const readCoSignerKey = (text: string): Either.Either<string, InviteParseError> => {
  const trimmed = text.trim()
  const action = parseBrandLink(trimmed, PNYX_SCHEME)
  if (action !== null) {
    if (action.feature !== 'multisig' || action.useCase !== 'cosigner-key') {
      return Either.left({kind: 'not-a-cosigner-link'})
    }
    const decoded = decodeAccountXvk(action.params.key)
    return Either.isLeft(decoded) ? Either.left({kind: 'bad-key'}) : Either.right(decoded.right)
  }
  const bare = decodeAccountXvk(trimmed)
  return Either.isRight(bare) ? Either.right(bare.right) : Either.left({kind: 'not-a-cosigner-link'})
}
