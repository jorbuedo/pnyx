// Workaround for a wallet-sdk fee-balancing bug surfaced live on 2026-07-05.
//
// midnight-node rejects any transaction carrying an EMPTY DustActions section as
// `MalformedError::NotNormalized` — surfaced to clients as `RpcError: 1010: Invalid
// Transaction: Custom error: 117`, and in the node's own log as
// "non-canonical dust actions: empty" followed by "Rejected transaction … from mempool".
//
// The wallet-sdk produces exactly such a transaction whenever the computed fee is zero:
// `feesWithMargin` can legitimately return 0 on an idle chain (the dynamic dust price
// decays between transactions; every landed tx bumps it briefly, which is why a tx built
// right after a confirmed one used to land while the next one was rejected — the failure
// masqueraded as a wallet coin race). With fee 0 the balancer converges on an empty
// recipe, yet still attaches an intent whose DustActions has no spends and no
// registrations. The node toolkit fixed the identical bug by omitting no-op DustActions
// (midnight-node PR #758, node 0.22.x changelog); until the wallet-sdk does the same, we
// normalize the balancing recipe ourselves: a balancing transaction that is a pure dust
// no-op is dropped entirely (a zero-fee transaction needs no fee intent to balance).

type IntentLike = {
  dustActions?: {spends: unknown[]; registrations: unknown[]} | undefined
  guaranteedUnshieldedOffer?: unknown
  fallibleUnshieldedOffer?: unknown
  actions?: unknown[]
}

export type BalancingTxLike = {
  intents?: Map<number, IntentLike> | undefined
  guaranteedOffer?: unknown
  fallibleOffer?: Map<number, unknown> | undefined
}

/**
 * True when a balancing transaction does nothing except carry empty DustActions:
 * no Zswap offers, no unshielded offers, no contract actions, and every intent's
 * DustActions has zero spends and zero registrations. Such a transaction is exactly
 * what the node's NotNormalized check rejects.
 */
export const isNoopDustBalancing = (tx: BalancingTxLike): boolean => {
  if (tx.guaranteedOffer !== undefined) {
    return false
  }
  if (tx.fallibleOffer !== undefined && tx.fallibleOffer.size > 0) {
    return false
  }
  if (!tx.intents || tx.intents.size === 0) {
    return false
  }
  for (const intent of tx.intents.values()) {
    if (intent.guaranteedUnshieldedOffer !== undefined || intent.fallibleUnshieldedOffer !== undefined) {
      return false
    }
    if ((intent.actions?.length ?? 0) > 0) {
      return false
    }
    const dust = intent.dustActions
    if (dust && (dust.spends.length > 0 || dust.registrations.length > 0)) {
      return false
    }
  }
  return true
}

type UnboundRecipe = {
  type?: string
  baseTransaction?: unknown
  balancingTransaction?: unknown
}

/**
 * Wraps a wallet facade's `balanceUnboundTransaction` so that a pure dust no-op
 * balancing transaction is omitted instead of submitted (and rejected 1010/117).
 */
export const patchNoopDustBalancing = (facade: {
  balanceUnboundTransaction(...args: never[]): Promise<unknown>
}): void => {
  const original = facade.balanceUnboundTransaction.bind(facade)
  facade.balanceUnboundTransaction = async (...args: never[]): Promise<unknown> => {
    const recipe = (await original(...args)) as UnboundRecipe
    if (
      recipe?.type === 'UNBOUND_TRANSACTION' &&
      recipe.balancingTransaction !== undefined &&
      isNoopDustBalancing(recipe.balancingTransaction as BalancingTxLike)
    ) {
      return {...recipe, balancingTransaction: undefined}
    }
    return recipe
  }
}
