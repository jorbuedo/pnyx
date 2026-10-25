/**
 * CIP-1854 shared-wallet model: build a wallet from a roster + template, and
 * read quorum state off a set of collected witnesses.
 *
 * A wallet is co-signers' account xpubs plus two script templates; the scripts
 * and addresses derive from those (`derive.ts`), so nothing address-shaped is
 * stored. Signing reuses the signing service's `partial` + `nativeScripts` path
 * with a CIP-1854 signing path — there is no bespoke signing primitive here.
 *
 * @module
 */

import {XprvHex} from '@evolution-sdk/review/Brands'
import {Keys} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'
import {paymentKeyHashes} from './derive'
import {
  type CoSignerTag,
  isSatisfied,
  type ScriptTemplate,
  signPolicy,
  type TemplateProblem,
  tagAt,
  validateTemplate,
} from './template'
import type {CoSignerRef, SharedWallet} from './types'

export type {CoSignerRef, SharedWallet} from './types'

const HARDENED = 0x80000000

/**
 * Derive THIS wallet's CIP-1854 account xpub — the value a co-signer publishes.
 *
 * Level 3 (`m/1854'/1815'/account'`), because that is what CIP-1854 says
 * participants exchange, and what lets every other participant derive this
 * wallet's key at any index without ever seeing a private key.
 */
export const deriveOwnAccountXpub = (
  rootXprvHex: string,
  /** Required: the derived key and the index it is published under must come from one value. */
  account: number,
): Effect.Effect<string, CoreError> =>
  Keys.derivePath(XprvHex(rootXprvHex), [
    (1854 | HARDENED) >>> 0,
    (1815 | HARDENED) >>> 0,
    (account | HARDENED) >>> 0,
  ]).pipe(Effect.flatMap(Keys.accountXpubOf))

/** Assign canonical `cosigner#N` tags by position. */
export const withTags = (participants: readonly Omit<CoSignerRef, 'tag'>[]): readonly CoSignerRef[] =>
  participants.map((p, i) => ({...p, tag: tagAt(i)}))

export type BuildProblem = TemplateProblem | {readonly kind: 'duplicate-xpub'; readonly name: string}

/**
 * Everything wrong with a proposed wallet, as a list.
 *
 * A duplicate xpub is rejected because two roster entries backed by the same key
 * collapse to one leaf in the compiled script: a "2-of-3" where two co-signers
 * share a key is really a 2-of-2, and the person holding the duplicate can meet
 * the quorum alone.
 */
export const validateSharedWallet = (params: {
  readonly coSigners: readonly CoSignerRef[]
  readonly paymentTemplate: ScriptTemplate
  readonly delegationTemplate: ScriptTemplate
}): readonly BuildProblem[] => {
  const tags = params.coSigners.map((c) => c.tag)
  const problems: BuildProblem[] = [
    ...validateTemplate(params.paymentTemplate, tags),
    ...validateTemplate(params.delegationTemplate, tags),
  ]
  const seen = new Map<string, string>()
  for (const c of params.coSigners) {
    const key = c.accountXpubHex.toLowerCase()
    const first = seen.get(key)
    if (first !== undefined) problems.push({kind: 'duplicate-xpub', name: c.name})
    else seen.set(key, c.name)
  }
  return problems
}

export type QuorumStatus = {
  readonly signed: number
  readonly required: number
  readonly total: number
  readonly meetsQuorum: boolean
  readonly signedTags: readonly CoSignerTag[]
  readonly missingTags: readonly CoSignerTag[]
}

/**
 * Quorum state for a set of signed tags.
 *
 * `meetsQuorum` evaluates the template structurally rather than comparing counts
 * — under a nested template the right two signatures satisfy it and the wrong
 * two do not, and a count cannot tell them apart.
 */
export const quorumStatusOf = (
  wallet: Pick<SharedWallet, 'coSigners' | 'paymentTemplate'>,
  signedTags: readonly CoSignerTag[],
): QuorumStatus => {
  const signedSet = new Set(signedTags)
  const {required, total} = signPolicy(wallet.paymentTemplate)
  const rosterTags = wallet.coSigners.map((c) => c.tag)
  return {
    signed: rosterTags.filter((t) => signedSet.has(t)).length,
    required,
    total,
    meetsQuorum: isSatisfied(wallet.paymentTemplate, signedSet),
    signedTags: rosterTags.filter((t) => signedSet.has(t)),
    missingTags: rosterTags.filter((t) => !signedSet.has(t)),
  }
}

/**
 * Which co-signers the given witness key hashes account for, at a payment index.
 *
 * Witnesses carry key hashes, not tags, so the roster has to be re-derived at
 * the index the transaction spent from — the same key hash means different
 * things at different indexes.
 */
export const signedTagsAt = (
  wallet: Pick<SharedWallet, 'coSigners'>,
  index: number,
  witnessKeyHashes: readonly string[],
): Effect.Effect<readonly CoSignerTag[], CoreError> =>
  Effect.gen(function* () {
    const byTag = yield* paymentKeyHashes(wallet.coSigners, index)
    const have = new Set(witnessKeyHashes.map((h) => h.toLowerCase()))
    const out: CoSignerTag[] = []
    for (const [tag, keyHash] of byTag) if (have.has(keyHash.toLowerCase())) out.push(tag)
    return out
  })

export {signPolicy} from './template'
