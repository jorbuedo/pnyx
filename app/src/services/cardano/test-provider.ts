/**
 * The mock chain a Cardano test configures its rail with.
 *
 * ⚠️ **One fake, not two.** This used to be `mockProvider` plus `ToEvolution`, because a rail
 * required both the wallet-shaped port and Evolution's typed one and a test had to serve both
 * from a single configuration — two independently configured fakes is how a migrated caller ends
 * up reading an empty chain while the test set up a funded one, with both halves passing. The
 * rail speaks only `ProviderEffect` now, so the derivation is gone and this is Evolution's own
 * `MockProvider` under a name the app's tests share.
 *
 * ⚠️ **A member exists only where the config seeds it.** That is deliberate and load-bearing: a
 * consumer that reports "history unavailable", or refuses a depth it cannot attest, can only be
 * tested against a provider that genuinely cannot answer. A mock that answered everything would
 * make every capability probe look satisfied and the absence handling would never run.
 *
 * It is a ledger rather than a lookup table — `submitTx` computes the real hash, rejects an
 * input it does not hold, and keeps what it consumed — so a build → submit → build sequence
 * sees the chain it just made, and `resolveOutRefs` can tell a spent outpoint from an unknown one.
 *
 * @module
 */

import {
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  Provider as EvolutionProvider,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {MockProvider, type MockProviderConfig} from '@evolution-sdk/evolution/sdk/provider/Mock'
import {Layer} from 'effect'

export type {MockProviderConfig}

/**
 * The mock chain, as a layer.
 *
 * ```ts
 * Effect.provide(Layer.mergeAll(codec, decode, mockChain({utxos})))
 * ```
 */
export const mockChain = (config: MockProviderConfig = {}): Layer.Layer<EvolutionProvider.ProviderEffect> =>
  Layer.succeed(EvolutionProvider.ProviderEffect, new MockProvider(config).effect)

/**
 * One chain UTxO, for seeding {@link mockChain}.
 *
 * ⚠️ Built through Evolution's constructors, not as a hand-written object. The fixtures these
 * replaced were `{txHash, index, coin, assets: []}` literals — a shape the old wallet-shaped port
 * returned, cast into place — and a real `UTxO` carries a DECODED address and a `MultiAsset` map.
 * Which is why those literals could hold `'addr_test1qown'`: nothing parsed them.
 *
 * ⚠️ The mock keys its ledger on each UTxO's own address, so a test seeds ONE flat array rather
 * than a per-address map, and an address it never funded simply holds nothing.
 */
export const chainUtxo = (spec: {
  readonly address: string
  /** Any hex; repeated to 32 bytes when short, so `'11'` reads as `'11'.repeat(32)`. */
  readonly txHash: string
  readonly index?: number
  readonly lovelace: bigint
  /** `[policyHex, assetNameHex, quantity]` triples. */
  readonly assets?: readonly (readonly [string, string, bigint])[]
}): EvolutionUTxO.UTxO =>
  new EvolutionUTxO.UTxO({
    transactionId: TransactionHash.fromHex(
      spec.txHash.length === 64 ? spec.txHash : spec.txHash.repeat(Math.ceil(64 / spec.txHash.length)).slice(0, 64),
    ),
    index: BigInt(spec.index ?? 0),
    address: EvolutionAddress.fromBech32(spec.address),
    assets: (spec.assets ?? []).reduce(
      (acc, [policy, name, quantity]) => EvolutionAssets.addByHex(acc, policy, name, quantity),
      EvolutionAssets.fromLovelace(spec.lovelace),
    ),
  })
