/**
 * Which credential kind signs for a wallet group, from its stored `source`.
 *
 * One definition, because it had drifted into four byte-identical copies
 * (`SendFlowProvider`, `StakeScreen`, `useSwapExecution`, `services/dapp/dapp-signing`).
 * The exported one lived in the dApp module, which a send funnel has no business
 * importing from — hence this neutral home.
 *
 * `null` is a real answer, not a failure: a watch-only or hardware-less group has
 * no signer, and callers must decide what that means rather than defaulting to
 * `'software'` and failing later inside the ceremony.
 *
 * **This is the dispatch point for script wallets.** A CIP-1854 shared wallet is
 * spent by a script, not a key, so it cannot answer `signTx` synchronously — the
 * signatures belong to other people. Every flow that can produce a transaction
 * already routes through here, so branching here is what lets send, stake, swap
 * and the dApp connector all work against a shared wallet without any of them
 * knowing it is one. See CIP-106, which replaces `signTx` with an asynchronous
 * gather for exactly this reason.
 *
 * @module
 */

/**
 * `'script'` is not a credential — it is the absence of one, plus a policy. A
 * caller that receives it must gather signatures rather than produce a signed
 * transaction.
 */
export type SignerKind = 'software' | 'hardware' | 'script'

/** The kinds that hold a credential — what the signing service's ceremony accepts. */
export type KeySignerKind = 'software' | 'hardware'

export const signerKindOf = (source: string | undefined): SignerKind | null =>
  source === 'hardware' ? 'hardware' : source === 'multisig' ? 'script' : source === 'mnemonic' ? 'software' : null

/**
 * True when a signer kind can complete a transaction on its own.
 *
 * A type guard, not a boolean: narrowing to {@link KeySignerKind} is what stops a
 * script wallet reaching a ceremony that would ask for a key it does not have.
 */
export const signsAlone = (kind: SignerKind | null): kind is KeySignerKind => kind === 'software' || kind === 'hardware'
