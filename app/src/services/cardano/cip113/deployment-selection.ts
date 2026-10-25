/**
 * Which CIP-113 deployment this build is talking to.
 *
 * The **hashes** are shipped in the binary and reviewed, because the configured PLB is a trust
 * anchor: `deploymentScripts()` verifies chain-sourced script CBOR against it, so whoever chooses
 * the hash chooses which script the wallet will build a transfer into. A remotely-editable hash
 * would put that choice in an unsigned, unvalidated channel where the realistic failure is a typo.
 *
 * The **choice among them** is a different thing, and it is what deserves a per-environment source
 * of truth: a selector can only pick a record that was already reviewed and shipped, so the worst a
 * wrong value can do is name nothing — which this refuses, loudly, rather than resolving to a
 * neighbouring deployment.
 *
 * ⚠️ **A new deployment still needs an app release.** There is no cross-deployment on-chain anchor
 * and there cannot be — the params NFT policy is one-shot, minted from a seed UTxO, so a fresh
 * bootstrap necessarily produces a new one. See `docs/CARDANO_CUSTODY_MODEL.md` §5.
 *
 * @module
 */

import {Deployment as Cip113Deployment} from '@evolution-sdk/cip113'
import type {Cip113Marks} from './activity'

export type DeploymentSelection =
  | {readonly kind: 'active'; readonly deployment: Cip113Deployment.Cip113Deployment}
  /** Nothing to talk to, and that is a normal state — most networks have no deployment. */
  | {readonly kind: 'none'; readonly reason: 'no-deployment-for-network' | 'disabled'}
  /**
   * Configuration names something that does not exist, or is ambiguous. Deliberately distinct from
   * `none`: the feature is *meant* to be on here and is not, which is an operator's problem to see
   * rather than a user's to be silently denied.
   */
  | {readonly kind: 'misconfigured'; readonly detail: string}

export type DeploymentSelectionInput = {
  /**
   * CIP-142 network magic of the chain the wallet is on — `rail.config.protocolMagic`.
   *
   * ⚠️ Not a `Network`. Preview and preprod are both `Network.Testnet` and carry different,
   * hash-disjoint protocol instances, so the address header cannot choose between them; keying
   * selection on it would make every testnet build ambiguous the moment a second testnet record
   * ships, which it now has.
   */
  readonly protocolMagic: number
  /**
   * A deployment id from configuration — env or remote config. Optional; absent means "whatever is
   * shipped for this network". It may only name a **shipped** record, which is what makes it safe
   * to source remotely.
   */
  readonly requestedId?: string | undefined
  /** Kill switch. `false` turns the whole surface off without a release. */
  readonly enabled?: boolean | undefined
  /**
   * Injected so the selection is pure and testable; defaults to the shipped set.
   *
   * Values are `| undefined` because that is how the library declares its own record — a lookup
   * miss must be visible in the type regardless of what `noUncheckedIndexedAccess` is set to in
   * whichever project consumes it. Matching the declaration here keeps that guarantee instead of
   * quietly narrowing it away.
   */
  readonly available?: Readonly<Record<string, Cip113Deployment.Cip113Deployment | undefined>>
}

/**
 * Resolve the deployment for a network.
 *
 * **Never falls back.** A requested id that names nothing, or names a record for another network,
 * is a refusal — not a quiet resolution to whatever else is available. Falling back would point
 * every holder's smart-wallet address at a different deployment, and an address holding nothing is
 * indistinguishable on screen from an account with no tokens.
 */
/*
 * Not delegating the id branch to the library's `deploymentById`: that resolves against the fixed
 * shipped set, and the injected `available` is what keeps these tests hermetic. The overlap is a
 * map lookup, not domain knowledge — which lives in `DEPLOYMENTS`, and is consumed, not copied.
 */
export const selectCip113Deployment = (input: DeploymentSelectionInput): DeploymentSelection => {
  if (input.enabled === false) return {kind: 'none', reason: 'disabled'}
  const available = input.available ?? Cip113Deployment.DEPLOYMENTS

  if (input.requestedId !== undefined && input.requestedId.length > 0) {
    const named = available[input.requestedId]
    if (named === undefined) {
      return {kind: 'misconfigured', detail: `no deployment named ${JSON.stringify(input.requestedId)} is shipped`}
    }
    if (named.protocolMagic !== input.protocolMagic) {
      return {
        kind: 'misconfigured',
        detail: `deployment ${input.requestedId} is for network magic ${named.protocolMagic}, this wallet is on ${input.protocolMagic}`,
      }
    }
    return {kind: 'active', deployment: named}
  }

  const forChain = Object.values(available).filter(
    (d): d is Cip113Deployment.Cip113Deployment => d !== undefined && d.protocolMagic === input.protocolMagic,
  )
  const only = forChain[0]
  if (only === undefined) return {kind: 'none', reason: 'no-deployment-for-network'}
  if (forChain.length > 1) {
    // Two shipped records for one chain is exactly the moment after a redeploy when both the old
    // and the new are present. Guessing picks one of two live protocols at random.
    return {
      kind: 'misconfigured',
      detail: `${forChain.length} deployments are shipped for network magic ${input.protocolMagic}; configuration must name one`,
    }
  }
  return {kind: 'active', deployment: only}
}

/** The PLB credentials to hand the custody resolver, current generation and superseded ones. */
export const cip113ProtocolScripts = (
  deployment: Cip113Deployment.Cip113Deployment,
): ReadonlyMap<string, {readonly protocol: 'cip113'; readonly generationId?: string}> => {
  const scripts = new Map<string, {readonly protocol: 'cip113'; readonly generationId?: string}>()
  // Prior generations first, so a record that (wrongly) lists the current hash as prior does not
  // demote it — the current deployment always wins its own credential.
  for (const prior of deployment.priorGenerations ?? []) {
    scripts.set(prior.plbScriptHashHex.toLowerCase(), {protocol: 'cip113', generationId: prior.id})
  }
  scripts.set(deployment.plbScriptHashHex.toLowerCase(), {protocol: 'cip113'})
  return scripts
}

/**
 * Every script credential that makes a transaction *this deployment's*, lowercase.
 *
 * More than the PLB. A holder's four transactions on preview were a stake registration, a registry
 * insert, an issuance and a transfer — and only two of them touch a smart wallet. Recognising the
 * PLB alone labelled those two and left the registry insert reading "Smart Contract", which is a
 * protocol half-recognised and looks like a bug rather than a boundary.
 *
 * Empty when no deployment is shipped for the chain, which matches nothing.
 */
export const activeCip113Marks = (protocolMagic: number): Cip113Marks => {
  const selection = selectCip113Deployment({protocolMagic})
  if (selection.kind !== 'active') {
    return {scriptCredentials: new Set(), plbScriptHashHex: null, registryPolicyHex: null}
  }
  const {deployment} = selection
  return {
    scriptCredentials: new Set(
      [
        deployment.plbScriptHashHex,
        deployment.registrySpendScriptHashHex,
        // Prior generations count too: a transaction against a superseded deployment is still this
        // protocol, and "Smart Contract" would be the less informative of two honest answers.
        ...(deployment.priorGenerations ?? []).map((g) => g.plbScriptHashHex),
      ].map((h) => h.toLowerCase()),
    ),
    plbScriptHashHex: deployment.plbScriptHashHex.toLowerCase(),
    registryPolicyHex: deployment.registryPolicyHex.toLowerCase(),
  }
}

/**
 * Every CIP-113 script credential we ship for an address network, lowercase.
 *
 * The inclusive counterpart to {@link activeCip113Marks}, and the difference is deliberate:
 * SELECTION must be exact because it decides where funds are sent, so it keys on the chain's
 * network magic and refuses ambiguity. RECOGNITION only decides a label, so it may span every
 * record for the network — and it has to, because a reviewed transaction carries an address
 * header and no magic, leaving preview and preprod indistinguishable at that layer.
 *
 * Over-recognising costs a transaction being called "programmable token" when it was that
 * protocol on the other testnet. Under-recognising costs a real transfer reading "Smart
 * Contract", which is the failure this is for.
 */
export const allCip113ScriptCredentials = (networkId: number): ReadonlySet<string> => {
  const network = networkId === 1 ? 1 : 0
  const creds = new Set<string>()
  for (const deployment of Object.values(Cip113Deployment.DEPLOYMENTS)) {
    if (deployment === undefined || deployment.network !== network) continue
    for (const hash of [
      deployment.plbScriptHashHex,
      deployment.registrySpendScriptHashHex,
      ...(deployment.priorGenerations ?? []).map((g) => g.plbScriptHashHex),
    ]) {
      creds.add(hash.toLowerCase())
    }
  }
  return creds
}
