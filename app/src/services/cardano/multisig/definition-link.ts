/**
 * The whole shared-wallet definition, as one link.
 *
 * A co-signer key travels one way — each participant hands theirs to whoever is
 * assembling the wallet. Nothing carried the result *back*: the builder ended up
 * with a wallet on their phone, and every other participant had given away a key
 * and received nothing they could open. This is the return leg, and it is also
 * how a participant who lost the wallet gets it again.
 *
 * **Why the definition and not the registration.** The CIP-146 registration on
 * chain carries the compiled scripts and the display names, so a reader can find
 * a wallet they are in — but a script holds key *hashes*, and an address at index
 * 5 needs the co-signers' account xpubs. A wallet rebuilt from the chain could
 * watch one address and never derive another. What participants need from each
 * other is the same thing CIP-1854 says they exchange: the templates plus the
 * tag→xpub roster.
 *
 * **Why a packed payload rather than named params.** The roster is a list, and a
 * link cannot carry one without inventing an indexing convention that then has to
 * be parsed defensively at the far end. One opaque, versioned blob keeps the link
 * layer free of the wallet model — `@pnyx/links` stays a URL codec and does not
 * learn what a script template is — and keeps the reader total: it either decodes
 * to a valid definition or it does not.
 *
 * **Nothing here is secret.** Every value is a public key or a policy; the link
 * grants nothing. Anyone holding it can watch the wallet, which is already true
 * of anyone who can read the chain, and can spend nothing without the quorum's
 * private halves.
 *
 * @module
 */

import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {base64, utf8} from '@pnyx/crypto'
import {
  type BrandAction,
  type BrandLinkScheme,
  buildBrandLink,
  type MultisigWalletDefinition,
  PNYX_SCHEME,
} from '@pnyx/links'
import {Either} from 'effect'
import {logger} from '../../../logger'
import {validateSharedWallet} from './model'
import {type ScriptTemplate, type TemplateJson, templateFromJson, templateToJson} from './template'
import type {CoSignerRef, SharedWallet} from './types'

/**
 * Bumped only for a change a v1 reader would misread. New *optional* fields do
 * not need it — an older reader ignoring one still builds the same wallet, which
 * is the property the short keys below are chosen to preserve.
 */
const VERSION = 1

const ORIGIN = 'definition-link'

const MAX_NAME = 64
const MAX_COSIGNER_NAME = 64
/** Belt for the reader: a roster this long cannot fit a scannable QR anyway. */
const MAX_COSIGNERS = 16
/** 32-byte public key ‖ 32-byte chain code, hex. */
const XPUB_HEX_LENGTH = 128

export type DefinitionFailure =
  /** Not base64, not JSON, or not an object. */
  | {readonly kind: 'unreadable'}
  /** A version this build cannot read. Carries what it saw, so the UI can say so. */
  | {readonly kind: 'version'; readonly saw: number}
  /** Structurally decoded, but not a wallet: bad roster, bad template, bad network. */
  | {readonly kind: 'invalid'; readonly field: string}

/**
 * What a definition link carries: everything needed to derive the same addresses
 * as every other participant, and nothing else.
 *
 * Not a `SharedWallet`: no local id, no `selfGroupId`, no `createdAt`, no
 * registration state. Those are facts about *a device's* copy of the wallet, and
 * a sender's copy of them is wrong on the receiver's phone — `createdAt` most of
 * all, which would make an import look like it had always been there.
 */
export type SharedWalletDefinition = {
  readonly name: string
  readonly coSigners: readonly CoSignerRef[]
  readonly paymentTemplate: ScriptTemplate
  readonly delegationTemplate: ScriptTemplate
  readonly network: Address.Network
  readonly accountIndex: number
}

type WireDefinition = {
  readonly v: number
  readonly n: string
  /** `Address.Network`: 1 mainnet, 0 testnet. The numeric form the model uses. */
  readonly net: number
  readonly ai: number
  readonly cs: readonly {readonly t: string; readonly n: string; readonly k: string}[]
  readonly pt: TemplateJson
  /** Omitted when it is structurally identical to `pt`, which is the usual case. */
  readonly dt?: TemplateJson
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** URL-safe and unpadded, so the payload survives a query string and a QR alike. */
const toBase64Url = (bytes: Uint8Array): string =>
  base64.encode(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/**
 * Pack a definition into the payload a link carries.
 *
 * Takes the definition fields, which a persisted `SharedWallet` satisfies — so
 * both callers (sharing our own wallet, forwarding one that arrived) use the same
 * function, and the device-local fields are dropped here rather than at each
 * call site.
 */
export const packDefinition = (wallet: SharedWalletDefinition): string => {
  const payment = templateToJson(wallet.paymentTemplate)
  const delegation = templateToJson(wallet.delegationTemplate)
  const wire: WireDefinition = {
    v: VERSION,
    n: wallet.name,
    net: wallet.network,
    ai: wallet.accountIndex,
    cs: wallet.coSigners.map((c) => ({t: c.tag, n: c.name, k: c.accountXpubHex})),
    pt: payment,
    // Structural equality over the JSON, so the common case — the two templates
    // identical — costs one copy on the wire instead of two.
    ...(JSON.stringify(payment) === JSON.stringify(delegation) ? {} : {dt: delegation}),
  }
  return toBase64Url(utf8.encode(JSON.stringify(wire)))
}

/**
 * Read a packed payload back.
 *
 * Total and unforgiving: a definition drives address derivation for everyone in
 * the wallet, so a field that does not parse is a refusal rather than a default.
 * A roster entry with no name is the one exception — the sender may not have
 * known it, and `isSelf` is deliberately absent from the wire: which participant
 * is "you" is a fact about the reading device, never the sender's to assert.
 */
export const unpackDefinition = (packed: string): Either.Either<SharedWalletDefinition, DefinitionFailure> => {
  const bytes = base64.decode(packed)
  if (Either.isLeft(bytes)) return Either.left({kind: 'unreadable'})
  const text = utf8.decode(bytes.right)
  if (Either.isLeft(text)) return Either.left({kind: 'unreadable'})

  let parsed: unknown
  try {
    parsed = JSON.parse(text.right)
  } catch (error) {
    // `debug`, not `warn`: a payload that is not JSON means the link was truncated
    // or hand-edited, which the caller surfaces to the user. Still logged — "this
    // link carries no wallet" and "the JSON was malformed" are different facts.
    logger.debug('shared wallet definition: the payload was not JSON', {origin: ORIGIN, error: String(error)})
    return Either.left({kind: 'unreadable'})
  }
  if (!isRecord(parsed)) return Either.left({kind: 'unreadable'})
  if (typeof parsed.v !== 'number') return Either.left({kind: 'unreadable'})
  if (parsed.v !== VERSION) return Either.left({kind: 'version', saw: parsed.v})

  const name = typeof parsed.n === 'string' ? parsed.n.trim() : ''
  if (name === '' || name.length > MAX_NAME) return Either.left({kind: 'invalid', field: 'name'})

  // Only the two values the address codec knows. Anything else derives addresses
  // for a network that does not exist.
  if (parsed.net !== Address.Network.Mainnet && parsed.net !== Address.Network.Testnet)
    return Either.left({kind: 'invalid', field: 'network'})

  if (typeof parsed.ai !== 'number' || !Number.isInteger(parsed.ai) || parsed.ai < 0)
    return Either.left({kind: 'invalid', field: 'accountIndex'})

  if (!Array.isArray(parsed.cs) || parsed.cs.length === 0 || parsed.cs.length > MAX_COSIGNERS)
    return Either.left({kind: 'invalid', field: 'coSigners'})

  const coSigners: CoSignerRef[] = []
  for (const entry of parsed.cs) {
    if (!isRecord(entry)) return Either.left({kind: 'invalid', field: 'coSigners'})
    const tag = typeof entry.t === 'string' ? entry.t : ''
    const key = typeof entry.k === 'string' ? entry.k.toLowerCase() : ''
    if (tag === '') return Either.left({kind: 'invalid', field: 'tag'})
    if (key.length !== XPUB_HEX_LENGTH || !/^[0-9a-f]+$/.test(key)) return Either.left({kind: 'invalid', field: 'key'})
    const coSignerName = typeof entry.n === 'string' ? entry.n.trim().slice(0, MAX_COSIGNER_NAME) : ''
    coSigners.push({tag, name: coSignerName, accountXpubHex: XpubHex(key)})
  }

  const paymentTemplate = templateFromJson(parsed.pt)
  if (paymentTemplate === null) return Either.left({kind: 'invalid', field: 'paymentTemplate'})
  const delegationTemplate = parsed.dt === undefined ? paymentTemplate : templateFromJson(parsed.dt)
  if (delegationTemplate === null) return Either.left({kind: 'invalid', field: 'delegationTemplate'})

  // The same check the create screen runs before building: every tag the template
  // references must be in the roster, and no two co-signers may share a key. A
  // definition failing either is not a wallet, however well-formed the JSON is.
  const problems = validateSharedWallet({coSigners, paymentTemplate, delegationTemplate})
  if (problems.length > 0) return Either.left({kind: 'invalid', field: problems[0]?.kind ?? 'template'})

  return Either.right({
    name,
    coSigners,
    paymentTemplate,
    delegationTemplate,
    network: parsed.net,
    accountIndex: parsed.ai,
  })
}

/** The link that carries a wallet's definition — the same string for a QR, a DM and a share sheet. */
export const buildDefinitionLink = (wallet: SharedWallet, scheme: BrandLinkScheme = PNYX_SCHEME): string => {
  const params: MultisigWalletDefinition = {def: packDefinition(wallet)}
  return buildBrandLink({feature: 'multisig', useCase: 'wallet', params}, scheme)
}

/**
 * The largest definition link worth drawing as a QR, in characters.
 *
 * The payload is base64url in a URL — mixed case, so a QR encodes it in *byte*
 * mode, not the denser alphanumeric one. Version 25 at error-correction level L
 * holds 1,273 bytes, and past roughly that a code stops resolving from a phone
 * screen held at arm's length: the modules get smaller than the camera can
 * separate. Measured payloads: 713 characters for two co-signers, 990 for three,
 * 1,545 for five. So a QR serves the common shared wallet and stops being
 * offered for a large roster, which goes as a link or a message instead.
 */
export const QR_LINK_CEILING = 1_273

/** Whether this link can be drawn as a QR someone can actually scan. */
export const definitionFitsQr = (link: string): boolean => link.length <= QR_LINK_CEILING

/** The definition inside a parsed brand link, or `null` when it is not one. */
export const definitionOfAction = (
  action: BrandAction,
): Either.Either<SharedWalletDefinition, DefinitionFailure> | null =>
  action.feature === 'multisig' && action.useCase === 'wallet' ? unpackDefinition(action.params.def) : null
