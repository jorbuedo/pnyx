/**
 * Recognising a CIP-113 transaction in history.
 *
 * "Smart Contract" is what every script spend falls back to, and it tells a holder nothing about
 * what happened to their money. We know this contract — its credential is in the deployment record
 * we ship — so naming it is honest in a way a generic "known contract" label would not be. Same
 * argument, and the same precedent, as `night-redeem.ts`.
 *
 * **Recognised structurally, not from redeemers.** A transaction touching this deployment has an
 * input or an output at an address whose payment credential is the PLB script. That is visible on
 * the indexed history path, which carries no script detail at all.
 *
 * ⚠️ Deliberately not reading redeemers to say *which* CIP-113 action this was. The ledger sorts
 * withdrawals by reward account and redeemer indices follow that sorted order rather than the
 * builder's, so a naive index-to-meaning map labels the wrong script — measured upstream, where it
 * silently mis-attributed an entire ex-unit measurement. Recognition needs none of that; a claim
 * about *which* action would.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'

/**
 * What a CIP-113 transaction did, where the structure says so unambiguously.
 *
 * `other` is a real answer, not a gap: the protocol has operations this does not enumerate
 * (unfracking, seizure, moderation), and inventing a name for one of those would be worse than
 * naming the protocol and stopping.
 */
export type Cip113Action = 'registry' | 'issue' | 'transfer' | 'other'

/** The credentials and policies that identify one deployment on chain. */
export type Cip113Marks = {
  /** PLB, registry-spend, and any prior-generation PLB. Lowercase. */
  readonly scriptCredentials: ReadonlySet<string>
  /** The PLB specifically — a smart-wallet input is what makes a transfer a transfer. */
  readonly plbScriptHashHex: string | null
  /** `registry_mint`: a mint under this policy is a registration, not a token. */
  readonly registryPolicyHex: string | null
}

/**
 * Whether this transaction touches the deployment's smart wallets.
 *
 * `credentials` is empty when no CIP-113 deployment is shipped for the active network, which is the
 * normal case for most networks. An empty set matches nothing, so the label simply does not appear.
 */
export const isProgrammableTokenTx = (tx: ReviewedTransaction, credentials: ReadonlySet<string>): boolean => {
  if (credentials.size === 0) return false
  const atDeployment = (io: {
    readonly credentials?: {readonly payment?: {readonly hashHex: string; readonly type: string}}
  }) => io.credentials?.payment?.type === 'script' && credentials.has(io.credentials.payment.hashHex.toLowerCase())
  return tx.inputs.some(atDeployment) || tx.outputs.some(atDeployment)
}

const atCredential = (
  io: {readonly credentials?: {readonly payment?: {readonly hashHex: string; readonly type: string}}},
  hashHex: string,
): boolean => io.credentials?.payment?.type === 'script' && io.credentials.payment.hashHex.toLowerCase() === hashHex

/**
 * Which CIP-113 operation this was, from structure alone.
 *
 * The three the protocol's own bootstrap produces are separable without reading a single redeemer,
 * which matters: redeemer indices follow the ledger's *sorted* withdrawal order rather than the
 * builder's, so mapping one to a meaning is how you confidently label the wrong script.
 *
 * - **registry** — a mint under `registry_mint`. Registering a token is minting a node NFT whose
 *   asset name is the token's policy id, so the policy alone identifies it.
 * - **issue** — any other mint landing at a smart wallet. That is a registered token being created
 *   into someone's holdings.
 * - **transfer** — a smart-wallet input and no mint. Nothing is created; something moved.
 *
 * Order matters: an issuance both mints and pays a smart wallet, so `registry` is tested first on
 * its policy and `transfer` last on the absence of a mint.
 */
export const cip113ActionOf = (tx: ReviewedTransaction, marks: Cip113Marks): Cip113Action => {
  const mints = tx.operations.filter((o) => o.kind === 'minting')
  if (marks.registryPolicyHex !== null && mints.some((m) => m.policyIdHex.toLowerCase() === marks.registryPolicyHex)) {
    return 'registry'
  }
  const plb = marks.plbScriptHashHex
  if (plb !== null) {
    if (mints.length > 0 && tx.outputs.some((o) => atCredential(o, plb))) return 'issue'
    if (mints.length === 0 && tx.inputs.some((i) => atCredential(i, plb))) return 'transfer'
  }
  return 'other'
}
