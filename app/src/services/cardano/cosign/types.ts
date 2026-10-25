/**
 * Portable partial-signature transport for multisig + multiparty transactions.
 *
 * A `TxEnvelope` is a shareable, JSON-serializable record of an in-flight tx: the
 * unsigned body + its native scripts + the witnesses collected so far + the
 * signer roster. Co-signers import it, add their witness, and re-export; when
 * the quorum is met anyone can assemble + submit. We carry body/scripts/
 * witnesses SEPARATELY (rather than a partially-signed full-tx CBOR) because
 * assembly is a single `Tx.assemble(body, witnesses, {nativeScripts})` — no need
 * to parse witnesses back out of a full tx.
 *
 * @module
 */

import type {CardanoChainId} from '@pnyx/config'

/** A collected vkey witness + its key hash (precomputed so status checks stay pure). */
export type EnvelopeWitness = {
  readonly vkeyHex: string
  readonly sigHex: string
  readonly keyHashHex: string
}

/** One expected signer: a multisig co-signer, or a contributing wallet in a multiparty tx. */
export type EnvelopeSigner = {
  /**
   * The co-signer this row is for. **Not unique** in a spend touching several
   * payment indexes: one co-signer owes one witness per index, so the same `id`
   * appears once per script. The unique key is (`id`, `scriptIndex`), and
   * `keyHashHex` is unique on its own because a co-signer's key differs at every
   * index.
   */
  readonly id: string
  readonly name: string
  readonly keyHashHex: string
  readonly signed: boolean
  /**
   * Which of `nativeScriptHexes` names this key — so the quorum can be judged per
   * script, which is the only correct way: a 1-of-2 spending two indexes needs one
   * signature *at each*, and two signatures at one index leaves the other
   * unauthorised while an aggregate count reads as satisfied.
   *
   * Absent means script 0, the only script a single-script envelope has. That is
   * the whole legacy set, so reading it as 0 loses nothing.
   */
  readonly scriptIndex?: number
  /** True for the signer that is THIS wallet. */
  readonly isSelf?: boolean
  /**
   * For a multiparty signer that is itself a multisig wallet: its own quorum, so
   * the panel can show "2 of 3 co-signers". Absent for plain key signers.
   */
  readonly nested?: {readonly signed: number; readonly required: number}
}

export type EnvelopeKind = 'multisig' | 'multiparty'

/**
 * What a script in the envelope guards.
 *
 * `'payment'` scripts authorise the inputs, one per index the transaction spends
 * at. A `'stake'` script authorises the *certificates and withdrawals* — a
 * different script over different leaves, since CIP-1854 derives co-signers'
 * stake keys at role 2 rather than role 0. A co-signer who signed a delegation
 * with their payment key would produce a witness the delegation script does not
 * name, which counts toward nothing.
 */
export type ScriptRole = 'payment' | 'stake'

export type TxEnvelope = {
  readonly version: 1
  /**
   * Canonical CAIP-2 chain id (`cardano:mainnet` | `cardano:preprod` | `cardano:preview`).
   * CIP-34 (`cip34:1-764824073`) is accepted when parsing and normalized on ingress.
   */
  readonly chainId: CardanoChainId
  readonly createdAt: string
  readonly createdBy: string
  readonly kind: EnvelopeKind
  readonly bodyHex: string
  /**
   * The native scripts authorising this transaction: one per payment index it
   * spends from, plus the delegation script when it also delegates, deregisters
   * or withdraws. Position is meaning: `keyIndexes[i]` is the index
   * `nativeScriptHexes[i]` was derived at, `scriptRoles[i]` says under which
   * role, and a signer row's `scriptIndex` points in here.
   */
  readonly nativeScriptHexes: readonly string[]
  /**
   * What each script guards, parallel to `nativeScriptHexes`.
   *
   * **Absent means every script is a payment script**, which is the whole set of
   * envelopes written before a shared wallet could stake — so reading it that way
   * loses nothing. Present only when a `'stake'` entry needs saying, which keeps
   * an ordinary spend's envelope byte-identical to what co-signers already parse.
   */
  readonly scriptRoles?: readonly ScriptRole[]
  readonly auxHex?: string
  readonly networkId: number
  readonly protocolMagic?: number
  /** CIP-1854 account index the co-signers' shared keys live under. */
  readonly accountIndex: number
  /**
   * The payment key indexes the spent script addresses were derived at, parallel
   * to `nativeScriptHexes`.
   *
   * Required to sign: a co-signer's key is different at every index, so a signer
   * that assumed index 0 would produce a witness for a key the script does not
   * name — a signature that silently fails to count toward the quorum. Read with
   * `scriptRoles[i]`, which says whether the index is a payment or a stake one;
   * CIP-1854 pins stake at index 0, so a `'stake'` entry always carries 0.
   *
   * **Absent when unknowable**, which is a session reconstructed from a bare
   * cardano-cli transaction: the file says nothing about derivation and a script
   * address is a hash, so there is nothing to read it off. Absent means "we cannot
   * offer to sign this", which is the honest state — the previous shape wrote a
   * literal `0` there and would have signed with the wrong key.
   *
   * A legacy envelope carrying a scalar `keyIndex` is read as `[keyIndex]`.
   */
  readonly keyIndexes?: readonly number[]
  readonly signers: readonly EnvelopeSigner[]
  readonly witnesses: readonly EnvelopeWitness[]
}

/** Required/collected quorum status for the review panel — unifies multisig + multiparty. */
export type SignatureStatus = {
  readonly kind: EnvelopeKind
  readonly required: number
  readonly total: number
  readonly signed: number
  readonly meetsQuorum: boolean
  readonly signers: readonly EnvelopeSigner[]
}
