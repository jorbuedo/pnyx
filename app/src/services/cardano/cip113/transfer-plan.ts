/**
 * Composing a CIP-113 `TransferAct` from what the wallet knows.
 *
 * Everything `buildTransferTx` needs, assembled from the deployment record, the chain reads and the
 * user's intent. Pure: every input arrives as an argument, so the whole composition is testable
 * without a network, and the one thing the wallet cannot obtain is a parameter rather than a
 * silent omission.
 *
 * ⚠️ **The substandard is that thing.** A registry node names a policy's `transfer_logic` by *hash*;
 * it does not carry the script. `deploymentScripts()` fetches PLB and PLG from the deployment's
 * published reference UTxOs, but substandards are the issuer's and are not published there. So the
 * bytes and redeemer must be supplied by whoever holds them, and a transfer cannot be built without
 * them. That is a real dependency, not a gap to paper over: fabricating a redeemer would fail on
 * the user's transaction after they had signed it.
 *
 * @module
 */

import type {Cip113, Deployment as Cip113Deployment} from '@evolution-sdk/cip113'
import {Assets} from '@evolution-sdk/evolution'
import type {Plan} from '@evolution-sdk/plan'
import {AddressHex, ScriptHex} from '@evolution-sdk/review/Brands'

/** One asset moving, and to whom. */
export type TransferIntent = {
  readonly policyHex: string
  readonly assetNameHex: string
  readonly quantity: bigint
  /** The recipient's stake credential — the owner of the destination smart wallet. */
  readonly recipient: Cip113.Credential
}

export type TransferPlanInput = {
  readonly deployment: Cip113Deployment.Cip113Deployment
  /** PLB and transfer-delegate bytes, fetched and hash-verified against the record. */
  readonly scripts: {readonly plbScriptHex: string; readonly transferScriptHex: string}
  readonly registryNodes: readonly Cip113.RegistryNodeRef[]
  readonly protocolParamsRef: Cip113.OutPoint
  /** `max_inline_datum_bytes` from the live params datum, when the deployment carries it. */
  readonly maxInlineDatumBytes?: bigint | undefined
  /** Our smart-wallet UTxOs with their contents already decoded. */
  readonly ourHoldings: readonly DecodedHolding[]
  readonly intents: readonly TransferIntent[]
  /**
   * Transfer-logic scripts for every moved-and-registered policy, keyed by hash.
   *
   * Supplied because the wallet cannot derive them — see the module note. A policy whose
   * substandard is missing makes the plan `incomplete` rather than producing a transaction that
   * fails at submit.
   */
  readonly substandards: ReadonlyMap<string, Cip113.Substandard>
  /** Ordinary key UTxOs. The fee and collateral come from here and nowhere else. */
  readonly fundingInputs: readonly Plan.PlanInput[]
  readonly collateral: readonly Cip113.OutPoint[]
  readonly changeAddressHex: string
  readonly costModels: Cip113.TransferRequest['costModels']
  readonly network: Cip113.TransferRequest['network']
  /** Ledger protocol parameters for fee + min-UTxO, from the provider. */
  readonly params: Cip113.TransferRequest['params']
  /**
   * Measured budgets for a shape, from `Cip113ExUnits.transferBudgets`. `null` when the framework
   * alone exceeds the per-transaction execution limit.
   *
   * ⚠️ Asked for *after* the shape is known, not before. The transfer delegate is charged per
   * input **and** per output, and only this module knows how many outputs there will be — a
   * remainder adds one that no count of inputs or recipients predicts. Budgeting ahead of the
   * shape is what produced a transaction the node rejected for overspending.
   */
  readonly budgetsFor: (
    inputs: number,
    outputs: number,
  ) => {readonly plb: readonly [bigint, bigint]; readonly transfer: readonly [bigint, bigint]} | null
  /**
   * The ledger's min-UTxO for the recipient output that would carry `assets`, measured from that
   * output's own bytes. Injected because it needs the deployment's address derivation, and a
   * composer that can only run inside an Effect is a composer that cannot be unit-tested — which
   * for the step that decides where a user's tokens land is the wrong trade.
   *
   * ⚠️ `encodeValue` used to sit beside this for the same reason. It is gone: the plan carries
   * `Assets` now, so building a recipient's value is pure arithmetic with nothing to inject.
   *
   * ⚠️ Not a constant, per recipient. The floor depends on the destination address and on which
   * assets land there, so a figure shared across outputs is wrong for all but one of them.
   *
   * `null` means the floor could not be computed — unknown, never zero.
   */
  readonly minAdaForRecipient: (recipient: Cip113.Credential, assets: ReadonlyMap<string, bigint>) => bigint | null
}

/** A smart-wallet UTxO with its contents decoded: the locked lovelace and per-asset amounts. */
export type DecodedHolding = {
  readonly utxo: Cip113.SmartWalletUtxo
  /** Lovelace sitting with the tokens. Recoverable through a transfer, never by an ordinary spend. */
  readonly lovelace: bigint
  /** Keyed `policy.name`. */
  readonly assets: ReadonlyMap<string, bigint>
}

export type TransferPlan =
  | {readonly kind: 'ready'; readonly request: Cip113.TransferRequest; readonly movedPolicies: readonly string[]}
  | {readonly kind: 'incomplete'; readonly reason: TransferPlanGap; readonly detail: string}

export type TransferPlanGap =
  /** Nothing to move. */
  | 'no-intents'
  /** The wallet does not hold enough of a policy being moved. */
  | 'insufficient-holdings'
  /** A moved policy has no transfer-logic script available. */
  | 'missing-substandard'
  /** No ordinary UTxOs to pay the fee from. Smart-wallet ADA cannot pay it. */
  | 'no-funding'
  /** More PLB inputs than one transaction can execute. */
  | 'too-many-inputs'
  /** The chosen UTxOs belong to different smart wallets, so there is no one owner to return to. */
  | 'mixed-owners'
  /** The framework scripts alone exceed one transaction's execution budget at this shape. */
  | 'over-budget'
  /** An output's min-UTxO could not be computed, so it cannot be funded correctly. */
  | 'unencodable-output'

/**
 * Compose the request, or say precisely what is missing.
 *
 * `maxPlbInputs` is the caller's budget ceiling — the measured framework limit is 86, or 74 if 2M
 * mem is reserved for substandards, and reserving is the right default because a substandard's
 * cost is the issuer's to decide and cannot be presetted.
 */
export const composeTransferPlan = (input: TransferPlanInput, maxPlbInputs: number): TransferPlan => {
  if (input.intents.length === 0) return {kind: 'incomplete', reason: 'no-intents', detail: 'nothing selected'}
  if (input.fundingInputs.length === 0) {
    // Not a recoverable shortfall the builder could work around: the fee and collateral must come
    // from key UTxOs, and a wallet whose ADA is all inside smart wallets has none to offer.
    return {
      kind: 'incomplete',
      reason: 'no-funding',
      detail: 'sending a programmable token needs ordinary ADA for the fee, and this wallet has none',
    }
  }

  const movedPolicies = [...new Set(input.intents.map((i) => i.policyHex.toLowerCase()))]

  const missing = movedPolicies.filter((p) => substandardFor(p, input) === undefined)
  if (missing.length > 0) {
    return {
      kind: 'incomplete',
      reason: 'missing-substandard',
      detail: `no transfer-logic script for ${missing.length === 1 ? 'this token' : `${missing.length} of these tokens`}`,
    }
  }

  const selection = selectHoldings(input.ourHoldings, input.intents)
  if (selection === null) {
    return {kind: 'incomplete', reason: 'insufficient-holdings', detail: 'not enough of one of these tokens'}
  }
  if (selection.length > maxPlbInputs) {
    // Reported rather than truncated: dropping inputs would silently send less than asked.
    return {
      kind: 'incomplete',
      reason: 'too-many-inputs',
      detail: `this would need ${selection.length} inputs and one transaction can carry ${maxPlbInputs}`,
    }
  }

  // The remainder returns to the wallet the inputs came from, so they must all come from one.
  // Taken from the spent UTxOs rather than supplied, because an owner that disagreed with them
  // would send the user's change to a stranger's smart wallet and nothing would say so.
  const owners = new Set(selection.map(({utxo}) => `${utxo.owner.kind}:${utxo.owner.hashHex.toLowerCase()}`))
  if (owners.size > 1) {
    return {kind: 'incomplete', reason: 'mixed-owners', detail: 'these tokens sit in different smart wallets'}
  }
  const outputs = transferOutputs(input, selection)
  if (outputs === null) {
    return {kind: 'incomplete', reason: 'unencodable-output', detail: 'an output for this transfer could not be sized'}
  }

  const budgets = input.budgetsFor(selection.length, outputs.length)
  if (budgets === null) {
    return {
      kind: 'incomplete',
      reason: 'over-budget',
      detail: 'this transfer needs more execution budget than one transaction allows',
    }
  }

  const substandards = dedupeSubstandards(movedPolicies, input)

  return {
    kind: 'ready',
    movedPolicies,
    request: {
      network: input.network,
      params: input.params,
      // The on-chain schema comes from the RECORD, never from the library default: the default
      // tracks upstream `main`, and a deployment is whatever shape it was deployed at.
      version: input.deployment.version,
      plbScriptHashHex: input.deployment.plbScriptHashHex,
      plbScriptHex: ScriptHex(input.scripts.plbScriptHex),
      transferScriptHashHex: input.deployment.transferScriptHashHex,
      transferScriptHex: ScriptHex(input.scripts.transferScriptHex),
      transferExUnits: budgets.transfer,
      protocolParamsRef: input.protocolParamsRef,
      // Upstream #106: a programmable output's inline datum must fit the live bound, or the
      // transfer validator rejects it. Supplying it turns that into a refusal here instead of a
      // signed transaction the node throws out. Absent when the deployment predates the field.
      ...(input.maxInlineDatumBytes !== undefined ? {maxInlineDatumBytes: input.maxInlineDatumBytes} : {}),
      registryNodes: input.registryNodes,
      movedPolicies,
      substandards,
      plbInputs: selection.map(({utxo}) => ({
        txHash: utxo.txHash,
        index: utxo.index,
        assets: utxo.assets,
        owner: utxo.owner,
        exUnits: budgets.plb,
        ...(utxo.datumHex === undefined ? {} : {datumHex: utxo.datumHex}),
      })),
      plbOutputs: outputs,
      fundingInputs: input.fundingInputs,
      collateral: input.collateral,
      changeAddressHex: AddressHex(input.changeAddressHex),
      costModels: input.costModels,
    },
  }
}

const substandardFor = (policyHex: string, input: TransferPlanInput): Cip113.Substandard | undefined => {
  const node = input.registryNodes.find((n) => n.node.keyHex.toLowerCase() === policyHex)
  if (node === undefined) return undefined
  return input.substandards.get(node.node.transferLogicScript.hashHex.toLowerCase())
}

/**
 * One entry per distinct script hash.
 *
 * Deduped because several tokens from one issuer share a transfer-logic script, and listing it
 * twice would pay for it twice — the difference between batching same-issuer tokens cheaply and
 * batching across issuers expensively.
 */
const dedupeSubstandards = (
  movedPolicies: readonly string[],
  input: TransferPlanInput,
): readonly Cip113.Substandard[] => {
  const byHash = new Map<string, Cip113.Substandard>()
  for (const policy of movedPolicies) {
    const sub = substandardFor(policy, input)
    if (sub !== undefined) byHash.set(sub.scriptHashHex.toLowerCase(), sub)
  }
  return [...byHash.values()]
}

/**
 * The smallest set of our smart-wallet UTxOs covering every intent.
 *
 * `null` when the wallet does not hold enough. Deliberately not a partial selection: sending less
 * than asked without saying so is the failure this returns a `null` to prevent.
 *
 * ⚠️ Selection is by *containment*, not by value: a smart-wallet UTxO can hold several policies at
 * once, so one input may satisfy several intents and a naive per-intent loop would spend it twice.
 */
export const selectHoldings = (
  holdings: readonly DecodedHolding[],
  intents: readonly TransferIntent[],
): readonly DecodedHolding[] | null => {
  const needed = new Map<string, bigint>()
  for (const intent of intents) {
    const key = `${intent.policyHex.toLowerCase()}.${intent.assetNameHex.toLowerCase()}`
    needed.set(key, (needed.get(key) ?? 0n) + intent.quantity)
  }
  const chosen: DecodedHolding[] = []
  for (const holding of holdings) {
    if ([...needed.values()].every((q) => q <= 0n)) break
    // Only take a holding that moves us forward. A UTxO holding none of what we need is an input
    // we would pay a script execution for and gain nothing from.
    const helps = [...holding.assets].some(([key, amount]) => amount > 0n && (needed.get(key) ?? 0n) > 0n)
    if (!helps) continue
    chosen.push(holding)
    for (const [key, amount] of holding.assets) {
      const outstanding = needed.get(key)
      if (outstanding !== undefined) needed.set(key, outstanding - amount)
    }
  }
  return [...needed.values()].every((q) => q <= 0n) ? chosen : null
}

/**
 * Where every token the inputs carry ends up: one output per recipient, then one back to us.
 *
 * ⚠️ **The remainder output is not optional.** A programmable token may only sit at a PLB address,
 * so anything left over after the recipients are paid has to be given a smart-wallet output of its
 * own. Without one it falls through to the builder's change, which goes to an ordinary key address
 * — outside the regime, which the transfer scripts exist to prevent. That is invisible until the
 * ledger gets past its UTxO rules and actually runs them.
 */
const transferOutputs = (
  input: TransferPlanInput,
  selection: readonly DecodedHolding[],
): readonly Cip113.PlbOutput[] | null => {
  const recipients = recipientOutputs(input)
  if (recipients === null) return null
  const outputs = [...recipients]
  const remainder = remainderAssets(selection, input.intents)
  if (remainder.size === 0) return outputs
  // Any UTxO we spend is ours, so the owner of the first is the owner of all — `composeTransferPlan`
  // refuses a mixed selection before reaching here.
  const owner = selection[0]?.utxo.owner
  if (owner === undefined) return outputs
  const floor = input.minAdaForRecipient(owner, remainder)
  if (floor === null) return null
  return [...outputs, {recipient: owner, assets: bagOf(floor, remainder)}]
}

/**
 * A recipient output's bag: its min-ADA floor plus the assets it is owed.
 *
 * ⚠️ The keys are this module's DOTTED spelling (`policy.name`), and `Assets.fromRecord` reads
 * both that and its own joined one. Handing a dotted key to a joined reader answers `0n` — a
 * plausible "not here" rather than an error — so the two spellings crossing a boundary is worth
 * saying out loud even where it is now handled.
 */
const bagOf = (lovelace: bigint, assets: ReadonlyMap<string, bigint>): Assets.Assets =>
  Assets.fromRecord({lovelace, ...Object.fromEntries(assets)})

/**
 * Everything the spent UTxOs hold that the recipients do not take.
 *
 * ⚠️ Over *all* assets on those UTxOs, not just the policies being moved. A smart-wallet UTxO can
 * carry several policies at once, so spending one to move policy A picks up policy B too — and B
 * has to come back or it leaves the regime just as surely as A's leftovers would.
 */
const remainderAssets = (
  selection: readonly DecodedHolding[],
  intents: readonly TransferIntent[],
): ReadonlyMap<string, bigint> => {
  const left = new Map<string, bigint>()
  for (const holding of selection) {
    for (const [key, amount] of holding.assets) left.set(key, (left.get(key) ?? 0n) + amount)
  }
  for (const intent of intents) {
    const key = `${intent.policyHex.toLowerCase()}.${intent.assetNameHex.toLowerCase()}`
    const after = (left.get(key) ?? 0n) - intent.quantity
    if (after > 0n) left.set(key, after)
    else left.delete(key)
  }
  return left
}

/**
 * One output per recipient, carrying everything that recipient is owed.
 *
 * Grouped by recipient rather than one output per intent: two intents to the same person are one
 * output, and paying min-ADA twice for the same destination is real money.
 */
const recipientOutputs = (input: TransferPlanInput): readonly Cip113.PlbOutput[] | null => {
  const byRecipient = new Map<string, {recipient: Cip113.Credential; assets: Map<string, bigint>}>()
  for (const intent of input.intents) {
    const key = `${intent.recipient.kind}:${intent.recipient.hashHex.toLowerCase()}`
    const entry = byRecipient.get(key) ?? {recipient: intent.recipient, assets: new Map<string, bigint>()}
    const asset = `${intent.policyHex.toLowerCase()}.${intent.assetNameHex.toLowerCase()}`
    entry.assets.set(asset, (entry.assets.get(asset) ?? 0n) + intent.quantity)
    byRecipient.set(key, entry)
  }
  const outputs: Cip113.PlbOutput[] = []
  for (const {recipient, assets} of byRecipient.values()) {
    const floor = input.minAdaForRecipient(recipient, assets)
    // Unknown, never zero: an output whose floor the codec could not compute is one we cannot
    // fund correctly, and guessing it is what the ledger rejects.
    if (floor === null) return null
    outputs.push({recipient, assets: bagOf(floor, assets)})
  }
  return outputs
}
