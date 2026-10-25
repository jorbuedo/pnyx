/**
 * Reading the proving-provider requests.
 *
 * `getProvingProvider` is the one connector method where the *page* holds the interesting object: the
 * API hands the wallet a `KeyMaterialProvider` and expects a `ProvingProvider` back, and neither can
 * cross a JSON bridge. So the injected provider builds the returned object locally and each of its two
 * methods becomes a wire call — `provingProviderCheck` and `provingProviderProve` — carrying the circuit
 * material it pulled from the dApp's own provider.
 *
 * Everything here is the parsing of those two calls. Hex rather than bytes because that is what the
 * bridge carries; the sizes are the reason `prove` is a separate call from `check` — a ZKIR is
 * kilobytes and a prover key is megabytes, so nothing asks for the second unless it is proving.
 *
 * @module
 */

import {invalidRequest} from '../resolver.js'
import type {WireError} from '../types.js'

/** A `check` request: the circuit, and the preimage to check against it. */
export type ProvingCheckRequest = {
  readonly zkir: Uint8Array
  readonly preimage: Uint8Array
}

/**
 * A `prove` request: the preimage, a digest naming the circuit, and the circuit itself *unless the
 * wallet already has it*.
 *
 * The digest is why the material is optional. A prover key is megabytes, and measured on device the
 * bridge cost 38 s of a 46 s first proof — against 8 s of actual proving. So a page that has already
 * sent a circuit sends only its digest next time, and the wallet answers from the copy it cached. When
 * the wallet does *not* have it, it says so and the page resends with the material; nothing is
 * silently proved against the wrong circuit, because the digest is over the bytes themselves.
 */
export type ProvingProveRequest = {
  /** Hex digest of `zkir ‖ proverKey ‖ verifierKey`, as the wallet keys its cache. */
  readonly digest: string
  readonly zkir?: Uint8Array
  readonly proverKey?: Uint8Array
  readonly verifierKey?: Uint8Array
  readonly preimage: Uint8Array
  /** 32 bytes, little-endian, when the caller is binding several proofs together. */
  readonly bindingInput?: Uint8Array
}

export type ProvingRead<A> = {readonly ok: true; readonly request: A} | {readonly ok: false; readonly error: WireError}

const HEX = /^[0-9a-fA-F]+$/

const decodeHex = (value: unknown, what: string): Uint8Array | string => {
  if (typeof value !== 'string' || value === '') return `${what} is required`
  if (value.length % 2 !== 0 || !HEX.test(value)) return `${what} is not hex`
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const readProvingCheckRequest = (params: unknown): ProvingRead<ProvingCheckRequest> => {
  const args = Array.isArray(params) ? params : []
  const zkir = decodeHex(args[0], 'the circuit ZKIR')
  if (typeof zkir === 'string') return {ok: false, error: invalidRequest(zkir)}
  const preimage = decodeHex(args[1], 'the proof preimage')
  if (typeof preimage === 'string') return {ok: false, error: invalidRequest(preimage)}
  return {ok: true, request: {zkir, preimage}}
}

const DIGEST = /^[0-9a-f]{16,64}$/

export const readProvingProveRequest = (params: unknown): ProvingRead<ProvingProveRequest> => {
  const args = Array.isArray(params) ? params : []
  const digest = args[0]
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    return {ok: false, error: invalidRequest('a circuit digest is required, as lowercase hex')}
  }
  const preimage = decodeHex(args[1], 'the proof preimage')
  if (typeof preimage === 'string') return {ok: false, error: invalidRequest(preimage)}

  const material: {zkir?: Uint8Array; proverKey?: Uint8Array; verifierKey?: Uint8Array} = {}
  // All three or none. A partial circuit could not be cached and must not look like a cache hit.
  const supplied = [args[2], args[3], args[4]].filter((piece) => typeof piece === 'string' && piece !== '')
  if (supplied.length === 3) {
    const zkir = decodeHex(args[2], 'the circuit ZKIR')
    if (typeof zkir === 'string') return {ok: false, error: invalidRequest(zkir)}
    const proverKey = decodeHex(args[3], 'the prover key')
    if (typeof proverKey === 'string') return {ok: false, error: invalidRequest(proverKey)}
    const verifierKey = decodeHex(args[4], 'the verifier key')
    if (typeof verifierKey === 'string') return {ok: false, error: invalidRequest(verifierKey)}
    material.zkir = zkir
    material.proverKey = proverKey
    material.verifierKey = verifierKey
  } else if (supplied.length !== 0) {
    return {ok: false, error: invalidRequest('send the whole circuit (ZKIR, prover key, verifier key) or none of it')}
  }

  const raw = args[5]
  if (raw === undefined || raw === null || raw === '') {
    return {ok: true, request: {digest, preimage, ...material}}
  }
  const bindingInput = decodeHex(raw, 'the binding input')
  if (typeof bindingInput === 'string') return {ok: false, error: invalidRequest(bindingInput)}
  if (bindingInput.length !== 32) {
    // Padding a short value would prove a statement the caller never chose, and the proof would
    // verify — so the length is a refusal, not a coercion.
    return {ok: false, error: invalidRequest(`a binding input is 32 bytes, got ${bindingInput.length}`)}
  }
  return {ok: true, request: {digest, preimage, bindingInput, ...material}}
}
