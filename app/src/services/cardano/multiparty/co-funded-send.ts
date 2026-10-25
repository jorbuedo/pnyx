/**
 * The send flow's co-funded branch: sources + recipients → a filed multiparty envelope.
 *
 * Co-funding is not a separate flow and does not get a separate screen — it is the
 * ordinary send with inputs from more than one wallet, so everything up to the build is
 * the send funnel's, and this is only the part that differs. It exists as its own module
 * rather than inline in `SendFlowProvider` because the provider is a React component and
 * this is not, which is the difference between testable and not.
 *
 * **The selected wallet is always the composer.** It owns the change and therefore pays
 * the fee, which is the decision that lets the other contributors' returns be exact.
 *
 * @module
 */

import {cardanoChainId} from '@pnyx/config'
import {Effect} from 'effect'
import type {TranslationProvider} from '../../../i18n'
import {logger} from '../../../logger'
import {platformPersistCosign, stableCosignId} from '../cosign'
import type {CardanoRail} from '../rail'
import {buildMultipartyTx, type MultipartyBuildRail} from './build'
import type {ComposeFailure, Contribution} from './compose'
import {contributableTotal, type GatherRail, gatherContributableUtxos} from './gather'
import {isEmptyValue, makeValue, subtractValues, sumValues, type Value} from './value'

/** One contributing wallet, as the send state records it. */
export type CoFundSource = {
  readonly groupId: string
  readonly name: string
  /** The wallet building the transaction — it owns the change and pays the fee. */
  readonly isComposer: boolean
  readonly lovelace: bigint
  readonly assets: ReadonlyMap<string, bigint>
}

export type CoFundInput = {
  /**
   * The composer's rail. Narrowed to what the two steps below actually use — gathering each
   * party's UTxOs and building the body — so this is callable from a test without standing
   * up a whole rail. `platformPersistCosign` is the storage layer's, not the rail's.
   */
  readonly rail: GatherRail & MultipartyBuildRail & {readonly config: CardanoRail['config']}
  /** The composer — the selected wallet, which owns the change. */
  readonly groupId: string
  readonly name: string | null
  readonly sources: readonly CoFundSource[]
  /** Already-validated recipients from the send flow, unchanged. */
  readonly targets: readonly {readonly addressHex: string; readonly amounts: ReadonlyMap<string, bigint>}[]
  /** Every contributing wallet's addresses, keyed by group — including the composer's. */
  readonly addressesOf: (groupId: string) => Promise<readonly string[]>
  readonly now: string
}

export type CoFundResult =
  | {readonly ok: true; readonly pendingId: string}
  /** Refused by the arithmetic, with the party named — see `composeMultiparty`. */
  | {readonly ok: false; readonly compose: ComposeFailure}
  /**
   * A named refusal. Literals rather than a free `string` so the union discriminates and
   * `coFundMessage` cannot silently fall through to the generic message for a case it
   * forgot — the failure mode this whole path kept reproducing.
   */
  | {
      readonly ok: false
      // `'tokens'` was here while a contributed token had nowhere to go. Both sides carry
      // values now, so a token that reaches no output is an *unbalanced* send and says so
      // in the same sentence as a lovelace shortfall — one rule, not a special case.
      readonly reason: 'too-large' | 'composer-empty' | 'unreadable-wallet' | 'failed'
      /** The builder's own words, for `failed` — the toast used to print `{reason}` literally. */
      readonly detail?: string
    }
  /**
   * A contributing wallet is a shared one, whose spend needs a script this envelope cannot
   * carry and co-signers it cannot name. Refused with the wallet named, because the remedy
   * is specific: send from that wallet separately.
   */
  | {readonly ok: false; readonly reason: 'shared-wallet'; readonly name: string}
  /** The wallets and the recipients disagree on ADA; the screen states both figures. */
  | {readonly ok: false; readonly reason: 'unbalanced'; readonly contributed: bigint; readonly requested: bigint}
  /**
   * They agree on ADA and disagree on a token.
   *
   * Separate from `unbalanced` because that message states two lovelace figures, and here
   * they are equal — "you put in 8 tADA but the recipients want 8 tADA" is true of the
   * lovelace and useless as an explanation of what is wrong.
   */
  | {readonly ok: false; readonly reason: 'unbalanced-tokens'; readonly assetIds: readonly string[]}

const ADA_ID = ''

/** A validated send target as a value: every asset it asks for, ADA included. */
const targetValue = (amounts: ReadonlyMap<string, bigint>): Value => {
  let lovelace = 0n
  const assets = new Map<string, bigint>()
  for (const [assetId, quantity] of amounts) {
    if (assetId === ADA_ID) lovelace += quantity
    else assets.set(assetId, (assets.get(assetId) ?? 0n) + quantity)
  }
  return makeValue(lovelace, assets)
}

export const buildCoFundedSend = async (input: CoFundInput): Promise<CoFundResult> => {
  const recipients = input.targets.map((target) => ({
    addressHex: target.addressHex,
    value: targetValue(target.amounts),
  }))

  // **The wallets decide the total, not the other way round.** Each contribution is typed
  // in its own accordion, so the recipients' total must equal their sum — and a difference
  // is not something to absorb: too little and the transaction cannot pay, too much and
  // the surplus lands in the composer's change, which is other people's money moving
  // somewhere nobody chose.
  //
  // **Per asset, not per total.** A token is not fungible with the ADA beside it, so
  // balancing lovelace alone would let a contributed token reach no output and be swept
  // into the composer's change — the theft case `composeMultiparty` exists to prevent,
  // reappearing at the recipient boundary. Both sides now carry values, so the same
  // subtraction answers for both.
  const contributed = sumValues(input.sources.map((s) => makeValue(s.lovelace, s.assets)))
  const requested = sumValues(recipients.map((r) => r.value))
  const difference = subtractValues(contributed, requested)
  if (!isEmptyValue(difference)) {
    const assetIds = [...difference.assets.keys()]
    logger.warn('co-fund refused: the wallets and the recipients disagree', {
      origin: 'buildCoFundedSend',
      contributed: `${contributed.lovelace}`,
      requested: `${requested.lovelace}`,
      unbalancedAssets: assetIds.length,
    })
    return difference.lovelace === 0n && assetIds.length > 0
      ? {ok: false, reason: 'unbalanced-tokens', assetIds}
      : {ok: false, reason: 'unbalanced', contributed: contributed.lovelace, requested: requested.lovelace}
  }

  const contributions: Contribution[] = []
  for (const party of input.sources) {
    const addresses = await input.addressesOf(party.groupId)
    const gathered = await Effect.runPromise(Effect.either(gatherContributableUtxos({rail: input.rail, addresses})))
    if (gathered._tag === 'Left') {
      logger.error('co-fund: could not read a contributing wallet', {
        origin: 'buildCoFundedSend',
        groupId: party.groupId,
        reason: gathered.left.reason,
      })
      return {ok: false, reason: 'unreadable-wallet'}
    }
    contributions.push({
      walletId: party.groupId,
      name: party.name,
      available: gathered.right,
      value: makeValue(party.lovelace, party.assets),
      ...(party.isComposer ? {isComposer: true as const} : {}),
    })
  }

  const composerAvailable = contributableTotal(contributions.find((c) => c.isComposer)?.available ?? [])
  if (composerAvailable === 0n) {
    logger.warn('co-fund refused: the composer has no readable UTxOs', {
      origin: 'buildCoFundedSend',
      groupId: input.groupId,
      contributions: contributions.map((c) => ({id: c.walletId, utxos: c.available.length})),
    })
    return {ok: false, reason: 'composer-empty'}
  }

  const built = await Effect.runPromise(
    Effect.either(
      buildMultipartyTx({
        rail: input.rail,
        contributions,
        recipients,
        chainId: cardanoChainId(input.rail.config.network),
        createdBy: input.name ?? input.groupId,
        createdAt: input.now,
      }),
    ),
  )
  if (built._tag === 'Left') {
    logger.warn('co-fund build failed', {origin: 'buildCoFundedSend', reason: built.left.reason})
    if (built.left.compose !== undefined) return {ok: false, compose: built.left.compose}
    if (built.left.scriptParty !== undefined) return {ok: false, reason: 'shared-wallet', name: built.left.scriptParty}
    return built.left.tooLarge === true
      ? {ok: false, reason: 'too-large'}
      : {ok: false, reason: 'failed', detail: built.left.reason}
  }

  // Filed under the *composer's group*, which is what the co-sign screen looks it up by.
  // `createdBy` is a display name; filing under it would make the transaction unfindable.
  await Effect.runPromise(Effect.ignore(platformPersistCosign(input.groupId, built.right.envelope)))
  return {ok: true, pendingId: stableCosignId(built.right.envelope)}
}

/**
 * A refusal in the party's own name.
 *
 * A generic "could not build" would hide the one thing the composer can act on: which
 * contributor to adjust, and by how much.
 */
export const coFundFailureMessage = (failure: ComposeFailure, say: TranslationProvider['t']): string => {
  switch (failure.kind) {
    case 'return-below-min-ada':
      return say('coFund.errorReturnTooSmall', {name: failure.name})
    case 'contribution-exceeds-inputs':
      return say('coFund.errorTooMuch', {name: failure.name})
    case 'zero-contribution':
      return say('coFund.errorZero', {name: failure.name})
    case 'party-has-no-inputs':
      return say('coFund.errorNoFunds', {name: failure.name})
    case 'composer-has-no-inputs':
      return say('coFund.errorComposerEmpty')
    case 'single-contributor':
      return say('coFund.errorNeedTwo')
    default:
      return say('coFund.errorGeneric')
  }
}

/**
 * Everything a co-funded build can refuse with, said in the user's terms.
 *
 * Routed through one function so the screen never has to know which of the three failure
 * shapes it got — and so no branch can quietly fall through to "could not build", which
 * is what every one of these used to be.
 */
export const coFundMessage = (
  result: Extract<CoFundResult, {ok: false}>,
  say: TranslationProvider['t'],
  format: (value: bigint, opts: {preset: 'cryptoBalance'; currency: string; decimals: number}) => string,
  adaTicker: string,
): string => {
  if ('compose' in result) return coFundFailureMessage(result.compose, say)
  const ada = (lovelace: bigint) => format(lovelace, {preset: 'cryptoBalance', currency: adaTicker, decimals: 6})
  switch (result.reason) {
    case 'unbalanced':
      return say('coFund.balanceMismatch', {
        contributed: ada(result.contributed),
        requested: ada(result.requested),
      })
    case 'unbalanced-tokens':
      return say('coFund.tokenMismatch', {count: result.assetIds.length})
    case 'shared-wallet':
      return say('coFund.errorSharedWallet', {name: result.name})
    case 'too-large':
      return say('coFund.errorTooLarge')
    case 'composer-empty':
      return say('coFund.errorComposerEmpty')
    case 'unreadable-wallet':
      return say('coFund.errorUnreadable')
    case 'failed':
      // The builder's own sentence, not a placeholder. This branch printed a literal
      // `{reason}` because it reached a string expecting a variable nobody passed.
      return result.detail === undefined
        ? say('coFund.errorGeneric')
        : say('cardanoSend.errors.buildFailed', {reason: result.detail})
    default:
      return say('coFund.errorGeneric')
  }
}
