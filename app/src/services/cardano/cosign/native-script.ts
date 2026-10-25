/**
 * Reading a native script's spending rule back out of its bytes.
 *
 * An envelope carries the compiled scripts, and those bytes are what the ledger
 * will actually check — so they are also the honest answer to "how many
 * signatures does this need". The alternative, counting the roster, silently
 * assumes every listed signer is required: correct for `all [...]`, and wrong
 * for every `at_least n of k` wallet, which would gather forever and never
 * submit because the quorum it was waiting for could not be reached.
 *
 * Reading it from the script also means a co-signer who was handed nothing but
 * the envelope — no roster, no template, no registry entry — reaches the same
 * conclusion as the wallet that built it.
 *
 * This belongs in `@pnyx/cardano-core`'s `Scripts` alongside the constructors
 * if that module ever grows a decoder; it is here because today it only has the
 * write side.
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'
import {logger} from '../../../logger'

/**
 * Native script tags, per the Conway CDDL:
 * `[0, keyhash] | [1, [scripts]] | [2, [scripts]] | [3, n, [scripts]] |
 *  [4, slot] | [5, slot]`.
 */
const TAG_PUBKEY = 0n
const TAG_ALL = 1n
const TAG_ANY = 2n
const TAG_N_OF_K = 3n
const TAG_INVALID_BEFORE = 4n
const TAG_INVALID_HEREAFTER = 5n

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('native script: not hex')
    out[i] = byte
  }
  return out
}

const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const lengthOf = (len: Cbor.Len): number => {
  if (len === 'indefinite') throw new Error('native script: indefinite array')
  return len.definite
}

/**
 * How many distinct signatures a native script needs.
 *
 * Time locks contribute nothing — they constrain *when*, not *who* — so a
 * `from`/`until` wrapper around a 2-of-3 still needs two signatures.
 *
 * A nested script counts as the signatures its own rule needs, so an `all` of
 * two 2-of-3 branches needs four. That over-counts only when the same key
 * appears in both branches, which is a template nobody writes on purpose; the
 * consequence is a fee budgeted for one witness too many, never a transaction
 * submitted short.
 */
export const requiredSignaturesOf = (scriptHex: string): number => {
  const d = Cbor.Deserializer.from(hexToBytes(scriptHex))

  const read = (): number => {
    // The frame's element count is not checked: each branch below consumes
    // exactly its own shape, and the ledger re-parses these bytes anyway.
    lengthOf(d.array())
    const tag = d.unsignedInteger()
    switch (tag) {
      case TAG_PUBKEY:
        d.skipValue()
        return 1
      case TAG_ALL: {
        const n = lengthOf(d.array())
        let total = 0
        for (let i = 0; i < n; i++) total += read()
        return total
      }
      case TAG_ANY: {
        const n = lengthOf(d.array())
        // Any one branch satisfies it, so the cost is the cheapest branch — not
        // the first, which for `any [2-of-3, single-key]` would ask for two
        // signatures where one is enough.
        let cheapest = Number.POSITIVE_INFINITY
        for (let i = 0; i < n; i++) cheapest = Math.min(cheapest, read())
        return n === 0 ? 0 : cheapest
      }
      case TAG_N_OF_K: {
        const n = Number(d.unsignedInteger())
        const k = lengthOf(d.array())
        const costs: number[] = []
        for (let i = 0; i < k; i++) costs.push(read())
        // The n cheapest branches: `at_least 2` of three single keys is two, and
        // stays two however the branches are ordered.
        costs.sort((a, b) => a - b)
        return costs.slice(0, Math.max(0, Math.min(n, k))).reduce((sum, c) => sum + c, 0)
      }
      case TAG_INVALID_BEFORE:
      case TAG_INVALID_HEREAFTER:
        d.skipValue()
        return 0
      default:
        throw new Error(`native script: unknown tag ${tag}`)
    }
  }

  return read()
}

/**
 * Split the witness set's native-script entry into individual scripts.
 *
 * That entry is a *list* — and since Conway a tag-258 set around one — so
 * handing its bytes to a script decoder reads the container, not a script. The
 * tag is optional because it is only mandatory from Conway onward and a
 * transaction built for an earlier era omits it.
 *
 * Each element is returned as its own CBOR, sliced from the source rather than
 * re-encoded: a script's hash is over its exact bytes, so a re-encoding that
 * differed anywhere would produce a script hash that matches no address.
 */
export const splitNativeScriptList = (valueHex: string): readonly string[] => {
  const bytes = hexToBytes(valueHex)
  const d = Cbor.Deserializer.from(bytes)
  if (d.cborType() === Cbor.CborType.Tag) d.tag()
  const count = lengthOf(d.array())
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const start = d.position()
    d.skipValue()
    out.push(bytesToHex(bytes.slice(start, d.position())))
  }
  return out
}

/**
 * Every key hash a native script names, in the order it names them.
 *
 * That order is the only one two parties can agree on without exchanging a
 * roster, so it is what a session reconstructed from a bare transaction file
 * uses to identify its signers. Duplicates are kept: a key appearing in two
 * branches is two leaves as far as the script is concerned.
 */
export const pubkeyLeavesOf = (scriptHex: string): readonly string[] => {
  const d = Cbor.Deserializer.from(hexToBytes(scriptHex))
  const out: string[] = []

  const read = (): void => {
    lengthOf(d.array())
    const tag = d.unsignedInteger()
    switch (tag) {
      case TAG_PUBKEY:
        out.push(bytesToHex(d.bytes()))
        return
      case TAG_ALL:
      case TAG_ANY: {
        const n = lengthOf(d.array())
        for (let i = 0; i < n; i++) read()
        return
      }
      case TAG_N_OF_K: {
        d.unsignedInteger()
        const k = lengthOf(d.array())
        for (let i = 0; i < k; i++) read()
        return
      }
      case TAG_INVALID_BEFORE:
      case TAG_INVALID_HEREAFTER:
        d.skipValue()
        return
      default:
        throw new Error(`native script: unknown tag ${tag}`)
    }
  }

  read()
  return out
}

/**
 * What each script in an envelope demands, positionally — `null` for one that
 * cannot be read.
 *
 * Per script rather than summed, because that is the granularity the quorum has to
 * be judged at: each script guards the inputs at its own payment index, and
 * signatures gathered at one index do nothing for another. The caller sums these
 * for a display total and compares them individually to decide whether the
 * transaction can go.
 *
 * `null` rather than a guess: a wrong number here either blocks a transaction that
 * could have been submitted, or releases one that cannot be, and the caller has a
 * roster count to fall back on knowingly.
 */
export const scriptRequirements = (nativeScriptHexes: readonly string[]): readonly (number | null)[] =>
  nativeScriptHexes.map((hex) => {
    try {
      const required = requiredSignaturesOf(hex)
      return Number.isFinite(required) && required > 0 ? required : null
    } catch (e: unknown) {
      // `null` means "quorum unknown" for this script, which the co-sign panel renders the same
      // as a script whose quorum is genuinely not expressible.
      logger.warn('Native script quorum could not be read', {origin: 'cosign/native-script', error: String(e)})
      return null
    }
  })

/**
 * The quorum a single-script envelope demands, or `null` when it cannot be read.
 *
 * Kept for the one-script case that every caller had before multi-index spends
 * existed; {@link scriptRequirements} is what a multi-script envelope needs.
 */
export const envelopeRequiredSignatures = (nativeScriptHexes: readonly string[]): number | null =>
  nativeScriptHexes.length === 0 ? null : (scriptRequirements(nativeScriptHexes)[0] ?? null)
