/**
 * Find an account's cNIGHT→DUST registrations by replaying its **already-synced** Cardano
 * transaction history. No extra chain read, no explorer, no backend.
 *
 * On-chain uniqueness is genuinely hard — Proposal 0018 dropped the distributed-set design
 * that would have enforced one registration per wallet, so the chain permits many and the
 * observability layer then treats a multiply-registered key as **unregistered**. Answering
 * it for *our own* account, though, is simple, because we already sync that account's
 * transactions: a registration is a UTxO at the mapping validator carrying the auth token,
 * and its whole lifecycle is visible in those transactions.
 *
 * - **register / modify** → a transaction with an *output* carrying the auth token
 *   (a modify spends the old registration and creates a new one in the same transaction);
 * - **modify / deregister** → a transaction whose *input* spends a prior auth-token output.
 *
 * So the active registrations are the auth-token outputs no later transaction has spent.
 *
 * The property that makes this authoritative rather than merely a record of our own
 * actions: **transaction history is chain-derived and account sync is keyed by the stake
 * address**, so this sees registrations made by any wallet or tool for this stake key —
 * Lace included. That is precisely what is needed to detect the double registration Lace
 * is reported to cause.
 *
 * Pure, over a minimal structural shape, so it is unit-testable and independent of the
 * store's row format.
 *
 * @module
 */

import {decodeDustRegistrationDatum} from './registration-datum'
import type {DustAddrPayload, RegistrationUtxo, StakeKeyHash} from './registration-health'

/**
 * The mapping validator is a multi-purpose script, so its hash *is* the auth-token minting
 * policy id. Verified against the deployed script.
 */
export const DUST_MAPPING_POLICY_ID = '73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5'

/** One token on an indexed input or output. */
export type ScanToken = {readonly policyIdHex: string; readonly assetNameHex: string}

export type ScanIO = {
  readonly tokens?: readonly ScanToken[]
  /** The UTxO's own identity. On an input, the output it spends. */
  readonly outpoint?: {readonly txHash: string; readonly index: number} | undefined
  /** Inline datum (Plutus-data CBOR hex), when the indexer reported one. */
  readonly inlineDatum?: string | undefined
}

export type ScanTx = {
  readonly hash: string
  readonly slot?: number | undefined
  readonly inputs: readonly ScanIO[]
  readonly outputs: readonly ScanIO[]
}

/**
 * The auth token is this policy with an **empty** asset name. A non-empty name under the
 * same policy is some other token and must not match.
 */
export const isDustAuthToken = (token: ScanToken): boolean =>
  token.policyIdHex.toLowerCase() === DUST_MAPPING_POLICY_ID && token.assetNameHex === ''

/** Whether any of these inputs/outputs carries the auth token. */
export const carriesDustAuthToken = (io: readonly ScanIO[]): boolean =>
  io.some((entry) => (entry.tokens ?? []).some(isDustAuthToken))

/**
 * True when this transaction is part of a registration's lifecycle — it created one, or it
 * spent one. Cheap enough to run at projection time so the activity list can label the row
 * without re-parsing anything.
 */
export const isDustRegistrationTx = (tx: ScanTx): boolean =>
  carriesDustAuthToken(tx.outputs) || carriesDustAuthToken(tx.inputs)

const refKey = (txHash: string, index: number): string => `${txHash.toLowerCase()}:${index}`

/**
 * The account's currently-active registrations, newest first.
 *
 * `recordedDustPayload` supplies the destination for a registration this wallet created but
 * whose indexed output carries no inline datum. When neither the datum nor a local record
 * answers it, `dustAddr` is left **undefined** — surfaced as unverified rather than
 * fabricated, because a guessed destination would read as a mismatch and prompt a
 * fee-bearing "fix" for a registration that is fine.
 */
export const activeRegistrations = (
  txs: readonly ScanTx[],
  ownStakeKeyHash: StakeKeyHash,
  recordedDustPayload?: (txHash: string) => DustAddrPayload | undefined,
): readonly RegistrationUtxo[] => {
  const spent = new Set<string>()
  for (const tx of txs) {
    for (const input of tx.inputs) {
      if (input.outpoint === undefined) continue
      if (!(input.tokens ?? []).some(isDustAuthToken)) continue
      spent.add(refKey(input.outpoint.txHash, input.outpoint.index))
    }
  }

  const live: RegistrationUtxo[] = []
  const owner = ownStakeKeyHash.toLowerCase()
  for (const tx of txs) {
    tx.outputs.forEach((out, arrayIndex) => {
      if (!(out.tokens ?? []).some(isDustAuthToken)) return
      // Prefer the reported outpoint; fall back to array position. A synced output does not
      // always carry its own index, which is what broke this detection the first time.
      const index = out.outpoint?.index ?? arrayIndex
      if (spent.has(refKey(tx.hash, index))) return

      const decoded = out.inlineDatum === undefined ? null : decodeDustRegistrationDatum(out.inlineDatum)
      // A registration for a different stake key is not ours, even though the token
      // travelled through a transaction our account took part in.
      if (decoded !== null && decoded.stakeKeyHash.toLowerCase() !== owner) return

      live.push({
        owner,
        dustAddr: decoded?.dustPayload ?? recordedDustPayload?.(tx.hash),
        txSlot: tx.slot ?? 0,
        ref: {txHash: tx.hash, index},
      })
    })
  }
  return live.slice().sort((a, b) => b.txSlot - a.txSlot)
}
