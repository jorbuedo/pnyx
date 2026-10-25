/**
 * Which of an agent's requested assets belong to which builder.
 *
 * ⚠️ **A programmable token cannot share a transaction with ordinary assets.** Different inputs (the
 * smart wallet versus the wallet's own UTxOs), a different builder, its own review. So the two agent
 * builders take disjoint baskets, and each must refuse the other's assets *by name* rather than
 * silently sending the half it understands — paying three of the four things asked for, without
 * saying so, is the failure `intents.ts` is named after.
 *
 * Pure: the caller supplies the programmable set, having read it from the smart wallet.
 *
 * @module
 */

/** Lovelace's key in a `ParsedOutput.amounts` map. Never programmable — it funds the fee. */
const LOVELACE = ''

/** Every distinct non-lovelace asset id named across the outputs, in first-seen order. */
export const requestedAssetIds = (
  outputs: readonly {readonly amounts: ReadonlyMap<string, bigint>}[],
): readonly string[] => {
  const seen = new Set<string>()
  for (const output of outputs) {
    for (const [assetId, quantity] of output.amounts) {
      // A zero allocation is not a request. An agent enumerating a basket per recipient writes
      // plenty of them, and refusing a build over one would be refusing something nobody asked for.
      if (assetId !== LOVELACE && quantity > 0n) seen.add(assetId)
    }
  }
  return [...seen]
}

/**
 * The requested assets this builder cannot carry.
 *
 * `programmableIds` is what the account actually holds at its smart wallet. An asset absent from it
 * is treated as ordinary, which is the right default: an id we hold none of is either a token the
 * wallet does not have (the ordinary builder will say so accurately) or one it cannot see, and
 * guessing "programmable" for every unknown id would refuse ordinary sends of ordinary tokens.
 */
export const misroutedAssets = (args: {
  readonly outputs: readonly {readonly amounts: ReadonlyMap<string, bigint>}[]
  readonly programmableIds: ReadonlySet<string>
  /** Which builder is asking. */
  readonly builder: 'ordinary' | 'programmable'
}): readonly string[] =>
  requestedAssetIds(args.outputs).filter((id) =>
    args.builder === 'ordinary' ? args.programmableIds.has(id) : !args.programmableIds.has(id),
  )

/**
 * What to tell an agent that routed assets to the wrong builder.
 *
 * ⚠️ **Names the assets and the tool to use.** The message this replaces was "this wallet does not
 * hold enough for that transfer and its fee" — false for a token the wallet demonstrably holds, and
 * it invited retrying with ever smaller amounts, which can never succeed.
 */
export const misroutedMessage = (assetIds: readonly string[], builder: 'ordinary' | 'programmable'): string => {
  const named = assetIds.join(', ')
  const plural = assetIds.length === 1 ? 'is a' : 'are'
  return builder === 'ordinary'
    ? `${named} ${plural} CIP-113 programmable ${assetIds.length === 1 ? 'token' : 'tokens'}. ` +
        'It is held at this wallet’s smart wallet, not in its own UTxOs, so an ordinary transfer ' +
        'cannot spend it. Send it with cardano_buildProgrammableTransfer, in its own transaction — ' +
        'a programmable token cannot share a transaction with ordinary assets.'
    : `${named} ${plural} not ${assetIds.length === 1 ? 'a ' : ''}programmable ` +
        `${assetIds.length === 1 ? 'token' : 'tokens'} this wallet holds. ` +
        'Send ordinary assets with cardano_buildTransfer — a programmable token cannot share a ' +
        'transaction with them.'
}
