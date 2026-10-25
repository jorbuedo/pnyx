/**
 * Validation for `SigningRequest`s read back out of a persisted continuation.
 *
 * A continuation record is plain JSON in ordinary (non-secret) storage, and the
 * resume path used to read `contextData.requests` with a bare
 * `as readonly SigningRequest[]` cast. Anything that could write that key —
 * a schema drift across an app update, or hostile code in our realm (the
 * accepted residual of Phase 16 item 42) — therefore chose bytes that a later
 * resume would hand to the signer.
 *
 * So this module is a **trust boundary**, not a tidy-up: everything here treats
 * stored data as external input. It answers only "is this the shape we wrote?".
 * It cannot answer "did the user consent to these bytes" — that is the
 * reviewed-bytes binding in item 41, and a valid shape must never be mistaken
 * for an authorised payload.
 *
 * A record that fails validation is **dismissible, never signable**: return
 * `null` and let the inbox offer removal, rather than repairing a payload we
 * cannot vouch for.
 *
 * @module
 */

import type {CardanoDataPayload, CardanoTxPayload, SigningRequest} from '@pnyx/signing-service'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Lowercase-or-mixed-case hex of even length. Empty is rejected: no payload we store is zero-length. */
const isHex = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)

const isOptional = <T>(value: unknown, guard: (v: unknown) => v is T): boolean => value === undefined || guard(value)

const isBool = (value: unknown): value is boolean => typeof value === 'boolean'
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isHexArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isHex)
const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString)

/**
 * Witness-set extras are `[key, cbor]` pairs. Validated structurally because
 * dropping them is what made a real mainnet registration fail
 * (`ScriptIntegrityHashMismatch` — the body committed to script data the
 * witness set no longer carried), so a malformed pair must fail loudly here
 * rather than silently assemble a rejectable transaction.
 */
const isWitnessExtra = (value: unknown): value is readonly (readonly [number, string])[] =>
  Array.isArray(value) &&
  value.every((entry) => Array.isArray(entry) && entry.length === 2 && isNumber(entry[0]) && isHex(entry[1]))

const isCardanoTxPayload = (value: Record<string, unknown>): value is CardanoTxPayload =>
  isHex(value.bodyHex) &&
  isNumber(value.networkId) &&
  isOptional(value.protocolMagic, isNumber) &&
  isOptional(value.signOnly, isBool) &&
  isOptional(value.partial, isBool) &&
  isOptional(value.nativeScripts, isHexArray) &&
  isOptional(value.witnessExtra, isWitnessExtra) &&
  isOptional(value.auxHex, isHex) &&
  isOptional(value.precomputedSigningPaths, isStringArray) &&
  isOptional(value.precomputedRequiredKeyHashes, isStringArray)

const isCardanoDataPayload = (value: Record<string, unknown>): value is CardanoDataPayload =>
  isHex(value.addressHex) &&
  isHex(value.payloadHex) &&
  isString(value.signingPath) &&
  value.signingPath.length > 0 &&
  isNumber(value.networkId) &&
  isOptional(value.protocolMagic, isNumber)

/**
 * Narrow one stored entry to a `SigningRequest`, or `null`.
 *
 * `cip36Registration` and `hardwareAddressParams` are deliberately **not**
 * accepted: no producer stores a multi-leg continuation carrying them, so
 * admitting them here would widen the boundary past anything we actually write.
 */
export const parseStoredSigningRequest = (value: unknown): SigningRequest | null => {
  if (!isRecord(value)) return null
  if (typeof value.groupId !== 'string' || value.groupId.length === 0) return null
  if (!isRecord(value.payload)) return null
  if (value.payload.cip36Registration !== undefined || value.payload.hardwareAddressParams !== undefined) return null

  const payload = value.payload
  const ok =
    payload._tag === 'CardanoTx'
      ? isCardanoTxPayload(payload)
      : payload._tag === 'CardanoData'
        ? isCardanoDataPayload(payload)
        : false
  return ok ? (value as SigningRequest) : null
}

/**
 * Narrow the whole stored array, **all-or-nothing**.
 *
 * Partial acceptance would be the dangerous behaviour: dropping an invalid leg
 * from a chained sequence leaves a shorter ceremony that still looks complete,
 * and the surviving legs may depend on outputs the dropped one would have
 * created. One bad entry invalidates the record.
 */
export const parseStoredSigningRequests = (value: unknown): readonly SigningRequest[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  const parsed = value.map(parseStoredSigningRequest)
  return parsed.every((entry): entry is SigningRequest => entry !== null) ? (parsed as SigningRequest[]) : null
}
