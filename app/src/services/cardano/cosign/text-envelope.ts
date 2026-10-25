/**
 * The cardano-cli text envelope — the interchange format every other Cardano
 * tool speaks.
 *
 * ```json
 * {"type": "Tx ConwayEra", "description": "Ledger Cddl Format", "cborHex": "84a3…"}
 * ```
 *
 * Our own `TxEnvelope` carries more (the roster, who has signed, the wallet it
 * belongs to) and is what co-signers exchange with each other. This is the
 * lossy, universal form: enough for `cardano-cli transaction sign`, a hardware
 * tool, or another wallet to take part, and enough on the way back in to
 * reconstruct a co-signing session.
 *
 * The types come from cardano-api's `HasTextEnvelope` instances: a `TxBody` is
 * `Unwitnessed Tx <era>`, a full `Tx` is `Tx <era>`, and a single key witness is
 * `TxWitness <era>`. Since cardano-cli 8 the "unwitnessed" form is still a whole
 * transaction with an empty witness set, which is why both round-trip through
 * the same assembly here.
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {logger} from '../../../logger'

/** The era every transaction this app builds belongs to. */
export const ERA = 'ConwayEra'

export const TEXT_ENVELOPE_TX = `Tx ${ERA}`
export const TEXT_ENVELOPE_UNWITNESSED = `Unwitnessed Tx ${ERA}`
export const TEXT_ENVELOPE_WITNESS = `TxWitness ${ERA}`

/**
 * The description cardano-cli writes for CDDL-serialised transactions. Carried
 * verbatim so a file we produce is byte-comparable with one it produces.
 */
export const LEDGER_CDDL = 'Ledger Cddl Format'

export type TextEnvelope = {
  readonly type: string
  readonly description: string
  readonly cborHex: string
}

/** What a text envelope's `type` says it holds. */
export type TextEnvelopeKind = 'tx' | 'witness' | 'unknown'

/**
 * Classify by era-agnostic prefix rather than exact match.
 *
 * A file written for Babbage says `Tx BabbageEra`, and refusing it on the era
 * alone would reject something we can very likely still read — the CBOR shape
 * these two fields select between has not changed. The ledger has the last word
 * on whether the transaction is valid for the current era, and it is a better
 * judge of that than a string comparison here.
 */
export const textEnvelopeKind = (type: string): TextEnvelopeKind => {
  if (type.startsWith('TxWitness ')) return 'witness'
  if (type.startsWith('Tx ') || type.startsWith('Unwitnessed Tx ')) return 'tx'
  return 'unknown'
}

/**
 * Parse a text envelope, or `null` for anything that is not one.
 *
 * `null` rather than a thrown error, because the co-sign screen offers one input
 * for both formats and has to be able to ask "is it this one?" without treating
 * the answer as a failure.
 */
export const parseTextEnvelope = (raw: string): TextEnvelope | null => {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const o = v as Partial<TextEnvelope>
    if (typeof o.type !== 'string' || typeof o.cborHex !== 'string') return null
    if (o.cborHex.length === 0 || o.cborHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(o.cborHex)) return null
    return {type: o.type, description: typeof o.description === 'string' ? o.description : '', cborHex: o.cborHex}
  } catch (e: unknown) {
    // `null` is also every validation return above it, so a file that is not JSON at all and one
    // whose fields are wrong arrive at the caller as the same refusal.
    logger.warn('Text envelope could not be parsed', {origin: 'cosign/text-envelope', error: String(e)})
    return null
  }
}

/** Serialize with the key order and 2-space indent cardano-cli writes. */
export const serializeTextEnvelope = (envelope: TextEnvelope): string =>
  `${JSON.stringify({type: envelope.type, description: envelope.description, cborHex: envelope.cborHex}, null, 2)}\n`

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * One vkey witness as its own text envelope payload: `[0, [vkey, signature]]`.
 *
 * The leading 0 is the witness-set key for vkey witnesses, and cardano-api keeps
 * it when serialising a lone `KeyWitness` — so a witness file we write is one
 * `cardano-cli transaction assemble` will accept.
 */
export const witnessCborHex = (vkeyHex: string, sigHex: string): string => {
  const s = new Cbor.Serializer()
  s.writeArray(Cbor.len(2))
  s.writeUnsignedInteger(0)
  s.writeArray(Cbor.len(2))
  s.writeBytes(hexToBytes(vkeyHex))
  s.writeBytes(hexToBytes(sigHex))
  return bytesToHex(s.finalize())
}

/**
 * Read a witness text envelope's payload back into its vkey and signature.
 *
 * Accepts both the wrapped `[0, [vkey, sig]]` form cardano-api writes and a bare
 * `[vkey, sig]` pair, since the second is what a witness looks like once it is
 * inside a witness set and some tooling exports it that way.
 */
export const witnessFromCborHex = (cborHex: string): {readonly vkeyHex: string; readonly sigHex: string} | null => {
  try {
    const d = Cbor.Deserializer.from(hexToBytes(cborHex))
    const outer = d.array()
    if (outer === 'indefinite' || outer.definite !== 2) return null
    if (d.cborType() === Cbor.CborType.UnsignedInteger) {
      const tag = d.unsignedInteger()
      if (tag !== 0n) return null
      const inner = d.array()
      if (inner === 'indefinite' || inner.definite !== 2) return null
    }
    const vkey = d.bytes()
    const sig = d.bytes()
    if (vkey.length !== 32 || sig.length !== 64) return null
    return {vkeyHex: bytesToHex(vkey), sigHex: bytesToHex(sig)}
  } catch (e: unknown) {
    logger.warn('Witness CBOR could not be decoded', {origin: 'cosign/text-envelope', error: String(e)})
    return null
  }
}
