/**
 * Gathering everything a CIP-113 transfer needs and building it.
 *
 * The chain reads, the deployment record, the fetched substandards and the user's intent, in the
 * order they depend on each other, ending in an unsigned transaction the ordinary ceremony can
 * sign. Nothing here decides policy: the refusals live in `send-eligibility`, `recipient` and
 * `transfer-plan`, and this only runs them.
 *
 * ⚠️ **The witness set is not just signatures.** A transfer executes three or more Plutus scripts,
 * and their bytes plus redeemers travel as `witnessExtra` on the signing request. `signing-service`
 * already carries that field — the swap rail uses it for the same reason — so a script transaction
 * needs no new signing surface. Dropping it would produce a body the ledger rejects for a missing
 * script, after the user had signed.
 *
 * @module
 */

import {Cip113, Budgets as Cip113ExUnits, Query as Cip113Query} from '@evolution-sdk/cip113'
import type {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Assets as EvAssets} from '@evolution-sdk/evolution'
import type {Plan} from '@evolution-sdk/plan'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import type {Decode} from '@evolution-sdk/review/Decode'
import {Address} from '@pnyx/cardano-core'
import type {SigningRequest} from '@pnyx/signing-service'
import type {ResolvedInput} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {logger} from '../../../logger'
// The same measured min-UTxO the ordinary send and consolidation use — one implementation of the
// ledger's rule, not a CIP-113 copy of it.
import {minAdaForOutput} from '../../../screens/cardano/send/min-ada'
import type {CardanoRail} from '../rail'
import {utxoAddressBech32, utxoAddressHex, utxoAssetMap, utxoTxHashHex} from '../utxo-view'
import {selectCip113Deployment} from './deployment-selection'
import {programmableQueryLayer, smartWalletLocation} from './smart-wallet'
import {fetchSubstandards} from './substandard-source'
import {composeTransferPlan, type DecodedHolding, type TransferIntent, type TransferPlan} from './transfer-plan'

/**
 * PLB inputs one transaction may carry.
 *
 * 74 rather than the framework's own 86: the difference is 2M mem reserved for substandards, whose
 * cost is the issuer's to decide and cannot be known in advance. Reserving is the safe direction —
 * an over-reserved budget costs an extra transaction, an under-reserved one fails at submit.
 */
const MAX_PLB_INPUTS = 74

export type TransferBuild =
  | {
      readonly kind: 'built'
      readonly request: SigningRequest
      readonly bodyHex: string
      readonly fee: bigint
      /**
       * The smart-wallet UTxOs being spent, resolved.
       *
       * Passed to the review so it can say *what is leaving* — for a transfer that is the whole
       * point of the screen, and without them the inputs render as unattributed outpoints. They
       * are not in the wallet's own UTxO set (that is what a smart wallet is), so nothing
       * downstream can look them up; the builder is the only thing that knows.
       */
      readonly resolvedInputs: readonly ResolvedInput[]
      /**
       * The ORDINARY change this transfer emits — our own coins coming back, at our own address.
       *
       * ⚠️ **Not the smart-wallet outputs.** Those carry the token remainder and are not spendable by
       * an ordinary transaction, so they are not change in the sense the pending overlay means. This
       * is what funds the next ordinary send, and without it the overlay removes the funding inputs
       * and puts nothing back: a wallet that had just spent 2 ada of a 27,000 ada UTxO displayed 12.
       */
      readonly changeOutputs: readonly Plan.ChangeOutput[]
    }
  | {readonly kind: 'refused'; readonly reason: string; readonly detail: string}

/**
 * Build a transfer, or say why not.
 *
 * Every failure is a refusal with a reason rather than a thrown error: this runs behind a button,
 * and "something went wrong" is the least useful thing a wallet can say about a transaction it
 * declined to make.
 */
export const buildProgrammableTransfer = (
  rail: CardanoRail,
  groupId: string,
  intents: readonly TransferIntent[],
): Effect.Effect<TransferBuild, never, Decode | EvolutionProvider.ProviderEffect> =>
  Effect.gen(function* () {
    const selection = selectCip113Deployment({protocolMagic: rail.config.protocolMagic})
    if (selection.kind !== 'active') {
      return refuse('no-deployment', 'no CIP-113 deployment is configured for this network')
    }
    const {deployment} = selection
    // Refused rather than defaulted: execution budgets are measured against one deployment shape and
    // are not portable to another, so a deployment we have no measurement for has to stop here.
    const measurement = Cip113ExUnits.measurementFor(deployment.version)
    if (measurement === undefined) {
      return refuse('no-measurement', `no execution-budget measurement for CIP-113 ${deployment.version.id}`)
    }
    const budgets = budgetsFor(measurement)

    const stakeKeyHashHex = rail.account.stakeKeyHashHex
    if (stakeKeyHashHex === null) {
      // A bare-address watch has no stake credential, so it has no smart wallet to spend from.
      return refuse('no-account', 'this wallet has no staking key, so it holds no programmable tokens')
    }
    const location = smartWalletLocation(deployment, stakeKeyHashHex)

    const gathered = yield* Effect.either(
      Effect.gen(function* () {
        const query = yield* Cip113.QueryTag
        const registryNodes = yield* query.registryNodes
        const params = yield* query.protocolParams
        const holdings = yield* query.smartWalletUtxos(location.owner)
        const scripts = yield* Cip113Query.deploymentScripts(deployment)
        return {registryNodes, params, holdings, scripts}
      }).pipe(Effect.provide(programmableQueryLayer(deployment))),
    )
    if (gathered._tag === 'Left') {
      // Distinguished from "you hold nothing": a failed read must never read as an empty wallet.
      return refuse('chain-unavailable', 'could not read the token registry just now')
    }
    const {registryNodes, params, holdings, scripts} = gathered.right

    const decoded = decodeHoldings(holdings)
    const substandardHashes = neededSubstandards(registryNodes, intents)
    const fetched = yield* fetchSubstandards(substandardHashes)
    if (fetched.kind === 'missing') {
      logger.warn('cip113: transfer-logic scripts unavailable', {
        origin: 'buildProgrammableTransfer',
        missing: fetched.scriptHashes,
        asked: substandardHashes,
        koiosUrl: rail.config.koiosUrl,
        policies: intents.map((i) => i.policyHex),
        registryKeys: registryNodes.slice(0, 3).map((n) => n.node.keyHex),
      })
      return refuse('no-substandard', 'the rules for moving this token could not be fetched')
    }

    const spendable = yield* Effect.promise(() => Effect.runPromise(rail.spendableUtxos))
    const protocolParams = yield* rail.protocolParams.pipe(Effect.orElseSucceed(() => null))
    if (protocolParams === null) return refuse('no-params', 'could not read protocol parameters')

    const network = rail.config.networkId === 1 ? 1 : 0
    // One encoder for both the value a recipient receives and the bytes its floor is measured from.
    // Measuring one encoding and emitting another is how an output ends up below its own floor.
    const plan = composeTransferPlan(
      {
        deployment,
        scripts,
        registryNodes,
        protocolParamsRef: {txHash: params.txHash, index: params.index},
        // Read off the LIVE params datum, not the record: the bound is retunable in place
        // through the upgrade rail, so the chain is the authority for it.
        maxInlineDatumBytes: params.maxInlineDatumBytes,
        ourHoldings: decoded,
        intents,
        substandards: fetched.substandards,
        fundingInputs: spendable.map((u) => ({
          txHash: TxHashHex(utxoTxHashHex(u)),
          index: Number(u.index),
          assets: u.assets,
        })),
        collateral: spendable.slice(0, 1).map((u) => ({txHash: TxHashHex(utxoTxHashHex(u)), index: Number(u.index)})),
        changeAddressHex: rail.account.addressHex,
        // PlutusV3 only: every script in a CIP-113 transfer is V3, and a cost model for a language
        // the transaction does not use changes the script_data_hash for nothing.
        costModels:
          protocolParams.plutusV3CostModel === undefined
            ? []
            : [{language: 2, costs: protocolParams.plutusV3CostModel}],
        network,
        params: protocolParams,
        budgetsFor: budgets,
        // The floor a smart-wallet output must carry, measured from that output's own bytes. The
        // address is built with the same function `buildTransferTx` uses, so what is measured is
        // what is emitted.
        minAdaForRecipient: (recipient, assets) =>
          minAdaForOutput(
            protocolParams.coinsPerUtxoByte,
            Cip113.smartWalletAddressHex(network, deployment.plbScriptHashHex, recipient),
            assets,
          ),
      },
      MAX_PLB_INPUTS,
    )
    if (plan.kind === 'incomplete') return refuse(plan.reason, plan.detail)

    const built = yield* Effect.either(Cip113.buildTransferTx(plan.request))
    if (built._tag === 'Left') {
      return refuse('build-failed', 'this transfer could not be assembled')
    }

    const spentIds = new Set(plan.request.plbInputs.map((i) => `${i.txHash}:${i.index}`))
    // The funding inputs the builder actually chose, not everything offered. These are ordinary
    // UTxOs at our own address, and without resolving them too the review calls our own coins
    // external — which is how a transfer ended up reading as pure gain.
    const chosenFunding = new Set(built.right.inputs.map((i) => `${i.txHash}:${i.index}`))
    const fundingResolved: ResolvedInput[] = spendable
      .filter((u) => chosenFunding.has(`${utxoTxHashHex(u)}:${Number(u.index)}`))
      .map((u) => ({
        txHashHex: utxoTxHashHex(u),
        index: Number(u.index),
        addressHex: utxoAddressHex(u),
        addressBech32: utxoAddressBech32(u),
        coin: u.assets.lovelace,
        tokens: [...utxoAssetMap(u)].map(([id, amount]) => {
          const [policyIdHex = '', assetNameHex = ''] = id.split('.')
          return {policyIdHex, assetNameHex, amount}
        }),
      }))
    return {
      kind: 'built',
      bodyHex: built.right.bodyHex,
      fee: built.right.fee,
      // `@evolution-sdk/plan` carries no brands, so the planner's own output hex is
      // re-branded here rather than widening every downstream consumer of a change output.
      changeOutputs: built.right.changeOutputs.map((out) => ({
        txHash: TxHashHex(out.txHash),
        index: out.index,
        assets: out.assets,
      })),
      resolvedInputs: [
        ...fundingResolved,
        ...decoded
          .filter((d) => spentIds.has(`${d.utxo.txHash}:${d.utxo.index}`))
          .map(
            (d): ResolvedInput => ({
              txHashHex: d.utxo.txHash,
              index: d.utxo.index,
              addressHex: Address.fromBech32Sync(Bech32(location.addressBech32)),
              addressBech32: location.addressBech32,
              coin: d.lovelace,
              tokens: [...d.assets].map(([id, amount]) => {
                const [policyIdHex = '', assetNameHex = ''] = id.split('.')
                return {policyIdHex, assetNameHex, amount}
              }),
            }),
          ),
      ],
      request: {
        groupId,
        payload: {
          _tag: 'CardanoTx',
          bodyHex: built.right.bodyHex,
          networkId: rail.config.networkId,
          protocolMagic: rail.config.protocolMagic,
          // The scripts and redeemers the ledger needs. Without these the body is unverifiable.
          witnessExtra: built.right.witnessExtra,
        },
      } satisfies SigningRequest,
    }
  })

const refuse = (reason: string, detail: string): TransferBuild => ({kind: 'refused', reason, detail})

/**
 * Budgets for a transfer of this exact shape, measured upstream: PLB flat per input, PLG linear
 * in the inputs *and* in the outputs.
 *
 * ⚠️ Outputs are not the input count. A transfer returning a remainder to the sender has one more
 * output than it has recipients, and budgeting it as though outputs tracked inputs is what the
 * node rejected on 2026-08-16. The plan asks for this once it knows its own shape, rather than the
 * caller guessing ahead of it.
 *
 * `exceedsTxLimit` is checked rather than ignored — it means the framework alone is over the
 * per-transaction limit *before* any substandard, so the transfer has to be split. Building anyway
 * would produce a transaction that cannot execute.
 *
 * ⚠️ The measurement is the deployment's own, resolved by the caller from `deployment.version`.
 * These figures are not portable between deployment shapes — budgeting an alpha.4 transfer with
 * alpha.2's numbers builds a transaction that cannot execute.
 */
const budgetsFor =
  (measurement: Cip113ExUnits.TransferMeasurement) =>
  (
    inputs: number,
    outputs: number,
  ): {readonly plb: readonly [bigint, bigint]; readonly transfer: readonly [bigint, bigint]} | null => {
    const budgets = Cip113ExUnits.transferBudgets(Math.max(1, inputs), Math.max(1, outputs), measurement)
    // `TransferRequest` wants tuples; the measurement carries a named record. Converted here rather
    // than by the composer, which should not know how a budget is spelled.
    return budgets.exceedsTxLimit
      ? null
      : {
          plb: [budgets.plbSpend.mem, budgets.plbSpend.steps],
          transfer: [budgets.transferDelegate.mem, budgets.transferDelegate.steps],
        }
  }

/**
 * The transfer-logic hashes the moved policies need.
 *
 * From the registry rather than from the intents, because a policy's rules are the registry's
 * statement about it and not something a caller may assert.
 */
const neededSubstandards = (
  nodes: readonly Cip113.RegistryNodeRef[],
  intents: readonly TransferIntent[],
): readonly string[] => {
  const policies = new Set(intents.map((i) => i.policyHex.toLowerCase()))
  return nodes
    .filter((n) => policies.has(n.node.keyHex.toLowerCase()))
    .map((n) => n.node.transferLogicScript.hashHex.toLowerCase())
}

/**
 * A smart-wallet UTxO's contents, split the way the composer counts them.
 *
 * ⚠️ **Pure, and there is nothing left to decode.** A `SmartWalletUtxo` carries an `Assets` bag
 * rather than value CBOR, so this used to run `Inspect.value` over every holding inside an
 * Effect — with a codec requirement and an `orElseSucceed` that turned an undecodable holding
 * into an empty one. A bag cannot fail to decode, so neither branch has anything to say.
 *
 * ⚠️ **The unit spelling changes here and the conversion is explicit.** `Assets.getUnits` emits
 * the JOINED form (`policyId + assetName`) and `DecodedHolding.assets` is keyed with the DOTTED
 * one (`policy.name`), which is what the intents and `remainderAssets` compare against. The two
 * are both `string`, so nothing catches a mix-up: a joined key handed to a dotted reader is a
 * 70-character policy id holding nothing, and the answer is `0n` rather than an error.
 */
const decodeHoldings = (holdings: readonly Cip113.SmartWalletUtxo[]): readonly DecodedHolding[] =>
  holdings.map((utxo) => ({
    utxo,
    lovelace: EvAssets.lovelaceOf(utxo.assets),
    assets: new Map(
      EvAssets.getUnits(utxo.assets)
        .filter((unit) => unit !== 'lovelace')
        .map((unit) => [`${unit.slice(0, 56)}.${unit.slice(56)}`, EvAssets.getByUnit(utxo.assets, unit)] as const),
    ),
  }))

export type {TransferPlan}
