/**
 * Which of this device's wallets can prove a circle's joining requirement, and how a requirement
 * reads to the person choosing.
 *
 * Its own pure module because both answers are decisions worth testing without a picker, a vault or
 * a network — and because the *reason* a wallet is not offerable is the part that has to be said out
 * loud rather than inferred from an absence.
 *
 * @module
 */

import {logger} from '../logger'
import type {InviteRule} from './pnyx-api'

/** How a wallet came to be on this device — only a seed this app holds can sign here. */
export type InviteWalletSource = 'mnemonic' | 'hardware' | 'read-only' | 'imported-xpriv' | 'multisig'

/** Enough of a wallet group to decide whether it can sign, and to name it if it cannot. */
export type WalletForInvite = {
  readonly groupId: string
  readonly name: string
  readonly source: InviteWalletSource
  /** Whether this group holds a Cardano account at all. */
  readonly hasCardano: boolean
  /** Which account of it a signature would come from — its stake key at CIP-1852 role 2. */
  readonly accountIndex: number
  /** `primaryWallet.checksum.seed`, so `WalletRow` draws the blockie this wallet has everywhere else. */
  readonly checksumSeed?: string | undefined
}

export type InviteWalletChoice = {
  readonly groupId: string
  readonly name: string
  readonly accountIndex: number
  readonly checksumSeed?: string | undefined
}

/**
 * The wallets a person may prove a requirement with: a seed this app holds, with a Cardano account.
 *
 * ⚠️ **Everything else is a limitation, not a policy.** Proving a requirement needs the stake
 * *private* key at CIP-1852 role 2. A `hardware` wallet will not export one and CIP-8 message
 * signing on a device is a separate flow with its own review screen; a `read-only` wallet has no key
 * at all; an `imported-xpriv` is an account-level key with no CIP-1852 root to derive role 2 from;
 * and a `multisig` wallet is spent by a script policy rather than by one stake credential. None of
 * them is offered, because offering one and failing at the prompt is worse than not offering it.
 *
 * ⚠️ **What is hidden is counted and returned.** Silently showing a shorter list of "your wallets"
 * leaves someone hunting for the one that is missing; the two counts are kept apart because "your
 * Ledger cannot do this" and "that wallet has no Cardano account" are different things to say.
 */
export const inviteEligibleWallets = (
  wallets: readonly WalletForInvite[],
): {
  readonly eligible: readonly InviteWalletChoice[]
  /** Wallets whose key this app cannot reach — a device, or an xpub it only watches. */
  readonly hiddenNoKey: number
  readonly hiddenNoCardano: number
} => {
  const eligible: InviteWalletChoice[] = []
  let hiddenNoKey = 0
  let hiddenNoCardano = 0
  for (const wallet of wallets) {
    // ⚠️ `mnemonic` only. `hardware` cannot export the stake private key; `read-only` has none;
    // `imported-xpriv` is an account-level key with no CIP-1852 root to derive role 2 from; and a
    // `multisig` wallet is spent by a script policy, not by one stake credential.
    if (wallet.source !== 'mnemonic') {
      hiddenNoKey += 1
      continue
    }
    if (!wallet.hasCardano) {
      hiddenNoCardano += 1
      continue
    }
    eligible.push({
      groupId: wallet.groupId,
      name: wallet.name,
      accountIndex: wallet.accountIndex,
      checksumSeed: wallet.checksumSeed,
    })
  }
  return {eligible, hiddenNoKey, hiddenNoCardano}
}

/** A requirement rendered for the person choosing a wallet, as a key plus its values. */
export type RequirementLine =
  | {readonly kind: 'drep-delegated'; readonly drepId: string}
  | {readonly kind: 'pool-member'; readonly poolId: string}
  | {readonly kind: 'ada-threshold'; readonly ada: string}
  /** A rule this build does not know. Shown as-is rather than dropped — see below. */
  | {readonly kind: 'unknown'; readonly raw: string}

/** Lovelace per ADA. The service stores lovelace; a person reads ADA. */
const LOVELACE = 1_000_000n

/**
 * Turn the stored rules into lines a person can act on.
 *
 * ⚠️ **An unrecognised kind is shown, never dropped.** A build older than the service would
 * otherwise render a *shorter* list of requirements than the circle actually has — so someone would
 * pick a wallet against rules that are not all the rules, be refused, and have no way to see why.
 * Showing the raw kind is ugly and honest; a silent omission is neither.
 */
export const requirementLines = (rules: readonly InviteRule[]): readonly RequirementLine[] =>
  rules.map((rule): RequirementLine => {
    if (rule.kind === 'drep-delegated' && rule.param !== null) return {kind: 'drep-delegated', drepId: rule.param}
    if (rule.kind === 'pool-member' && rule.param !== null) return {kind: 'pool-member', poolId: rule.param}
    if (rule.kind === 'ada-threshold' && rule.param !== null) {
      try {
        return {kind: 'ada-threshold', ada: (BigInt(rule.param) / LOVELACE).toString()}
      } catch (error) {
        // A threshold we cannot read is our bug, and falls through to the raw line rather than
        // rendering as a wrong number — "at least NaN ADA" is worse than an unfamiliar kind. Logged
        // because on screen it is indistinguishable from a rule this build simply does not know.
        logger.warn('a circle stored an unreadable ADA threshold', {
          origin: 'circle-invite-eligibility',
          param: rule.param,
          error: String(error),
        })
        return {kind: 'unknown', raw: rule.kind}
      }
    }
    return {kind: 'unknown', raw: rule.kind}
  })
