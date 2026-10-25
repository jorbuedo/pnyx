/**
 * Building the multiparty transaction: compose → plan → body → envelope.
 *
 * The composer holds the only rail involved. Co-contributors are known through read-only
 * wallets, so their UTxOs are data the composer already has and their keys are not — which
 * is the whole point: a body spending them is constructible here and invalid until they
 * sign.
 *
 * Three things this does that an ordinary send does not:
 *
 * 1. **Co-contributor inputs go in `mandatoryInputs`.** Coin selection may drop anything in
 *    `inputs` it does not need; dropping a co-contributor's would remove the signature the
 *    roster demands and leave a transaction waiting on a party who funds nothing.
 * 2. **Returns are explicit outputs** — the invariant `composeMultiparty` exists to hold.
 *    See its module note for what one `changeAddressHex` does to everyone else's money.
 * 3. **The roster is derived from the body**, not from the request. After coin selection
 *    the inputs are the truth about who must sign, and `extractRequiredSigners` reads them
 *    rather than trusting what was asked for.
 *
 * The fee fixed-point is the same one `send-flow.ts` runs and for the same reason: a fee
 * sized for one witness underpays a transaction that carries N. Here N is at least the
 * number of contributing parties and can be more, because one party's selected inputs may
 * sit on several of their own keys.
 *
 * @module
 */

import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'

import {AddressHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import type {CardanoChainId} from '@pnyx/config'
import {Data, Effect} from 'effect'
import {minAdaForOutput} from '../../../screens/cardano/send/min-ada'
import {constructEnvelope} from '../cosign/envelope'
import type {EnvelopeSigner, TxEnvelope} from '../cosign/types'
import type {CardanoRail} from '../rail'
import {type ComposeFailure, type ContributedUtxo, type Contribution, composeMultiparty} from './compose'
import {type ContributingWallet, extractRequiredSigners} from './model'
import {isEmptyValue, subtractValues, sumValues, type Value} from './value'

export class MultipartyBuildError extends Data.TaggedError('MultipartyBuildError')<{
  readonly reason: string
  /** Present when the arithmetic refused, so the screen can name the party. */
  readonly compose?: ComposeFailure
  /**
   * The transaction exceeded a protocol bound. Distinct because the remedy is different:
   * an ordinary send folds its UTxO set and retries, which is impossible for a wallet this
   * device only watches, so the user has to drop a party or a recipient instead.
   */
  readonly tooLarge?: boolean
  /** A contributor whose coins sit at a script address — see the check that raises it. */
  readonly scriptParty?: string
}> {}

export type MultipartyRecipient = {
  readonly addressHex: string
  /**
   * What this recipient receives, tokens included.
   *
   * Lovelace-only was the earlier shape and it made a contributed token unrepresentable on
   * the receiving side: `compose` returned it correctly to its contributor, no output
   * claimed it, and the planner put what was left into the change — which belongs to the
   * composer. The refusal that stood in for this covered the hole; carrying the value closes
   * it.
   */
  readonly value: Value
}

/**
 * What building actually needs from the rail: the protocol parameters.
 *
 * Narrower than `CardanoRail` on purpose. A `CardanoRail` satisfies it structurally, so no
 * caller changes — but the alternative for a test is casting a one-field object to a
 * thirty-field interface, and a cast is a claim the compiler stops checking. Naming the
 * dependency instead means the day this starts reaching for the key registry or the pending
 * tracker, the signature says so.
 */
export type MultipartyBuildRail = {
  readonly protocolParams: CardanoRail['protocolParams']
}

export type BuiltMultiparty = {
  readonly envelope: TxEnvelope
  readonly bodyHex: string
  readonly fee: bigint
  /** UTxOs the body actually spends, for the composer's pending-tx tracking. */
  readonly consumedInputs: readonly ContributedUtxo[]
}

/** A lovelace + token map as the bag the plan engine takes. */
const bagOf = (lovelace: bigint, assets?: ReadonlyMap<string, bigint>): EvAssets.Assets =>
  EvAssets.fromRecord({lovelace, ...Object.fromEntries(assets ?? new Map<string, bigint>())})

const planInputOf = (utxo: ContributedUtxo) => ({
  txHash: TxHashHex(utxo.txHash),
  index: utxo.index,
  assets: bagOf(utxo.lovelace, utxo.assets),
})

/**
 * Distinct payment key hashes across the inputs a body actually spends.
 *
 * This is the witness count the fee must cover. Counting *parties* would undercount a
 * party whose selected inputs sit on two of their own addresses — each key produces its
 * own vkey witness. A script payment credential is skipped: multiparty has no scripts, and
 * one appearing here means an input we cannot account for, which the roster catches.
 */
const distinctSignersOf = (utxos: readonly ContributedUtxo[]): number => {
  const hashes = new Set<string>()
  for (const utxo of utxos) {
    const info = Address.inspect(utxo.addressHex)
    if (info.paymentCredHex !== undefined && info.paymentIsScript !== true) {
      hashes.add(info.paymentCredHex.toLowerCase())
    }
  }
  return Math.max(hashes.size, 1)
}

/** Each party as `extractRequiredSigners` wants them: the key hashes behind their inputs. */
const contributingWalletsOf = (
  parties: readonly {
    readonly walletId: string
    readonly name: string
    readonly isComposer: boolean
    readonly selected: readonly ContributedUtxo[]
  }[],
): readonly ContributingWallet[] =>
  parties.map((contribution) => {
    const hashes = new Set<string>()
    for (const utxo of contribution.selected) {
      const info = Address.inspect(utxo.addressHex)
      if (info.paymentCredHex !== undefined && info.paymentIsScript !== true) hashes.add(info.paymentCredHex)
    }
    return {
      walletId: contribution.walletId,
      name: contribution.name,
      paymentKeyHashes: [...hashes],
      ...(contribution.isComposer ? {isSelf: true} : {}),
    }
  })

export const buildMultipartyTx = (params: {
  readonly rail: MultipartyBuildRail
  readonly contributions: readonly Contribution[]
  readonly recipients: readonly MultipartyRecipient[]
  readonly chainId: CardanoChainId
  readonly createdBy: string
  readonly createdAt: string
}): Effect.Effect<BuiltMultiparty, MultipartyBuildError> =>
  Effect.gen(function* () {
    const {rail, contributions, recipients} = params
    if (recipients.length === 0) {
      return yield* Effect.fail(new MultipartyBuildError({reason: 'no recipients'}))
    }
    const protocolParams = yield* rail.protocolParams.pipe(
      Effect.mapError((e) => new MultipartyBuildError({reason: e.message})),
    )

    // ⚠️ The SAME measurement the ordinary send and the agent build use, rather than a third
    // encode-then-measure. It throws on an unmeasurable floor, which is what the codec call it
    // replaced did — the composer's callback has nowhere to put "unknown", and treating it as
    // zero is the `OutputTooSmallUTxO` the floor exists to prevent.
    const composed = composeMultiparty(contributions, ({addressHex, value}) => {
      const floor = minAdaForOutput(
        protocolParams.coinsPerUtxoByte,
        AddressHex(addressHex),
        new Map([['', value.lovelace], ...(value.assets ?? new Map<string, bigint>())]),
      )
      if (floor === null) throw new Error(`min-ADA could not be measured for ${addressHex.slice(0, 16)}…`)
      return floor
    })
    if (!composed.ok) {
      return yield* Effect.fail(
        new MultipartyBuildError({reason: `composition refused: ${composed.failure.kind}`, compose: composed.failure}),
      )
    }

    const requested = sumValues(recipients.map((r) => r.value))
    // The contributions fund the recipients exactly, **per asset**. A mismatch means the
    // screen and the arithmetic disagree, and the difference would silently land in the
    // composer's change — which for a token is the whole of it, since a token nobody claims
    // has nowhere else to go.
    const difference = subtractValues(composed.composed.total, requested)
    if (!isEmptyValue(difference)) {
      return yield* Effect.fail(
        new MultipartyBuildError({
          reason: `contributions total ${composed.composed.total.lovelace} but recipients want ${requested.lovelace}`,
        }),
      )
    }

    const outputs = [
      ...recipients.map((r) => ({
        addressHex: r.addressHex,
        assets: bagOf(r.value.lovelace, r.value.assets),
      })),
      ...composed.composed.returns.map((party) => ({
        addressHex: party.returnAddressHex,
        assets: bagOf(party.returned.lovelace, party.returned.assets),
      })),
    ]

    /**
     * **Every selected coin is mandatory, the composer's included.**
     *
     * Each party has already chosen the minimum that covers its own contribution
     * (`selectFor`), so pinning them costs nothing in size — and not pinning them costs
     * the roster: with the co-contributors' inputs alone covering the outputs, selection
     * dropped the composer's entirely and the body named only one party.
     * `extractRequiredSigners` reads the body, so the wallet building the transaction
     * stopped being asked to sign it.
     */
    const mandatory = composed.composed.mandatoryInputs
    const build = (signerCount: number) =>
      Effect.try({
        try: () =>
          Plan.buildUnsigned({
            inputs: [],
            mandatoryInputs: mandatory.map((u) => planInputOf(u)),
            outputs: outputs.map((o) => ({...o, addressHex: AddressHex(o.addressHex)})),
            changeAddressHex: AddressHex(composed.composed.changeAddressHex),
            params: protocolParams,
            signerCount,
          }),
        catch: (e) => {
          // The ordinary send answers a size failure by folding its own UTxO set first.
          // That remedy does not exist here — you cannot consolidate a wallet you only
          // watch — so it is named rather than retried. Per-party selection already keeps
          // the input count near the minimum, so reaching this means genuinely too many
          // parties or recipients.
          //
          // Read off `_tag`, which the planner sets, rather than matched against the
          // message. The regex here looked for "too large" and "maxTxSize"; the sentence it
          // was given is "transaction is 27233 bytes, over the 16384-byte limit by 10849",
          // so the flag had never once been set and the branch it guards was unreachable.
          const message = e instanceof Error ? e.message : String(e)
          const tag = typeof e === 'object' && e !== null && '_tag' in e ? String((e as {_tag: unknown})._tag) : ''
          return new MultipartyBuildError({
            reason: message,
            // Both protocol bounds land here. They differ in remedy for an ordinary send —
            // split the transaction versus split the value across outputs — but not for
            // this one, where neither is available and the answer is the same: carry less.
            ...(tag === 'TxTooLargeError' || tag === 'ValueTooLargeError' ? {tooLarge: true} : {}),
          })
        },
      })

    /**
     * What the body spends.
     *
     * **`built.inputs` is the coin-selected subset of `plan.inputs` and excludes
     * `mandatoryInputs` entirely** — `buildPlanCore` adds the mandatory value separately
     * and never puts it in `selected`. Reading it alone reported zero inputs here, and the
     * roster derived from them came back empty: a transaction nobody was asked to sign.
     * Everything pinned is spent by definition, so it is the union.
     */
    const spentBy = (built: Plan.UnsignedPlanTx): readonly ContributedUtxo[] => {
      const ids = new Set(built.inputs.map((i) => `${i.txHash}#${i.index}`))
      return [...mandatory, ...composed.composed.parties.flatMap((p) => [...p.selected])].filter(
        (u, i, list) =>
          list.findIndex((o) => o.txHash === u.txHash && o.index === u.index) === i &&
          (mandatory.some((m) => m.txHash === u.txHash && m.index === u.index) || ids.has(`${u.txHash}#${u.index}`)),
      )
    }

    /**
     * A **shared wallet cannot be a multiparty contributor**, and this is where that is
     * enforced rather than assumed.
     *
     * Its coins sit at a script address, so what authorises the spend is a native script
     * plus its co-signers' CIP-1854 keys — not one payment key. `contributingWalletsOf` and
     * `extractRequiredSigners` both skip a script credential, correctly, because it can
     * never produce a vkey witness. The consequence if nothing checks: the party silently
     * drops off the roster while its coins stay in the body, so the transaction reads
     * "2 of 2 signed" with a third wallet's money in it, offers Submit, and is refused by
     * the node — which carries no script for that input and never asked its owners.
     *
     * Observed exactly that way before this check existed: two ordinary wallets and a
     * shared one, roster of two, "Contributing wallets 0 of 2", Duo's tADA spent by nobody's
     * signature.
     */
    const scriptOnly = contributingWalletsOf(composed.composed.parties).find((p) => p.paymentKeyHashes.length === 0)
    if (scriptOnly !== undefined) {
      return yield* Effect.fail(
        new MultipartyBuildError({
          reason: `${scriptOnly.name} spends from a script address and cannot co-fund`,
          scriptParty: scriptOnly.name,
        }),
      )
    }

    // Same fixed point as the ordinary send: build, count the witnesses the selection
    // actually needs, rebuild if the fee was sized for fewer.
    let signerCount = contributions.length
    let built = yield* build(signerCount)
    for (let round = 0; round < 4; round++) {
      const needed = distinctSignersOf(spentBy(built))
      if (needed <= signerCount) break
      signerCount = needed
      built = yield* build(signerCount)
    }

    const consumedInputs = spentBy(built)
    const signers: readonly EnvelopeSigner[] = extractRequiredSigners(
      consumedInputs.map((u) => ({addressHex: u.addressHex})),
      contributingWalletsOf(composed.composed.parties),
    )
    // Distinct *parties*, not roster rows: a row is one owed witness, and one party
    // spending from two of their own addresses owes two. Counting rows would let a
    // single-party body whose coins sit on two keys pass a check that exists to catch a
    // party dropped from the roster entirely.
    const partyCount = new Set(signers.map((s) => s.id)).size
    if (partyCount < 2) {
      // Every co-contributor input is mandatory, so this can only mean an address whose
      // credential we could not read. Refused rather than shipped as a roster that would
      // let the transaction look complete one signature early.
      return yield* Effect.fail(
        new MultipartyBuildError({reason: `roster derived ${partyCount} contributing wallets from the body`}),
      )
    }

    return {
      bodyHex: built.bodyHex,
      fee: built.fee,
      consumedInputs,
      envelope: constructEnvelope({
        kind: 'multiparty',
        bodyHex: built.bodyHex,
        // No script authorises a multiparty spend — each party's own key does. The empty
        // list is why `requiredFor` reads the roster rather than `scriptRequirements`.
        nativeScriptHexes: [],
        chainId: params.chainId,
        createdBy: params.createdBy,
        createdAt: params.createdAt,
        // Derivation is per contributing wallet and resolved by each signer from their own
        // inputs, so there is no single account or key index to record. Absent, not zero —
        // a literal 0 would claim a path this envelope does not describe.
        accountIndex: 0,
        signers,
      }),
    }
  })
