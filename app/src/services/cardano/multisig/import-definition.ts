/**
 * Turning a received definition into a wallet on this device.
 *
 * The decisions live here, pure, because all three are the kind that must be got
 * right rather than watched: which co-signer is *us*, whether we already have
 * this wallet, and what a local record made from someone else's definition may
 * and may not claim.
 *
 * @module
 */

import {Either} from 'effect'
import type {SharedWalletDefinition} from './definition-link'
import {templateToJson} from './template'
import type {CoSignerRef, SharedWallet} from './types'

/**
 * Which roster entry is this device's, by xpub.
 *
 * Compared case-insensitively on the hex, never by name: a name is the sender's
 * label for us and two participants may well have picked the same one. The xpub
 * is the only thing that identifies a co-signer, which is also why a definition
 * cannot say who "you" are — only the reading device can know that.
 */
export const selfTagIn = (definition: SharedWalletDefinition, ownXpubHex: string): CoSignerRef | null => {
  const wanted = ownXpubHex.toLowerCase()
  return definition.coSigners.find((c) => c.accountXpubHex.toLowerCase() === wanted) ?? null
}

/**
 * What makes two shared wallets the same wallet: the inputs the script address
 * is derived from, and nothing else.
 *
 * **Names are excluded on purpose.** The wallet's name and every co-signer's
 * name are labels — the receiver may rename the wallet, and two participants
 * routinely label the same person differently. Including them would make a
 * re-share after a rename import a *second* record for one address, showing as
 * two wallets with the same balance, each half-labelled. Tags travel with their
 * keys because a tag's position in the template is what binds a key to a leaf.
 */
const identityOf = (w: {
  readonly coSigners: readonly CoSignerRef[]
  readonly paymentTemplate: SharedWalletDefinition['paymentTemplate']
  readonly delegationTemplate: SharedWalletDefinition['delegationTemplate']
  readonly network: number
  readonly accountIndex: number
}): string =>
  JSON.stringify({
    net: w.network,
    ai: w.accountIndex,
    cs: [...w.coSigners]
      .map((c) => [c.tag, c.accountXpubHex.toLowerCase()])
      .sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')),
    pt: templateToJson(w.paymentTemplate),
    dt: templateToJson(w.delegationTemplate),
  })

/**
 * The wallet among `existing` that this definition already describes, if any.
 *
 * Re-importing must land on the wallet already here rather than adding another.
 */
export const existingForDefinition = (
  definition: SharedWalletDefinition,
  existing: readonly SharedWallet[],
): SharedWallet | null => {
  const wanted = identityOf(definition)
  return existing.find((w) => identityOf(w) === wanted) ?? null
}

/**
 * A `SharedWallet` from a definition plus the facts only this device knows.
 *
 * `createdAt` is when *we* imported it, never a value from the sender: their
 * timestamp would make a wallet that arrived a minute ago look like one that had
 * always been here, and it is the field the list sorts on.
 *
 * `registration` is deliberately left absent rather than guessed. `'skipped'`
 * would claim the builder chose not to publish, `'pending'` would claim someone
 * intends to, and `'published'` would claim it is on chain — three assertions
 * about a decision made on another device. Absent means what is true: unknown
 * from here. The chain search answers it, and publishing from this device sets it.
 */
export const definitionAsWallet = (
  definition: SharedWalletDefinition,
  local: {
    readonly id: string
    readonly createdAt: string
    /** Our own account xpub, when we know it — what marks a roster row as ours. */
    readonly selfXpubHex?: string
    /** The wallet group whose seed backs our key. Only meaningful with `selfXpubHex`. */
    readonly selfGroupId?: string
  },
): SharedWallet => {
  const self = local.selfXpubHex === undefined ? null : selfTagIn(definition, local.selfXpubHex)
  return {
    id: local.id,
    name: definition.name,
    coSigners: definition.coSigners.map((c) => (self !== null && c.tag === self.tag ? {...c, isSelf: true} : c)),
    paymentTemplate: definition.paymentTemplate,
    delegationTemplate: definition.delegationTemplate,
    network: definition.network,
    accountIndex: definition.accountIndex,
    // Only when our key is actually in the roster. A wallet we are not part of is
    // still worth holding — it can be watched — but claiming a signing group for
    // it would offer a witness this device cannot produce.
    ...(self !== null && local.selfGroupId !== undefined ? {selfGroupId: local.selfGroupId} : {}),
    createdAt: local.createdAt,
  }
}

export type ImportRefusal =
  /** Already on this device — carries it, so the caller can open it instead. */
  | {readonly kind: 'already-present'; readonly wallet: SharedWallet}
  /** The definition is for another network than the one the app is on. */
  | {readonly kind: 'wrong-network'; readonly definitionNetwork: number}

/**
 * Whether a definition can be imported as it stands.
 *
 * The network check is not pedantry: the registry is keyed by network, so a
 * mainnet wallet imported while the app is on preprod would be saved under the
 * wrong scope, vanish from the list on switching back, and derive addresses
 * nobody can fund. Better to say which network it wants.
 */
export const checkImport = (
  definition: SharedWalletDefinition,
  context: {readonly activeNetwork: number; readonly existing: readonly SharedWallet[]},
): Either.Either<SharedWalletDefinition, ImportRefusal> => {
  if (definition.network !== context.activeNetwork)
    return Either.left({kind: 'wrong-network', definitionNetwork: definition.network})
  const already = existingForDefinition(definition, context.existing)
  return already === null ? Either.right(definition) : Either.left({kind: 'already-present', wallet: already})
}
