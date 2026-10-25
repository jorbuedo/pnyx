/**
 * The tools the app answers itself, rather than forwarding to the connector.
 *
 * Two things live here that CIP-30 has no method for: the wallet's **own cached history**, and — from
 * the builder commits that follow — the **transaction builders**. Both are the app's, not the
 * connector's, and that separation is deliberate: CIP-30 deliberately does not build, a dApp brings its
 * own builder, and adding builders to the connector would hand every web page a surface designed for an
 * agent (`docs/MCP_DEV_TOOL_SPEC.md` §3.2).
 *
 * ⚠️ **A local tool raises no new authority.** Nothing here signs and nothing here submits; a builder
 * hands back an unsigned transaction, and the person still approves it on the one review screen. What
 * it does add is *competence* — an agent hand-assembling a 500-output transaction would mostly fail,
 * and with the planner it succeeds.
 *
 * ⚠️ **The scope is resolved before this module is reached.** `deps` are already bound to one granted
 * wallet and account, so there is no account index for an agent to choose — the implicit-index bug this
 * app has paid for six times cannot be reintroduced from here.
 *
 * @module
 */

import type {LocalToolOutcome, LocalToolRunner} from '@pnyx/mcp-server'
import type {TxListItem} from '@pnyx/store/tx-table'
import {logger} from '../../logger'
import type {ShieldedFreshness} from '../midnight/wallet/shielded-freshness'
import {type AgentCapabilities, refusedForLocalTool} from './agent-capabilities'
import {
  type ParsedCoFund,
  type ParsedConsolidation,
  type ParsedCoSign,
  type ParsedDelegation,
  type ParsedDeploy,
  type ParsedMidnightCoFund,
  type ParsedMint,
  type ParsedProgrammableTransfer,
  type ParsedTransfer,
  readCoFundArgs,
  readConsolidationArgs,
  readCoSignArgs,
  readDelegationArgs,
  readDeployArgs,
  readHex,
  readMidnightCoFundArgs,
  readMintArgs,
  readProgrammableTransferArgs,
  readTransferArgs,
} from './build-args'
import {adaOf, type describeTransaction, readableAssetName} from './describe-tx'
import {describeOutcome, listOutcomes} from './outcomes'

const ORIGIN = 'mcp-local-tools'

/** What a call gets when it names no `limit`. */
export const HISTORY_DEFAULT_LIMIT = 50

/**
 * The most rows one call returns.
 *
 * `TxListQuery.limit` is optional and unbounded, and its own documentation says unbounded is "only safe
 * on small histories" — a consolidated wallet's whole history would be pulled into memory to answer one
 * question about last week.
 */
export const HISTORY_MAX_LIMIT = 200

/** What a UTxO read gets when it names no `limit`. */
export const UTXO_DEFAULT_LIMIT = 50

/**
 * The most outputs one call returns.
 *
 * ⚠️ **Because a consolidated wallet's set is unbounded and the response is what breaks, not the
 * request.** The whale test wallet carries hundreds of outputs, each with its own asset list; handing
 * an agent all of them at once is a reply it pays for and cannot use. `total` in the answer is what
 * tells it the page is a page.
 */
export const UTXO_MAX_LIMIT = 200

/** Everything the local tools need, already bound to the granted wallet and account. */
export type LocalToolDeps = {
  /**
   * This wallet's balance, already decoded.
   *
   * ⚠️ **Because `cardano_getBalance` answers with CBOR, and an agent cannot read it.** "The AI is a
   * dApp" settles what it may *see* and *authorise*; it does not make a language model a CBOR decoder.
   * A local model asked for two balances read `821a001e8480…` as "200 ADA" (it is 2) and
   * `821b000000026f1e1274…` as "25 ADA" (it is 10,454.18), inventing asset names out of the map
   * structure both times — confidently, with nothing failing.
   */
  readonly readBalance: () => Promise<{
    readonly lovelace: bigint
    readonly assets: readonly {
      readonly assetId: string
      readonly quantity: bigint
      /**
       * ⚠️ **A CIP-113 programmable token, which `cardano_buildTransfer` cannot send.** It sits at
       * the deployment's smart wallet, not in the wallet's own UTxO set, so ordinary coin selection
       * cannot reach it — an agent that treats these as ordinary assets gets told "not enough
       * funds" for a token the wallet demonstrably holds. Use
       * `cardano_buildProgrammableTransfer` for these and `cardano_buildTransfer` for the rest.
       */
      readonly programmable?: boolean
    }[]
    /**
     * Set when the programmable holdings could not be read. Absent is not "none held" — an agent
     * told nothing would report a partial balance as the whole of it.
     */
    readonly programmableUnavailable?: string
  }>
  /**
   * This wallet's addresses, bech32.
   *
   * ⚠️ **Because the connector's are hex and every builder here takes bech32.** An agent that asked the
   * wallet where its change goes could not pass that answer to `cardano_buildTransfer` — it would be
   * refused as "not a Cardano address". A surface whose own output does not fit its own input is a trap
   * no amount of care by the caller avoids.
   */
  /**
   * Describe a transaction from this wallet's point of view.
   *
   * ⚠️ Answers `null` when the bytes cannot be decoded at all — a different fact from a transaction
   * that does nothing, and one an agent must not paper over.
   */
  readonly readTransaction: (txHex: string) => Promise<ReturnType<typeof describeTransaction> | null>
  readonly readAddresses: () => Promise<{
    readonly receive: string
    readonly all: readonly string[]
    readonly reward: string | null
  }>
  /**
   * This wallet's UTxOs, decoded, and how many there are in total.
   *
   * ⚠️ **Because `cardano_getUtxos` and `cardano_getCollateral` answer with CBOR, for the same reason
   * `readBalance` exists.** A hex `TransactionUnspentOutput` is what a dApp's library expects; a
   * language model asked to read one invents a figure.
   *
   * ⚠️ **The same source the connector serves, re-encoded rather than re-derived** — `rail`'s own
   * spendable set, which is what CIP-30 answers from. Decoding the connector's hex instead would give
   * the two surfaces a chance to disagree about the wallet's own contents.
   *
   * `total` is the size of the whole (filtered) set, not of the page — an agent that saw only `utxos`
   * would sum a page and report it as the balance.
   */
  readonly readUtxos: (query: {
    readonly collateralOnly: boolean
    readonly limit: number
    readonly offset: number
  }) => Promise<{
    readonly total: number
    readonly utxos: readonly {
      readonly txHash: string
      readonly index: number
      readonly address: string
      readonly lovelace: bigint
      readonly assets: readonly {readonly assetId: string; readonly quantity: bigint}[]
      readonly datumHash?: string
      readonly hasInlineDatum?: boolean
      readonly hasScriptRef?: boolean
    }[]
  }>
  /** Rejects rather than answering `[]` when the store cannot be read — the two are different facts. */
  readonly listHistory: (query: {readonly limit: number; readonly offset: number}) => Promise<readonly TxListItem[]>
  /**
   * What the chain currently says about one transaction, by hash.
   *
   * ⚠️ **`'unknown'` is a real answer and must stay distinct from `'pending'`.** "The chain has not
   * decided yet" and "this wallet cannot see it" lead an agent to different next moves — waiting
   * versus asking a person — and collapsing them is how an agent ends up retrying a payment that is
   * already in flight.
   */
  readonly txStatus: (txHash: string) => Promise<'confirmed' | 'failed' | 'pending' | 'unknown'>
  /**
   * How long ago this wallet's Midnight unshielded set last synced, ms, or `null` for never.
   *
   * ⚠️ **A balance with no age is presented as current, and a stale one looks identical to a fresh
   * one.** That is not hypothetical: a granted wallet reported a balance twelve hours out of date on
   * 2026-08-29 and nothing in the answer said so. Serving now refreshes every granted scope as it
   * opens, but an agent still has to be able to ask.
   */
  readonly midnightSyncAgeMs: () => number | null
  /**
   * How far this wallet's **shielded** scan is behind the chain, or `null` when there is no Midnight
   * network to ask about.
   *
   * ⚠️ **{@link midnightSyncAgeMs} does not cover this rail, and the tool built on it said it did.**
   * `recordSync` is called from `wallet/unshielded.ts` and nowhere else, so a wallet whose unshielded
   * feed is seconds old reports itself current while its shielded scan sits arbitrarily far back —
   * and an agent that dutifully checks freshness first then reads a shielded balance gets a
   * *confident* wrong answer, which is worse than an unqualified one.
   */
  readonly shieldedFreshness: () => Promise<ShieldedFreshness | null>
  /**
   * Walk the shielded rail to the chain tip, and report where it got to.
   *
   * ⚠️ **Blocks on the person**, like a transfer does: discovering a coin means decrypting output
   * ciphertexts, which needs the Zswap role key, which needs the vault — so this raises a biometric
   * prompt and cannot be answered while nobody is there. That is also why no scheduler does it.
   */
  readonly syncShielded: () => Promise<{
    readonly scannedToBlock: number
    readonly blocksScanned: number
    readonly transactionsApplied: number
    readonly caughtUp: boolean
  } | null>
  /**
   * Build a transfer, and carry it through the review to the chain when the call asked for that.
   *
   * ⚠️ It answers its own refusals: an intent that will not build has a *reason* — a recipient on the
   * wrong network, a wallet that cannot cover it, more recipients than fit — and each of those is
   * something the agent can act on, where a thrown error is not.
   */
  readonly buildTransfer: (intent: ParsedTransfer) => Promise<LocalToolOutcome>
  /**
   * ⚠️ Separate from `buildTransfer` because a programmable token cannot share a transaction with
   * ordinary assets — different inputs, a different builder, its own review.
   */
  readonly buildProgrammableTransfer: (intent: ParsedProgrammableTransfer) => Promise<LocalToolOutcome>
  /** Mint one asset under this wallet's policy and hand it out. Answers its own refusals, as above. */
  readonly buildMint: (intent: ParsedMint) => Promise<LocalToolOutcome>
  /** Delegate this account's stake and vote. Answers its own refusals, as above. */
  readonly buildDelegation: (intent: ParsedDelegation) => Promise<LocalToolOutcome>
  /** Fold this wallet's UTxOs together — several transactions, one review. Answers its own refusals. */
  readonly buildConsolidation: (intent: ParsedConsolidation) => Promise<LocalToolOutcome>
  /** Publish a compiled script as a reference output. Answers its own refusals, as above. */
  readonly buildDeploy: (intent: ParsedDeploy) => Promise<LocalToolOutcome>
  /**
   * Build one transaction several granted wallets pay for, and add one wallet's signature to it.
   *
   * ⚠️ These reach **across scopes**, which every other tool does not: a co-funded transaction names
   * several contributors, and each must be a scope the person granted. The runner is still bound to one
   * addressed wallet — the composer for a build, the signer for a signature — and the others are looked
   * up in the granted set, never taken from the call.
   */
  readonly buildCoFunded: (intent: ParsedCoFund) => Promise<LocalToolOutcome>
  readonly signCoFunded: (intent: ParsedCoSign) => Promise<LocalToolOutcome>
  /**
   * Explain a Midnight transaction, read from the transaction.
   *
   * ⚠️ **Because a Midnight transaction cannot be read in JavaScript on a phone.** Deserializing needs
   * the ledger, and the ledger reaches Hermes only through the native crate — so an agent handed
   * Midnight bytes could previously only describe hex, which is exactly where a model invents a
   * confident answer. Answers its own refusal for bytes that are not a transaction; "could not be read"
   * and "does nothing" are different facts.
   */
  readonly readMidnightTransaction: (txHex: string) => Promise<LocalToolOutcome>
  /**
   * Build one Midnight transaction several granted wallets fund, and take it through the review.
   *
   * ⚠️ Reaches **across scopes**, like its Cardano counterpart: each contributor must be a scope the
   * person granted, and the others are looked up in the granted set rather than taken from the call.
   */
  readonly buildMidnightCoFunded: (intent: ParsedMidnightCoFund) => Promise<LocalToolOutcome>
}

/** A parsed argument, or the sentence an agent is told instead. */
export type ArgResult<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly message: string}

/**
 * Read a whole number inside its declared bounds.
 *
 * ⚠️ **Out of range is refused, not clamped.** The schema already states the range, so a call outside it
 * is one that ignored the schema — and silently returning 200 rows for a request for 1,000 reads as
 * "that is all there is". Naming the bound is what lets the agent page instead of concluding.
 */
export const readBoundedInteger = (
  args: Record<string, unknown>,
  key: string,
  bounds: {readonly min: number; readonly max: number; readonly fallback: number},
): ArgResult<number> => {
  const raw = args[key]
  if (raw === undefined || raw === null) return {ok: true, value: bounds.fallback}
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < bounds.min || raw > bounds.max) {
    return {
      ok: false,
      message: `\`${key}\` must be a whole number between ${bounds.min} and ${bounds.max}; got ${JSON.stringify(raw)}`,
    }
  }
  return {ok: true, value: raw}
}

export type ListHistoryArgs = {readonly limit: number; readonly offset: number}

/** `cardano_listHistory`'s arguments: a bounded page, defaulted rather than left unbounded. */
export const readListHistoryArgs = (args: Record<string, unknown>): ArgResult<ListHistoryArgs> => {
  const limit = readBoundedInteger(args, 'limit', {min: 1, max: HISTORY_MAX_LIMIT, fallback: HISTORY_DEFAULT_LIMIT})
  if (!limit.ok) return limit
  const offset = readBoundedInteger(args, 'offset', {min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0})
  if (!offset.ok) return offset
  return {ok: true, value: {limit: limit.value, offset: offset.value}}
}

export type ReadUtxosArgs = {readonly collateralOnly: boolean; readonly limit: number; readonly offset: number}

/**
 * ⚠️ `collateralOnly` refuses anything that is not a boolean rather than treating it as false. A
 * truthy string would silently widen a collateral read to the whole set, which is the opposite of
 * what was asked for.
 */
export const readReadUtxosArgs = (args: Record<string, unknown>): ArgResult<ReadUtxosArgs> => {
  const raw = args.collateralOnly
  if (raw !== undefined && typeof raw !== 'boolean') {
    return {ok: false, message: '`collateralOnly` must be true or false'}
  }
  const limit = readBoundedInteger(args, 'limit', {min: 1, max: UTXO_MAX_LIMIT, fallback: UTXO_DEFAULT_LIMIT})
  if (!limit.ok) return limit
  const offset = readBoundedInteger(args, 'offset', {min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0})
  if (!offset.ok) return offset
  return {ok: true, value: {collateralOnly: raw === true, limit: limit.value, offset: offset.value}}
}

/**
 * The runner for one granted scope.
 *
 * ⚠️ **The capability check is here, at the door.** `tools/list` hides what is not granted, but a client
 * may call any tool by name without listing first — and a local tool never reaches the connector, where
 * the other half of the rule lives.
 */
export const createLocalToolRunner = (capabilities: AgentCapabilities, deps: LocalToolDeps): LocalToolRunner => {
  return async ({name, args}) => {
    const withheld = refusedForLocalTool(name, capabilities)
    if (withheld !== undefined) {
      logger.debug('an agent local-tool call was refused by the wallet’s granted capabilities', {
        origin: ORIGIN,
        tool: name,
      })
      return {ok: false, message: withheld}
    }
    switch (name) {
      case 'cardano_listHistory': {
        const parsed = readListHistoryArgs(args)
        if (!parsed.ok) return parsed
        const rows = await deps.listHistory(parsed.value)
        // Not silent on the happy path either: a read that logs nothing cannot be told apart from one
        // that never ran, and "no rows" is a real answer an agent will act on.
        logger.debug('an agent read this wallet’s cached Cardano history', {
          origin: ORIGIN,
          rows: rows.length,
          ...parsed.value,
        })
        return {ok: true, value: {rows, limit: parsed.value.limit, offset: parsed.value.offset}}
      }
      case 'cardano_buildTransfer': {
        const parsed = readTransferArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildTransfer(parsed.value)
      }
      case 'cardano_buildProgrammableTransfer': {
        const parsed = readProgrammableTransferArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildProgrammableTransfer(parsed.value)
      }
      case 'cardano_buildMintAndDistribute': {
        const parsed = readMintArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildMint(parsed.value)
      }
      case 'cardano_buildDelegation': {
        const parsed = readDelegationArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildDelegation(parsed.value)
      }
      case 'cardano_buildConsolidation': {
        const parsed = readConsolidationArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildConsolidation(parsed.value)
      }
      case 'cardano_buildContractDeploy': {
        const parsed = readDeployArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildDeploy(parsed.value)
      }
      case 'cardano_readBalance': {
        const balance = await deps.readBalance()
        logger.debug('an agent read this wallet’s decoded balance', {
          origin: ORIGIN,
          lovelace: balance.lovelace.toString(),
          assets: balance.assets.length,
          programmable: balance.assets.filter((a) => a.programmable === true).length,
          programmableUnavailable: balance.programmableUnavailable,
        })
        return {ok: true, value: describeBalance(balance)}
      }
      case 'cardano_readTransaction': {
        const txHex = readHex(args.transaction, 'transaction')
        if (!txHex.ok) return txHex
        if (txHex.value.length === 0) return {ok: false, message: '`transaction` is empty'}
        const described = await deps.readTransaction(txHex.value)
        if (described === null) {
          return {ok: false, message: 'those bytes are not a Cardano transaction this wallet can decode'}
        }
        logger.debug('an agent read a transaction', {
          origin: ORIGIN,
          understood: described.understood,
          warnings: described.warnings.length,
        })
        return {ok: true, value: described}
      }
      case 'cardano_readUtxos': {
        const parsed = readReadUtxosArgs(args)
        if (!parsed.ok) return parsed
        const read = await deps.readUtxos(parsed.value)
        logger.debug('an agent read this wallet’s decoded UTxOs', {
          origin: ORIGIN,
          returned: read.utxos.length,
          total: read.total,
          ...parsed.value,
        })
        return {ok: true, value: describeUtxos(read, parsed.value)}
      }
      case 'midnight_readSyncStatus': {
        const ageMs = deps.midnightSyncAgeMs()
        // ⚠️ Reported per rail, because the two are refreshed by different things and only one of them
        // is refreshed at all without being asked. The top-level fields are the **unshielded** rail,
        // which is what they always measured — the tool's own description used to claim they covered
        // "this wallet's Midnight balances", which included a rail nothing here could see.
        const shielded = await deps.shieldedFreshness()
        logger.debug('an agent asked how fresh this wallet is', {origin: ORIGIN, ageMs, shielded: shielded?.kind})
        return {
          ok: true,
          value: {
            syncedSecondsAgo: ageMs === null ? null : Math.round(ageMs / 1000),
            everSynced: ageMs !== null,
            shielded: describeShieldedFreshness(shielded),
          },
        }
      }
      case 'midnight_syncShielded': {
        const result = await deps.syncShielded()
        if (result === null) {
          // Not a failure: this build serves no Midnight network for the selected one, so there is
          // nothing to scan and saying "synced" would be a claim about a chain we cannot reach.
          logger.debug('an agent asked for a shielded sync with no Midnight network', {origin: ORIGIN})
          return {ok: false, message: 'this wallet has no Midnight network selected, so there is nothing to scan'}
        }
        logger.info('an agent ran a shielded sync', {
          origin: ORIGIN,
          to: result.scannedToBlock,
          blocks: result.blocksScanned,
          applied: result.transactionsApplied,
          caughtUp: result.caughtUp,
        })
        return {ok: true, value: result}
      }
      case 'cardano_listOutcomes': {
        // ⚠️ Cardano only, and the reason is structural rather than unfinished work: a device-built
        // Midnight transaction has **no hash** until the sponsor binds it, so there is nothing to key
        // an outcome by and nothing to look a confirmation up with. Its analogue is `identifiers()`,
        // matched by containment — a different lookup, not this one wearing another chain's name.
        const remembered = listOutcomes('cardano')
        const described = await Promise.all(
          remembered.map(async (outcome) => {
            // Only a submitted transaction has anything to look up; the rest never reached the chain,
            // and asking about them would invent a question the wallet cannot answer.
            const confirmation = outcome.stage === 'submitted' ? await deps.txStatus(outcome.txHash) : 'unknown'
            return describeOutcome(outcome, confirmation)
          }),
        )
        logger.debug('an agent read what became of its transactions', {origin: ORIGIN, count: described.length})
        return {ok: true, value: {outcomes: described}}
      }
      case 'cardano_readAddresses': {
        const addresses = await deps.readAddresses()
        logger.debug('an agent read this wallet’s addresses', {origin: ORIGIN, all: addresses.all.length})
        return {ok: true, value: addresses}
      }
      case 'cardano_buildCoFundedSend': {
        const parsed = readCoFundArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildCoFunded(parsed.value)
      }
      case 'cardano_signCoFunded': {
        const parsed = readCoSignArgs(args)
        if (!parsed.ok) return parsed
        return await deps.signCoFunded(parsed.value)
      }
      case 'midnight_readTransaction': {
        const txHex = readHex(args.transaction, 'transaction')
        if (!txHex.ok) return txHex
        if (txHex.value.length === 0) return {ok: false, message: '`transaction` is empty'}
        return await deps.readMidnightTransaction(txHex.value)
      }
      case 'midnight_buildCoFundedSend': {
        const parsed = readMidnightCoFundArgs(args)
        if (!parsed.ok) return parsed
        return await deps.buildMidnightCoFunded(parsed.value)
      }
      default:
        return {ok: false, message: `${name} is not a tool this wallet serves`}
    }
  }
}

/**
 * A UTxO page in the shape an agent can act on without decoding anything.
 *
 * ⚠️ **`ref` is `txHash#index`**, which is how an output is named everywhere a person or an explorer
 * would name one. The parts are kept beside it because a builder takes them separately, and splitting
 * a joined string is where an off-by-one gets introduced.
 *
 * ⚠️ **`total` and `truncated` are load-bearing.** A page summed and reported as the balance is the
 * failure this shape exists to prevent, so the answer says how much it is not showing. `remaining` is
 * given rather than left as arithmetic on two other fields.
 *
 * Amounts are decimal strings for the same reason as {@link describeBalance}: exact for a builder,
 * with the human figure beside it so the model is not invited to divide by a million itself.
 */
export const describeUtxos = (
  read: {
    readonly total: number
    readonly utxos: readonly {
      readonly txHash: string
      readonly index: number
      readonly address: string
      readonly lovelace: bigint
      readonly assets: readonly {readonly assetId: string; readonly quantity: bigint}[]
      readonly datumHash?: string
      readonly hasInlineDatum?: boolean
      readonly hasScriptRef?: boolean
    }[]
  },
  query: {readonly collateralOnly: boolean; readonly limit: number; readonly offset: number},
) => {
  const shown = query.offset + read.utxos.length
  const remaining = Math.max(0, read.total - shown)
  return {
    total: read.total,
    returned: read.utxos.length,
    offset: query.offset,
    limit: query.limit,
    remaining,
    truncated: remaining > 0,
    ...(query.collateralOnly ? {collateralOnly: true} : {}),
    utxos: read.utxos.map((utxo) => ({
      ref: `${utxo.txHash}#${utxo.index}`,
      txHash: utxo.txHash,
      index: utxo.index,
      address: utxo.address,
      lovelace: utxo.lovelace.toString(),
      ada: adaOf(utxo.lovelace),
      assets: utxo.assets.map((asset) => {
        const [policyId = '', assetNameHex = ''] = asset.assetId.split('.')
        return {
          policyId,
          assetNameHex,
          name: readableAssetName(assetNameHex),
          quantity: asset.quantity.toString(),
        }
      }),
      // Only on the outputs they are true of: a flag on every ordinary output is noise in a listing an
      // agent reads in full, and its absence already means "an ordinary payment output".
      ...(utxo.datumHash === undefined ? {} : {datumHash: utxo.datumHash}),
      ...(utxo.hasInlineDatum === true ? {hasInlineDatum: true} : {}),
      ...(utxo.hasScriptRef === true ? {hasScriptRef: true} : {}),
    })),
  }
}

/**
 * A balance in the shape an agent can act on without decoding anything.
 *
 * ⚠️ **Both the exact figure and the human one.** `lovelace` is what a builder takes and must stay
 * exact, so it is a decimal *string*; `ada` is what a person is told. Giving only the first invites the
 * model to divide by a million itself and get it wrong; giving only the second loses precision the
 * moment it is passed back into a transaction.
 *
 * The asset name is decoded when it is text and reported as `null` when it is not — a name that is not
 * UTF-8 is perfectly legal, and rendering its bytes as mojibake would be worse than admitting it.
 * ⚠️ CIP-68 puts a four-byte label in front of the name (`0014df10` = a fungible token's), so the raw
 * decode of a well-formed name still starts with unprintable bytes; they are stripped for `name` only,
 * never for `assetNameHex`, which is what identifies the asset.
 */
export const describeBalance = (balance: {
  readonly lovelace: bigint
  readonly assets: readonly {
    readonly assetId: string
    readonly quantity: bigint
    readonly programmable?: boolean
  }[]
  readonly programmableUnavailable?: string
}) => ({
  lovelace: balance.lovelace.toString(),
  ada: adaOf(balance.lovelace),
  assets: balance.assets.map((asset) => {
    const [policyId = '', assetNameHex = ''] = asset.assetId.split('.')
    return {
      policyId,
      assetNameHex,
      name: readableAssetName(assetNameHex),
      quantity: asset.quantity.toString(),
      // Only on the ones it is true of: a `false` on every ordinary asset is noise in a listing an
      // agent reads in full, and its absence already means "ordinary".
      ...(asset.programmable === true ? {programmable: true} : {}),
    }
  }),
  ...(balance.programmableUnavailable === undefined ? {} : {programmableUnavailable: balance.programmableUnavailable}),
})

/**
 * The shielded rail's freshness, as an agent reads it.
 *
 * ⚠️ **Heights, and an explicit `blocksBehind`.** An agent deciding whether to act on a balance should
 * not have to subtract two numbers correctly to find out, and `state` alone would not say whether
 * being behind means one block or a hundred thousand. `null` throughout when there is nothing to ask —
 * never `0`, which is a height and a count.
 */
export const describeShieldedFreshness = (
  freshness: ShieldedFreshness | null,
): {
  readonly state: 'current' | 'behind' | 'never-synced' | 'unknown' | 'no-network'
  readonly scannedToBlock: number | null
  readonly chainTipBlock: number | null
  readonly blocksBehind: number | null
} => {
  if (freshness === null) {
    return {state: 'no-network', scannedToBlock: null, chainTipBlock: null, blocksBehind: null}
  }
  switch (freshness.kind) {
    case 'current':
      return {state: 'current', scannedToBlock: freshness.cursor, chainTipBlock: null, blocksBehind: 0}
    case 'behind':
      return {
        state: 'behind',
        scannedToBlock: freshness.cursor,
        chainTipBlock: freshness.tip,
        blocksBehind: freshness.tip - freshness.cursor,
      }
    case 'never-synced':
      return {state: 'never-synced', scannedToBlock: null, chainTipBlock: null, blocksBehind: null}
    case 'unknown':
      return {state: 'unknown', scannedToBlock: freshness.cursor, chainTipBlock: null, blocksBehind: null}
  }
}
