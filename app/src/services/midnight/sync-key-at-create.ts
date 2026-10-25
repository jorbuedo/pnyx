/**
 * Whether a `createWallet` leg should hand the scheduler this group's DUST sync key.
 *
 * ⚠️ **A wallet group is built one chain at a time.** `onboarding/preparing` calls `createWallet`
 * once per entry in `FUNDS_CHAINS` against the *same* `groupId`, so `group.chains` is partial on
 * every leg but the last. Two things followed from evaluating a per-group question on a per-chain
 * leg, and this module exists so neither can come back:
 *
 * | what went wrong | why |
 * |---|---|
 * | "this software wallet has no Midnight chain" was logged at `error` on **every** creation | true of the Cardano leg, and normal — the group is half-built, not broken |
 * | the DUST sync key was **never** remembered for a new wallet | the registration sat inside the enclave-write guard, which runs once per group *on the first leg* — and the first leg is exactly the one with no Midnight chain. The leg that could remember the key was always the leg that skipped the block |
 *
 * The second one is the expensive half: the cost is the one the original comment named — the wallet
 * keeps no DUST current until someone refreshes it by hand.
 *
 * So the decision is pure and named, the caller does the registration, and "no Midnight chain yet"
 * is a `debug` fact about a leg rather than an `error` about a wallet. The genuine defect — a
 * software wallet that finishes creation having never gained a Midnight chain — is decidable only
 * once the loop is done, so it is asserted there instead.
 *
 * @module
 */

/** Why a leg is not registering a sync key, when it is not. */
export type SyncKeySkip =
  /** No Midnight chain on the group *yet*. The normal state of every leg before the Midnight one. */
  | 'awaiting-midnight-leg'
  /** Midnight is present but this build has no funds network, so a key would be keyed to nothing. */
  | 'no-funds-network'

export type SyncKeyAtCreate = {readonly remember: true} | {readonly remember: false; readonly reason: SyncKeySkip}

/**
 * Decide from what this leg can see.
 *
 * `hasMidnight` is passed in rather than derived here so the chain-id rule keeps exactly one
 * definition (`isMidnightChainId`), and this module stays free of any dependency a test would have
 * to stub.
 */
export const syncKeyAtCreate = (input: {
  readonly hasMidnight: boolean
  readonly fundsNetwork: string | null
}): SyncKeyAtCreate => {
  if (!input.hasMidnight) return {remember: false, reason: 'awaiting-midnight-leg'}
  if (input.fundsNetwork === null) return {remember: false, reason: 'no-funds-network'}
  return {remember: true}
}
