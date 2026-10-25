/**
 * Composing the multisig messages that go inside a DM.
 *
 * Reading one back is not here: any `pnyx://` link in a message is classified by
 * `services/link-action.ts`, which covers every action kind and is shared by DM
 * threads and circle channels. A multisig-only reader lived here and was replaced
 * by it — two classifiers would be two answers to "what is this link".
 *
 * The DM transport moves a UTF-8 string, so a structured message has to be one.
 * It is a `pnyx://` brand link — the same string the QR code and the share sheet
 * already carry — rather than a bespoke JSON envelope, for three reasons that
 * all matter more than tidiness:
 *
 * - **It degrades.** A recipient on an older build, or reading the thread
 *   somewhere else entirely, sees a link they can act on rather than a blob of
 *   JSON that means nothing.
 * - **It cannot be confused with a person talking.** A plain message never
 *   parses as a brand action, so classification is total: everything that is not
 *   one of these *is* chat, with no heuristics and no false positives on someone
 *   pasting a link into conversation.
 * - **It is already the format.** The link layer, its parser and the co-signer
 *   key codec exist and are tested; a second wire format for the same payloads
 *   would be a second thing to keep in step.
 *
 * @module
 */

import {buildBrandLink, PNYX_SCHEME} from '@pnyx/links'
import {Either} from 'effect'
import {buildCoSignerLink} from './cosigner-invite'

/**
 * The message body that asks someone for their co-signer key.
 *
 * It carries nothing but the request. See {@link MultisigInvite} for why the
 * wallet's name, the sender's name and the correlation id all went away.
 */
export const buildInviteMessage = (): string =>
  buildBrandLink({feature: 'multisig', useCase: 'invite', params: {}}, PNYX_SCHEME)

/**
 * The message body that answers a request with our own key.
 *
 * The same builder the QR and the share sheet use, so a key sent over a DM and a
 * key shown on screen are the same string — one of them being subtly different is
 * exactly the kind of divergence that only shows up when an address does not
 * match.
 */
export const buildCoSignerKeyMessage = (accountXpubHex: string): Either.Either<string, 'bad-key'> => {
  const link = buildCoSignerLink(accountXpubHex)
  return Either.isRight(link) ? Either.right(link.right) : Either.left('bad-key')
}
