/**
 * Where an account's CIP-113 programmable tokens actually live, and how to read them.
 *
 * A programmable token is not held at any address this wallet derives. It sits at an address whose
 * **payment** credential is the deployment's shared Programmable Logic Base script and whose
 * **stake** credential is the account's own. So an account holding these looks empty to every
 * address-enumerating query, and is found only by constructing that pairing deliberately.
 *
 * ⚠️ **These are deliberately not `UTxO.UTxO`s.** A smart-wallet UTxO cannot be spent by an
 * ordinary transaction at all — the address's payment credential is the PLB script, so any spend of
 * it runs the whole CIP-113 machinery. Giving them the shape the coin selector consumes would let
 * one be picked to pay a fee, and the transaction would be unbuildable. The type is the guard:
 * `ProgrammableHolding` has no path into `projectSpendable`, and gaining one has to be a deliberate
 * act rather than an assignment that happens to compile.
 *
 * That is also why the ADA in them is reported separately from the wallet's balance. Measured on
 * the live preview scripts by the CIP-113 gate session: within a CIP-113 transfer, ADA may leave
 * a smart wallet to an ordinary address, while the tokens may not. So the ADA is the holder's and
 * **recoverable through a transfer** — never through an ordinary spend. It is neither spendable nor
 * lost, and the middle state is the honest one.
 *
 * @module
 */

import {Cip113, type Deployment as Cip113Deployment, Query as Cip113Query} from '@evolution-sdk/cip113'
import {Assets, Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {AssetNameHex, PolicyIdHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import type * as Inspect from '@evolution-sdk/review/Inspect'
import {Address} from '@pnyx/cardano-core'
import {Effect, type Layer} from 'effect'
import {logger} from '../../../logger'
// Type-only: the rail's own module reaches into this one, and a value import would close the cycle.
import type {CardanoRail} from '../rail'
import {selectCip113Deployment} from './deployment-selection'

/**
 * A smart-wallet UTxO belonging to an account, in the app's own shape.
 *
 * Structurally distinct from `UTxO.UTxO` on purpose — see the module note. The value is kept as
 * the raw hex the query returned rather than parsed here: parsing belongs with whatever renders it,
 * and inventing a parsed shape now would fix a decision the balance partition has not made yet.
 */
export type ProgrammableHolding = {
  readonly txHash: string
  readonly index: number
  /** The locked ADA and the programmable tokens. Was value CBOR; the query hands back a bag. */
  readonly assets: Assets.Assets
  readonly datumHex?: string
}

export type SmartWalletLocation = {
  /** The address to watch. PLB payment credential + this account's stake credential. */
  readonly addressBech32: string
  /** The account's stake credential, which is what the query is keyed on. */
  readonly owner: Cip113.Credential
}

const networkOf = (deployment: Cip113Deployment.Cip113Deployment): Address.Network =>
  deployment.network === Address.Network.Mainnet ? Address.Network.Mainnet : Address.Network.Testnet

/**
 * The smart-wallet address for an account under a deployment.
 *
 * `stakeKeyHashHex` is the account's own stake credential — the same one its reward address is
 * built from. An account with no stake credential (a bare-address watch, an enterprise address) has
 * no smart wallet at all, which is why this takes the hash rather than an account and the caller
 * has to have one.
 *
 * ⚠️ The PLB hash comes from the deployment record and nowhere else. It moves when the scripts are
 * redeployed — preview has already done it once — so a hardcoded copy would silently point at an
 * address holding nothing, which reads identically to an account with no tokens.
 */
export const smartWalletLocation = (
  deployment: Cip113Deployment.Cip113Deployment,
  stakeKeyHashHex: string,
): SmartWalletLocation => ({
  addressBech32: Address.toBech32Sync(
    Address.baseScriptHex(networkOf(deployment), deployment.plbScriptHashHex, stakeKeyHashHex),
  ),
  owner: {kind: 'key', hashHex: stakeKeyHashHex},
})

/**
 * The account's OWN smart-wallet address on this network, or `null` when it has none.
 *
 * `null` covers three genuinely different "no address" cases, all of which must read as absence
 * rather than as an error: no CIP-113 deployment is shipped for the network (the normal case), the
 * account has no stake credential, or the selection is misconfigured — which the caller logs.
 *
 * ⚠️ **This address is ours, and nothing derives it.** A smart wallet is the deployment's PLB script
 * over our own stake credential, so it appears in no address list and no gap scan. Every consumer
 * that asks "is this output ours" has to be told about it explicitly, or value we hold reads as value
 * that left: the history producer's own-address set omitted it, so a mint into our own smart wallet
 * came out as a small ada payment to a stranger and the token's activity list was empty.
 */
export const ownSmartWalletBech32 = (args: {
  /** CIP-142 network magic, not a network id — preview and preprod share the latter. */
  readonly protocolMagic: number
  readonly stakeKeyHashHex: string | null
}): string | null => {
  if (args.stakeKeyHashHex === null) return null
  const selection = selectCip113Deployment({protocolMagic: args.protocolMagic})
  if (selection.kind !== 'active') return null
  return smartWalletLocation(selection.deployment, args.stakeKeyHashHex).addressBech32
}

/**
 * One programmable holding with its value decoded — a smart-wallet UTxO's ada and tokens.
 *
 * Lives here rather than in the hook that first needed it: a service importing a type from a React
 * hook is backwards, and two consumers now read these (the portfolio and the agent surface).
 */
export type ProgrammableRow = {
  readonly id: string
  /** Lovelace locked alongside the tokens. Recoverable through a transfer, never by a plain spend. */
  readonly lovelace: bigint
  /** Reuses the decoder's own shape rather than restating it, so a field rename cannot drift. */
  readonly tokens: Inspect.ValueView['tokens']
}

export type OwnProgrammableHoldings =
  /** No CIP-113 deployment on this network, or no stake credential. Not an error, and not "none held". */
  | {readonly kind: 'unsupported'}
  | {readonly kind: 'ready'; readonly addressBech32: string; readonly rows: readonly ProgrammableRow[]}
  /**
   * We could not ask. Deliberately distinct from an empty `ready` — rendering them alike tells a
   * holder their tokens are gone during an outage.
   */
  | {readonly kind: 'unavailable'; readonly reason: string}

/**
 * This account's own programmable holdings, read and decoded.
 *
 * ⚠️ **One implementation, two consumers.** The portfolio hook and the agent's `readBalance` both
 * need exactly this, and a second copy is how the two came to disagree about what the wallet holds
 * in the first place.
 */
export const readOwnProgrammableHoldings = async (
  rail: CardanoRail,
  origin: string,
): Promise<OwnProgrammableHoldings> => {
  const stakeKeyHashHex = rail.account.stakeKeyHashHex
  if (stakeKeyHashHex === null) return {kind: 'unsupported'}
  const selection = selectCip113Deployment({protocolMagic: rail.config.protocolMagic})
  if (selection.kind !== 'active') {
    if (selection.kind === 'misconfigured') {
      // Not silent: the feature is meant to be on here and is not, which is an operator's problem.
      logger.warn('cardano: CIP-113 deployment selection is misconfigured', {origin, detail: selection.detail})
    }
    return {kind: 'unsupported'}
  }
  const {deployment} = selection
  const location = smartWalletLocation(deployment, stakeKeyHashHex)
  const exit = await Effect.runPromiseExit(
    readProgrammableHoldings(location).pipe(
      Effect.provide(programmableQueryLayer(deployment)),
      Effect.provideService(Decode, rail.decode),
      Effect.provideService(EvolutionProvider.ProviderEffect, rail.chain as EvolutionProvider.ProviderEffect),
    ),
  )
  if (exit._tag === 'Failure') {
    logger.warn('cardano: could not read programmable holdings', {origin, address: location.addressBech32})
    return {kind: 'unavailable', reason: 'query failed'}
  }
  // ⚠️ No decode and no skip-on-failure. A holding used to arrive as value CBOR, so an
  // undecodable one had to be dropped rather than rendered as zero — "a holding shown with no
  // tokens is a worse lie than one that is absent". The query hands back an `Assets` bag, which
  // cannot fail to decode, so the branch has nothing left to guard.
  const rows: ProgrammableRow[] = exit.value.map((holding) => ({
    id: `${holding.txHash}:${holding.index}`,
    lovelace: Assets.lovelaceOf(holding.assets),
    tokens: Assets.getUnits(holding.assets)
      .filter((unit) => unit !== 'lovelace')
      // Branded, not cast: `PolicyIdHex`/`AssetNameHex` validate their shape, and a unit split at
      // the wrong offset is exactly the mistake that produces a 70-character policy id holding
      // nothing. The bag's own units are well-formed, so this costs a check and buys the proof.
      .map((unit) => ({
        policyIdHex: PolicyIdHex(unit.slice(0, 56)),
        assetNameHex: AssetNameHex(unit.slice(56)),
        amount: Assets.getByUnit(holding.assets, unit),
      })),
  }))
  return {kind: 'ready', addressBech32: location.addressBech32, rows}
}

/**
 * Read an account's programmable-token holdings.
 *
 * Failure is propagated rather than flattened to an empty list. "This account holds no programmable
 * tokens" and "we could not ask" are different answers, and a caller that renders them alike tells
 * a holder their tokens are gone during an outage.
 */
export const readProgrammableHoldings = (
  location: SmartWalletLocation,
): Effect.Effect<readonly ProgrammableHolding[], Cip113.QueryError, Cip113.QueryTag> =>
  Effect.gen(function* () {
    const query = yield* Cip113.QueryTag
    const utxos = yield* query.smartWalletUtxos(location.owner)
    return utxos.map((u) => ({
      txHash: u.txHash,
      index: u.index,
      assets: u.assets,
      ...(u.datumHex === undefined ? {} : {datumHex: u.datumHex}),
    }))
  })

/**
 * The query layer for a deployment, over the rail's existing provider.
 *
 * ⚠️ The tier AND the query are the fork's now; only the transport is ours. It asks for
 * Evolution's `ProviderEffect`, which is what the rail's `chain` already is — so this is the
 * fork's layer under our name, with nothing in between.
 *
 * It needs no `Decode`: the fork's query reads the chain through the provider alone.
 */
export const programmableQueryLayer = (
  deployment: Cip113Deployment.Cip113Deployment,
): Layer.Layer<Cip113.QueryTag, never, EvolutionProvider.ProviderEffect> => Cip113Query.providerQuery(deployment)
