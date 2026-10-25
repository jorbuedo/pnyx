// Balancing a transaction we did not author, without re-signing it.
//
// The wallet SDK's own `balanceTx` (testkit's `MidnightWalletProvider`) is written for the case where
// the wallet balancing a transaction is also the wallet that built it:
//
//   const recipe = await wallet.balanceUnboundTransaction(tx, keys, {ttl})
//   const signed  = await wallet.signRecipe(recipe, sign)      // ← signs the BASE transaction too
//   return wallet.finalizeRecipe(signed)
//
// `signRecipe`'s unbound branch signs `recipe.baseTransaction` — ours to sign when we built it, and
// emphatically not when a *caller* did. `#signTransactionInternal` walks every segment and **appends**
// a signature without checking whether one is already present, so a caller's signed transfer comes back
// with one unshielded input and two signatures, and the node rejects the merged transaction with
// `1010: Custom error: 192` (`InputsSignaturesLengthMismatch`). Measured on preprod 2026-08-20.
//
// The contract-call path never showed this: a device-proven call carries no unshielded offer, so there
// is no input for the extra signature to be counted against. It only surfaces the moment the sponsor is
// asked to pay for a transaction that moves value — which is the whole point of
// `SponsorshipPolicy.fundTransfers`.
//
// So: sign the balancing transaction (ours, and it needs our dust registration signature), and leave the
// base exactly as it arrived. The caller's signature is the only valid one it can carry.
/** How long the balancing transaction stays valid, matching testkit's `ttlOneHour`. */
const BALANCING_TTL_MS = 60 * 60_000

/** The slice of the wallet facade this needs. Structural, because testkit nests an older SDK's types. */
export type ForeignBalancingFacade = {
  balanceUnboundTransaction(
    tx: unknown,
    secretKeys: {shieldedSecretKeys: unknown; dustSecretKey: unknown},
    options: {ttl: Date},
  ): Promise<{baseTransaction: unknown; balancingTransaction?: unknown}>
  /**
   * Signs a whole recipe. Used here only in its `UNPROVEN_TRANSACTION` form — for the *balancing*
   * transaction — because that branch also attaches the dust-registration signature, which a hand-rolled
   * `signUnprovenTransaction` would silently omit.
   */
  signRecipe(
    recipe: {type: 'UNPROVEN_TRANSACTION'; transaction: unknown},
    signSegment: (payload: Uint8Array) => unknown,
  ): Promise<{transaction: unknown}>
  finalizeRecipe(recipe: {
    type: 'UNBOUND_TRANSACTION'
    baseTransaction: unknown
    balancingTransaction?: unknown
  }): Promise<unknown>
}

export type ForeignBalancingWallet = {
  readonly wallet: ForeignBalancingFacade
  readonly zswapSecretKeys: unknown
  readonly dustSecretKey: unknown
  readonly unshieldedKeystore: {signData(payload: Uint8Array): unknown}
}

/**
 * Bind our DUST fee to a caller's proven-unbound transaction and finalize it.
 *
 * Drop-in for `walletProvider.balanceTx` on the sponsor's submit path: same inputs, same finalized
 * output, minus the signature the SDK would have added to the caller's own offer.
 */
export const balanceForeignTx = async (
  wallet: ForeignBalancingWallet,
  unbound: unknown,
  ttl?: Date,
): Promise<unknown> => {
  const facade = wallet.wallet
  const secretKeys = {shieldedSecretKeys: wallet.zswapSecretKeys, dustSecretKey: wallet.dustSecretKey}
  // The SDK reads `ttl` unconditionally (`arg0.getTime`), so omitting it is a TypeError rather than a
  // default — testkit's balanceTx passes an hour out, and this has to match.
  const recipe = await facade.balanceUnboundTransaction(unbound, secretKeys, {
    ttl: ttl ?? new Date(Date.now() + BALANCING_TTL_MS),
  })
  const sign = (payload: Uint8Array) => wallet.unshieldedKeystore.signData(payload)
  // A zero-fee balancing transaction is dropped upstream by `patchNoopDustBalancing`, so `undefined`
  // here is the normal idle-chain case rather than a missing step.
  const balancingTransaction =
    recipe.balancingTransaction === undefined
      ? undefined
      : (await facade.signRecipe({type: 'UNPROVEN_TRANSACTION', transaction: recipe.balancingTransaction}, sign))
          .transaction
  return facade.finalizeRecipe({
    type: 'UNBOUND_TRANSACTION',
    baseTransaction: recipe.baseTransaction,
    ...(balancingTransaction === undefined ? {} : {balancingTransaction}),
  })
}

/** `balanceTx`-shaped wrapper, so it can replace the provider method the submit path calls. */
export const foreignBalancingProvider = (
  wallet: ForeignBalancingWallet,
): {balanceTx(tx: unknown, ttl?: Date): Promise<unknown>} => ({
  balanceTx: (tx, ttl) => balanceForeignTx(wallet, tx, ttl),
})
