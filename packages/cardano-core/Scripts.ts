// Native scripts (multisig / timelocks) as an Effect facade. Byte-identical to
// CSL (harness/witness-differential.mjs; closes G13).

import {Bytes, NativeScripts, ScriptHash} from '@evolution-sdk/evolution'
import {type KeyHashHex, ScriptHex} from '@evolution-sdk/review/Brands'
import {op} from './Op.js'

/**
 * ⚠️ The `make*` combinators take the inner VARIANTS, not the `NativeScript` wrappers a decode
 * returns, so each nested script is unwrapped to `.script` on the way in.
 */
const variants = (scriptHexes: ReadonlyArray<ScriptHex>) => scriptHexes.map((h) => NativeScripts.fromCBORHex(h).script)
const encoded = (script: Parameters<typeof NativeScripts.toCBORHex>[0]) => ScriptHex(NativeScripts.toCBORHex(script))

/** `[0, keyHash]` — a signature by a specific key. */
export const pubkey = (keyHashHex: KeyHashHex) =>
  op('nativeScriptPubkey', () => encoded(NativeScripts.makeScriptPubKey(Bytes.fromHex(keyHashHex))))
/** `[1, [scripts]]` — all sub-scripts required. */
export const all = (scriptHexes: ReadonlyArray<ScriptHex>) =>
  op('nativeScriptAll', () => encoded(NativeScripts.makeScriptAll(variants(scriptHexes))))
/** `[2, [scripts]]` — any one sub-script suffices. */
export const any = (scriptHexes: ReadonlyArray<ScriptHex>) =>
  op('nativeScriptAny', () => encoded(NativeScripts.makeScriptAny(variants(scriptHexes))))
/** `[3, n, [scripts]]` — at least `n` of the sub-scripts. */
export const nOfK = (n: bigint, scriptHexes: ReadonlyArray<ScriptHex>) =>
  op('nativeScriptNOfK', () => encoded(NativeScripts.makeScriptNOfK(n, variants(scriptHexes))))
/** `[4, slot]` — valid from `slot` onward. */
export const invalidBefore = (slot: bigint) =>
  op('nativeScriptInvalidBefore', () => encoded(NativeScripts.makeInvalidBefore(slot)))
/** `[5, slot]` — valid only before `slot`. */
export const invalidHereafter = (slot: bigint) =>
  op('nativeScriptInvalidHereafter', () => encoded(NativeScripts.makeInvalidHereafter(slot)))
/** Policy id / script hash = blake2b224(0x00 || script CBOR). */
export const scriptHash = (scriptHex: ScriptHex) =>
  op('nativeScriptHash', () => ScriptHash.toHex(ScriptHash.fromScript(NativeScripts.fromCBORHex(scriptHex))))
