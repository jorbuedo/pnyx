/**
 * Compress, sign and upload one bug report.
 *
 * ## The signing key is the identity's, not the active wallet's
 *
 * Same key and same derivation as `koios-register` and `steelswap-register`: the identity's
 * CIP-1852 payment key at account 0, external role. That choice is load-bearing rather than
 * conventional — a report must be filable from a read-only or hardware wallet, and those hold
 * no key that could sign anything. Filing a bug is not a wallet operation.
 *
 * ## Why not the session JWT
 *
 * A report is most valuable exactly when the session is broken: a login that fails is a bug
 * worth filing, and requiring a working session would refuse the reports we most need. CIP-8
 * over the body digest authenticates without any server-side state to be broken.
 *
 * ⚠️ **The signature covers a domain-tagged canonical string, not a bare nonce.** The same key
 * signs the Koios and SteelSwap challenges, and the verifier's COSE check does not look at what
 * was signed — so the domain in `signedUploadPayload` is what keeps the three apart. See
 * `packages/crypto/signed-upload.ts`.
 *
 * @module
 */

import {XprvHex} from '@evolution-sdk/review/Brands'
import {Address, Cose, Keys} from '@pnyx/cardano-core'
import {hex as hexCodec, sha256, signedUploadPayload} from '@pnyx/crypto'
import {Effect} from 'effect'
// biome-ignore lint/style/useNodejsImportProtocol: metro.config.js aliases the bare `zlib` specifier to the RN shim; `node:zlib` misses that key and fails to bundle.
import {gzipSync} from 'zlib'
import {logger} from '../../logger'
import {identityPaymentXprv} from '../identity-role-keys'
import {recordInfraSignature} from '../signing-audit'
import {MAX_REPORT_BYTES, type ReportManifest} from './report-bundle'

const ORIGIN = 'bug-report-submit'

/** Must match the Worker's `BUG_REPORT_DOMAIN` exactly. */
export const BUG_REPORT_DOMAIN = 'pnyx-bug-report'

/** The identity account that signs. Account 0, as every other identity-signed rail uses. */
const SIGNING_ACCOUNT = 0

/** Header names the Worker reads the envelope from. */
const HEADERS = {
  signature: 'x-pnyx-report-signature',
  key: 'x-pnyx-report-key',
  address: 'x-pnyx-report-address',
  timestamp: 'x-pnyx-report-timestamp',
  nonce: 'x-pnyx-report-nonce',
  digest: 'x-pnyx-report-digest',
} as const

/** Why a submission could not be made. Each is a distinct message, never one "failed". */
export type SubmitFailure =
  | {readonly kind: 'too-large'; readonly bytes: number}
  | {readonly kind: 'no-identity'}
  | {readonly kind: 'refused'; readonly status: number; readonly reason: string}
  | {readonly kind: 'offline'}

export type SubmitResult =
  | {readonly ok: true; readonly id: string}
  | {readonly ok: false; readonly failure: SubmitFailure}

const toHex = (bytes: Uint8Array): string => hexCodec.encode(bytes)

/**
 * A URL-safe nonce.
 *
 * ⚠️ Must contain no `.` — the canonical string joins its fields with one, and a nonce
 * carrying a separator would let two different field sets produce the same signed string.
 * `randomUUID` is hex-and-hyphens, so it satisfies that by construction; the hyphens are
 * stripped only to keep the header short.
 */
const newNonce = (): string => `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '')

/**
 * Serialise and gzip the manifest.
 *
 * Only the manifest is compressed, and only once. Attachments ride inside it as base64, which
 * gzip recovers the overhead of — but their own bytes are already-compressed images and video,
 * so a second pass over them would burn phone CPU for nothing. One gzip of one JSON document
 * is also what makes a stored report readable with `gunzip`, which matters when the thing you
 * are debugging is the reporting path itself.
 */
export const compressManifest = (manifest: ReportManifest): Uint8Array =>
  new Uint8Array(gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8')))

/**
 * Upload a report. `fetchImpl` is injectable so the caller's tests need no network.
 *
 * Returns a typed failure rather than throwing: every branch here is something the screen has
 * to say out loud, and an exception would flatten "too large" and "you are offline" into one
 * apology.
 */
export const submitBugReport = async (params: {
  readonly manifest: ReportManifest
  readonly serviceUrl: string
  readonly networkId: Address.Network
  readonly fetchImpl?: typeof fetch
  readonly nowMs?: number
}): Promise<SubmitResult> => {
  const body = compressManifest(params.manifest)
  if (body.byteLength > MAX_REPORT_BYTES) {
    logger.warn('bug report is over the size ceiling; not uploading', {
      origin: ORIGIN,
      bytes: body.byteLength,
      ceiling: MAX_REPORT_BYTES,
    })
    return {ok: false, failure: {kind: 'too-large', bytes: body.byteLength}}
  }

  let paymentXprvHex: string
  try {
    paymentXprvHex = (await identityPaymentXprv(SIGNING_ACCOUNT)) as unknown as string
  } catch (error) {
    // A device with no identity key cannot sign, and that is a real state — a wallet restored
    // but not yet signed in. Reported rather than retried.
    logger.warn('no identity key to sign a bug report with', {origin: ORIGIN, error: String(error)})
    return {ok: false, failure: {kind: 'no-identity'}}
  }

  const bodySha256Hex = toHex(sha256(body))
  const fields = {
    domain: BUG_REPORT_DOMAIN,
    timestampMs: params.nowMs ?? Date.now(),
    nonce: newNonce(),
    bodySha256Hex,
  }
  const canonical = signedUploadPayload(fields)

  const signed = await Effect.runPromise(
    Effect.gen(function* () {
      const paymentKeyHashHex = yield* Keys.keyHashOf(XprvHex(paymentXprvHex))
      // Enterprise, matching `steelswap-register`: this address exists to identify a signer, and
      // a stake part it will never delegate with would only be noise in the index.
      const addressHex = Address.enterpriseHex(params.networkId, paymentKeyHashHex)
      const payloadHex = toHex(new TextEncoder().encode(canonical))
      const sig = yield* Cose.signData(XprvHex(paymentXprvHex), addressHex, payloadHex, true)
      return {sig, addressHex, payloadHex}
    }),
  )

  // Recorded next to the signature, like the other infra signers, so the audit trail shows what
  // this key was used for rather than only that it was used.
  void recordInfraSignature({
    purpose: 'bug-report',
    payloadHex: signed.payloadHex,
    signer: signed.addressHex,
    signerKind: 'cardano-address-hex',
  })

  const doFetch = params.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${params.serviceUrl.replace(/\/$/, '')}/bug-report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        [HEADERS.signature]: signed.sig.signature,
        [HEADERS.key]: signed.sig.key,
        [HEADERS.address]: signed.addressHex,
        [HEADERS.timestamp]: String(fields.timestampMs),
        [HEADERS.nonce]: fields.nonce,
        [HEADERS.digest]: bodySha256Hex,
      },
      body: body as unknown as BodyInit,
    })
  } catch (error) {
    // A transport failure is the one case worth retrying later, so it gets its own kind rather
    // than being reported as a refusal the server never made.
    logger.warn('bug report upload could not reach the service', {origin: ORIGIN, error: String(error)})
    return {ok: false, failure: {kind: 'offline'}}
  }

  if (!response.ok) {
    const reason = await response
      .text()
      .then((text) => text.slice(0, 200))
      .catch((error: unknown) => {
        logger.debug('bug report refusal had no readable body', {origin: ORIGIN, error: String(error)})
        return ''
      })
    logger.warn('bug report was refused', {origin: ORIGIN, status: response.status, reason})
    return {ok: false, failure: {kind: 'refused', status: response.status, reason}}
  }

  const id = await response
    .json()
    .then((value) => (typeof value === 'object' && value !== null ? String((value as {id?: unknown}).id ?? '') : ''))
    .catch((error: unknown) => {
      // Accepted is accepted: the server said 202 and the report is stored. A body we cannot
      // parse loses us the id for the log line, not the report.
      logger.warn('bug report was accepted but its id could not be read', {origin: ORIGIN, error: String(error)})
      return ''
    })
  logger.info('bug report uploaded', {origin: ORIGIN, id, bytes: body.byteLength})
  return {ok: true, id}
}
