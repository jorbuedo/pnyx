/**
 * `TxEnvelope` construct / parse / serialize / add-signature / assemble, and the
 * `SignatureStatus` derivation. Signature-status is PURE (witnesses carry their
 * key hash); assembly goes through `Tx.assemble`.
 *
 * @module
 */

import {Tx} from '@pnyx/cardano-core'
import {CARDANO_PROTOCOL_MAGIC, type CardanoChainId, cardanoNetworkOf, normalizeCardanoChainId} from '@pnyx/config'
import {Data, Effect} from 'effect'
import {scriptRequirements} from './native-script'
import type {EnvelopeSigner, EnvelopeWitness, ScriptRole, SignatureStatus, TxEnvelope} from './types'

export class EnvelopeError extends Data.TaggedError('EnvelopeError')<{readonly reason: string}> {}

/**
 * The network id and protocol magic a canonical chain id implies.
 *
 * Deriving in this direction is total, which is why the envelope is built from a chain id
 * rather than from a `(networkId, protocolMagic?)` pair: preprod and preview share network id
 * 0, so the pair could not name a network without the magic — and the previous version
 * defaulted a missing magic to preprod, silently labelling preview transactions as preprod.
 */
export const networkOfChainId = (chainId: CardanoChainId): {networkId: number; protocolMagic: number} => {
  const network = cardanoNetworkOf(chainId)
  return {networkId: network === 'mainnet' ? 1 : 0, protocolMagic: CARDANO_PROTOCOL_MAGIC[network]}
}

/** Mark any signer whose key hash matches a collected witness as signed. */
const reconcileSigners = (
  signers: readonly EnvelopeSigner[],
  witnesses: readonly EnvelopeWitness[],
): readonly EnvelopeSigner[] => {
  const have = new Set(witnesses.map((w) => w.keyHashHex.toLowerCase()))
  return signers.map((s) => (have.has(s.keyHashHex.toLowerCase()) ? {...s, signed: true} : {...s, signed: false}))
}

export const constructEnvelope = (params: {
  readonly kind: TxEnvelope['kind']
  readonly bodyHex: string
  readonly nativeScriptHexes: readonly string[]
  readonly auxHex?: string
  /** Canonical CAIP-2 id; `networkId` and `protocolMagic` are derived from it. */
  readonly chainId: CardanoChainId
  readonly createdBy: string
  readonly createdAt: string
  readonly accountIndex: number
  /**
   * Parallel to `nativeScriptHexes`. A scalar `keyIndex` is accepted as the
   * one-index case so existing callers read the same; omit both only when the
   * indexes are genuinely unknown (an imported bare transaction).
   */
  readonly keyIndexes?: readonly number[]
  readonly keyIndex?: number
  /**
   * Parallel to `nativeScriptHexes`. Omit when every script is a payment script,
   * which keeps an ordinary spend's envelope exactly as co-signers already read it.
   */
  readonly scriptRoles?: readonly ScriptRole[]
  readonly signers: readonly EnvelopeSigner[]
  readonly witnesses?: readonly EnvelopeWitness[]
}): TxEnvelope => {
  const witnesses = params.witnesses ?? []
  const {networkId, protocolMagic} = networkOfChainId(params.chainId)
  const keyIndexes = params.keyIndexes ?? (params.keyIndex === undefined ? undefined : [params.keyIndex])
  // Written only when it says something. All-payment is what an absent field
  // already means, so emitting it would be a new spelling for the old default.
  const roles = params.scriptRoles?.some((r) => r !== 'payment') === true ? params.scriptRoles : undefined
  return {
    version: 1,
    chainId: params.chainId,
    createdAt: params.createdAt,
    createdBy: params.createdBy,
    kind: params.kind,
    bodyHex: params.bodyHex,
    nativeScriptHexes: params.nativeScriptHexes,
    ...(roles === undefined ? {} : {scriptRoles: roles}),
    ...(params.auxHex !== undefined ? {auxHex: params.auxHex} : {}),
    networkId,
    protocolMagic,
    accountIndex: params.accountIndex,
    ...(keyIndexes === undefined ? {} : {keyIndexes}),
    signers: reconcileSigners(params.signers, witnesses),
    witnesses,
  }
}

/** Which script a signer row belongs to; absent means the only script there is. */
export const scriptIndexOf = (signer: EnvelopeSigner): number => signer.scriptIndex ?? 0

/**
 * What the script at `scriptIndex` guards.
 *
 * Absent `scriptRoles` means every script is a payment script — the whole set of
 * envelopes written before a shared wallet could stake — so an out-of-range or
 * missing entry reads as `'payment'` rather than throwing. That default is safe
 * in the direction that matters: it can only make us derive a payment path for a
 * script that never asked for a stake one, which no existing envelope contains.
 */
export const scriptRoleAt = (envelope: TxEnvelope, scriptIndex: number): ScriptRole =>
  envelope.scriptRoles?.[scriptIndex] ?? 'payment'

/**
 * The payment indexes this envelope can be signed at, or `null` when the file did
 * not say.
 *
 * `null` is not "index 0" — it is "do not offer to sign", and the two must not
 * collapse: a witness made at the wrong index does not count toward the quorum and
 * nothing downstream would object.
 */
export const keyIndexesOf = (envelope: TxEnvelope): readonly number[] | null => {
  const indexes = envelope.keyIndexes
  if (indexes === undefined || indexes.length === 0) return null
  return indexes.length === envelope.nativeScriptHexes.length ? indexes : null
}

/** Append a witness (deduped by vkey) and re-mark signers. Pure. */
export const addSignature = (envelope: TxEnvelope, witness: EnvelopeWitness): TxEnvelope => {
  if (envelope.witnesses.some((w) => w.vkeyHex.toLowerCase() === witness.vkeyHex.toLowerCase())) return envelope
  const witnesses = [...envelope.witnesses, witness]
  return {...envelope, witnesses, signers: reconcileSigners(envelope.signers, witnesses)}
}

export const serializeEnvelope = (envelope: TxEnvelope): string => JSON.stringify(envelope, null, 2)

const isEnvelopeShape = (v: unknown): v is Omit<TxEnvelope, 'chainId'> & {chainId: unknown} => {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    o.version === 1 &&
    typeof o.bodyHex === 'string' &&
    Array.isArray(o.nativeScriptHexes) &&
    Array.isArray(o.signers) &&
    Array.isArray(o.witnesses) &&
    Number.isInteger(o.accountIndex) &&
    // Either form of the payment index, or neither — an envelope from another tool
    // carries no derivation at all, and that is a session we can track and
    // assemble but not sign. What must never happen is a *wrong* index, so the
    // shape check does not manufacture one.
    (o.keyIndexes === undefined || (Array.isArray(o.keyIndexes) && o.keyIndexes.every((i) => Number.isInteger(i)))) &&
    (o.keyIndex === undefined || Number.isInteger(o.keyIndex)) &&
    // A role list that does not line up with the scripts is rejected rather than
    // padded: the two are read positionally, and a short one would silently make
    // the last script a payment script — which for a delegation means signing it
    // with the wrong key.
    (o.scriptRoles === undefined ||
      (Array.isArray(o.scriptRoles) &&
        o.scriptRoles.length === o.nativeScriptHexes.length &&
        o.scriptRoles.every((r) => r === 'payment' || r === 'stake'))) &&
    (o.kind === 'multisig' || o.kind === 'multiparty')
  )
}

/**
 * Read a scalar `keyIndex` as the one-index list.
 *
 * A lossless format upgrade rather than a default: the old shape could only ever
 * describe one index, so `[keyIndex]` is exactly what it meant. Applied on ingress
 * so nothing downstream has to know two spellings.
 */
const withKeyIndexes = (parsed: Record<string, unknown> & {keyIndexes?: unknown; keyIndex?: unknown}): void => {
  if (parsed.keyIndexes === undefined && Number.isInteger(parsed.keyIndex)) {
    parsed.keyIndexes = [parsed.keyIndex]
  }
  delete parsed.keyIndex
}

/**
 * Read an envelope, normalizing its chain id to the canonical form.
 *
 * An envelope can come from another tool, so CIP-34 (`cip34:0-1`) is accepted on the way in and
 * stored canonically — one spelling everywhere the app persists or compares. A chain id that is
 * neither form is rejected rather than carried as an opaque string: a mislabelled network is how
 * a preprod transaction gets signed against mainnet keys.
 */
export const parseEnvelope = (text: string): Effect.Effect<TxEnvelope, EnvelopeError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(text)
      if (!isEnvelopeShape(parsed)) throw new Error('not a recognized transaction envelope')
      withKeyIndexes(parsed as Record<string, unknown>)
      if (typeof parsed.chainId !== 'string') throw new Error('envelope carries no chain id')
      const chainId = normalizeCardanoChainId(parsed.chainId)
      if (chainId === null) throw new Error(`unrecognized chain id '${parsed.chainId}'`)
      return {...parsed, chainId} as TxEnvelope
    },
    catch: (e) => new EnvelopeError({reason: e instanceof Error ? e.message : String(e)}),
  })

/**
 * The quorum threshold for {@link statusOf}.
 *
 * Multiparty needs every contributing wallet. Multisig asks the **script**,
 * because the script is what the ledger will check: counting the roster instead
 * assumes every listed co-signer is required, which is right for `all [...]` and
 * wrong for every `at_least n of k` wallet — a 2-of-3 would wait for a third
 * signature that is not coming, and never submit a transaction that was already
 * valid.
 *
 * The roster count remains the fallback for an envelope whose scripts cannot be
 * read, and for a nested multiparty roster whose members are wallets rather than
 * keys.
 */
export const requiredFor = (envelope: TxEnvelope): number => {
  if (envelope.kind === 'multiparty') return envelope.signers.length
  const perScript = scriptRequirements(envelope.nativeScriptHexes)
  // Additive across scripts, because each one guards its own inputs: a 2-of-3
  // spending two payment indexes needs two signatures at each, four in total.
  // Within one script it is that script's own rule, never a sum.
  //
  // `length > 0` is load-bearing — `[].every()` is vacuously true, so an envelope
  // carrying no scripts would report a quorum of zero and read as ready to submit.
  if (perScript.length > 0 && perScript.every((r) => r !== null)) {
    return perScript.reduce((sum, r) => sum + (r ?? 0), 0)
  }
  return envelope.signers.filter((s) => !s.nested).length || envelope.signers.length
}

/**
 * Whether every script's own quorum is met.
 *
 * **Per script, not in aggregate**, and the difference is a transaction that gets
 * submitted and rejected: a 1-of-2 wallet spending indexes 0 and 1 needs one
 * signature at each, so two signatures both taken at index 0 satisfy an aggregate
 * count of two while index 1's inputs are left unauthorised. Counting per script
 * is what the ledger does.
 *
 * Falls back to the aggregate comparison only when a script cannot be read, which
 * is the same condition {@link requiredFor} falls back on.
 */
const meetsQuorumOf = (envelope: TxEnvelope, required: number): boolean => {
  const signed = envelope.signers.filter((s) => s.signed).length
  if (envelope.kind === 'multiparty') return signed >= envelope.signers.length
  const perScript = scriptRequirements(envelope.nativeScriptHexes)
  if (perScript.length === 0 || perScript.some((r) => r === null)) return signed >= required
  return perScript.every((need, scriptIndex) => {
    const have = envelope.signers.filter((s) => s.signed && scriptIndexOf(s) === scriptIndex).length
    return have >= (need ?? 0)
  })
}

/** Quorum status from an envelope. Multisig: signed/required of its co-signers. Multiparty: signed/total of contributing wallets (all required). */
export const statusOf = (envelope: TxEnvelope, required: number): SignatureStatus => {
  const total = envelope.signers.length
  const signed = envelope.signers.filter((s) => s.signed).length
  const req = envelope.kind === 'multiparty' ? total : required
  return {
    kind: envelope.kind,
    required: req,
    total,
    signed,
    meetsQuorum: meetsQuorumOf(envelope, req),
    signers: envelope.signers,
  }
}

/** One co-signer's standing across every index a spend touches. */
export type RosterEntry = {
  readonly id: string
  readonly name: string
  readonly isSelf: boolean
  /** How many of this co-signer's witnesses are in, and how many are owed. */
  readonly signed: number
  readonly owed: number
  readonly nested?: {readonly signed: number; readonly required: number}
}

/**
 * The roster as one row per person, collapsing a co-signer's several indexes into
 * a single entry.
 *
 * A spend across two payment indexes owes two witnesses from each co-signer — but
 * a co-signer contributes both in one ceremony, because the signing service walks
 * every path it is given. So "which index is still outstanding" is not something
 * the user can act on, while "Alice still owes a signature" is. Rendering the raw
 * rows would list the same person twice with nothing to tell the entries apart.
 *
 * Order is first appearance, which is roster order at the first index.
 */
export const rosterByCoSigner = (signers: readonly EnvelopeSigner[]): readonly RosterEntry[] => {
  const byId = new Map<string, RosterEntry>()
  for (const signer of signers) {
    const running = byId.get(signer.id)
    const nested = signer.nested ?? running?.nested
    byId.set(signer.id, {
      id: signer.id,
      name: signer.name,
      isSelf: signer.isSelf === true || running?.isSelf === true,
      signed: (running?.signed ?? 0) + (signer.signed ? 1 : 0),
      owed: (running?.owed ?? 0) + 1,
      ...(nested === undefined ? {} : {nested}),
    })
  }
  return [...byId.values()]
}

/** Assemble the fully/partially-signed transaction from the envelope. */
export const assembleEnvelope = (envelope: TxEnvelope): Effect.Effect<string, EnvelopeError> =>
  Tx.assemble(
    envelope.bodyHex,
    envelope.witnesses.map((w) => ({vkeyHex: w.vkeyHex, sigHex: w.sigHex})),
    {
      nativeScripts: envelope.nativeScriptHexes,
      ...(envelope.auxHex !== undefined ? {auxHex: envelope.auxHex} : {}),
    },
  ).pipe(Effect.mapError((e) => new EnvelopeError({reason: `assemble: ${e.message}`})))
