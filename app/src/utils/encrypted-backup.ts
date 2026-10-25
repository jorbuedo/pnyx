/**
 * Encrypted wallet export/import — the app's adapter over `@evolution-sdk/backup-keys`.
 *
 * ⚠️ **The format lives in the fork, not here.** Argon2id + XChaCha20-Poly1305, the envelope
 * shape, its validation and the `web+cardano://backup` link are all
 * `@evolution-sdk/backup-keys`. This module existed as a second implementation of the same bytes
 * until 2026-10-10; the two agreed on every published vector, so one had to go. What is left here
 * is the three things that are genuinely the app's: a Promise-based surface for the React call
 * sites, an `Error` subclass they already branch on with `instanceof`, and the `@pnyx/links` router
 * for an inbound URI.
 *
 * v1 defines **one** KDF profile (`KDF_V1`, Argon2id m=256 MiB t=3 p=1), and it is both the floor
 * and the ceiling. There is no weaker level: the two-level draft's 64 MiB "Compatible" profile was
 * withdrawn, and `test-vectors.json` carries an explicit rejection for an envelope that names it.
 * ⚠️ A device that cannot allocate 256 MiB therefore cannot export or import a backup at all —
 * that is the format's deliberate trade, not a gap to patch with a fallback. The doc comment this
 * replaced claimed a fallback that the code never implemented.
 *
 * Payload levels (discriminated by `type`):
 *   - `mnemonic`     — BIP-39 entropy (chain-agnostic; seed-phrase wallets).
 *   - `cardano-root` — the 96-byte BIP32-Ed25519 root extended private key (CIP-16), for wallets
 *                      that only have the xpriv and no recovery phrase.
 *
 * The password is hashed as raw UTF-8 bytes exactly as entered — no trimming, no Unicode
 * normalization (see the wallet's password no-trim policy).
 *
 * @module
 */

import {EncryptedExport} from '@evolution-sdk/backup-keys'
import {hex} from '@pnyx/crypto'
import type {BackupUri} from '@pnyx/links'
import {Effect, Either} from 'effect'

export type {Argon2idParams, BackupPayload, EncryptedEnvelope} from '@evolution-sdk/backup-keys/EncryptedExport'
export const KDF_V1 = EncryptedExport.KDF_V1

type Argon2idParams = EncryptedExport.Argon2idParams
type BackupPayload = EncryptedExport.BackupPayload
type EncryptedEnvelope = EncryptedExport.EncryptedEnvelope

export type BackupPayloadType = BackupPayload['type']

export class EncryptedBackupError extends Error {
  readonly _tag = 'EncryptedBackupError' as const
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

const utf8Decoder = new TextDecoder()

/**
 * Run a fork Effect, re-tagging its failure as the error the screens branch on.
 *
 * ⚠️ `Effect.either` then throw, never `Effect.runPromise` on a failing Effect: that rejects with a
 * `FiberFailure` wrapping the cause, so `catch (e) { e instanceof EncryptedBackupError }` — which is
 * how `restore-from-backup` tells a wrong password from a malformed envelope — would be false for
 * every failure.
 */
const run = async <A>(effect: Effect.Effect<A, EncryptedExport.EncryptedExportError>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isLeft(result)) throw new EncryptedBackupError(messageFor(result.left.reason), result.left)
  return result.right
}

const runSync = <A>(effect: Effect.Effect<A, EncryptedExport.EncryptedExportError>): A => {
  const result = Effect.runSync(Effect.either(effect))
  if (Either.isLeft(result)) throw new EncryptedBackupError(messageFor(result.left.reason), result.left)
  return result.right
}

/**
 * The fork's reasons are implementer-facing. Two reach a user who typed something, so those get
 * the app's wording; the rest pass through, because a malformed envelope has nothing better to say.
 */
const messageFor = (reason: string): string =>
  reason === 'password must not be empty'
    ? 'Export password cannot be empty'
    : /invalid tag|invalid MAC|Poly1305|decrypt/i.test(reason)
      ? 'Decryption failed — incorrect password or corrupted backup'
      : reason

/** Encrypt a payload into a v1 envelope, with its canonical JSON and `web+cardano://backup` link. */
export const buildEncryptedBackup = async ({
  payload,
  password,
  params,
}: {
  readonly payload: BackupPayload
  readonly password: string
  /**
   * Force specific Argon2id params. Omit for the v1 profile; tests pass a tiny one to avoid a
   * 256 MiB derivation. An envelope built with anything other than `KDF_V1` is deliberately not
   * importable through {@link parseEncryptedBackup}, so this stays a build-side testing seam.
   */
  readonly params?: Argon2idParams
}): Promise<{readonly envelope: EncryptedEnvelope; readonly json: string; readonly link: string}> =>
  run(EncryptedExport.encrypt(payload, password, params === undefined ? {} : {params}))

/**
 * The canonical `web+cardano://backup?v=1&enc=…` link for an envelope.
 *
 * ⚠️ The fork's builder, not `@pnyx/links`'s. `Authorities.Backup.build` emits the parameters in
 * insertion order (`?enc=…&v=1`), which parses identically but is not the string the published
 * vectors carry; `encrypted-backup-vectors.test.ts` now asserts byte equality against them. The
 * links authority stays the router for an INBOUND URI — it owns the scheme registry, not the
 * format.
 */
export const buildBackupLink = (envelope: EncryptedEnvelope): string => EncryptedExport.buildLink(envelope)

/**
 * Parse a v1 envelope from an already-routed `web+cardano://backup` URI or from a raw JSON string
 * (file import) — a string is read as JSON, not as a URI. Validates structure and the fixed KDF
 * profile; does NOT run the KDF or need the password.
 */
export const parseEncryptedBackup = (input: BackupUri | string): EncryptedEnvelope => {
  if (typeof input === 'string') return runSync(EncryptedExport.parse(input))
  let json: string
  try {
    json = utf8Decoder.decode(b64urlDecode(input.enc))
  } catch (e) {
    throw new EncryptedBackupError('Backup link payload is not valid base64url', e)
  }
  return runSync(EncryptedExport.parse(json))
}

const b64urlDecode = (text: string): Uint8Array => {
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Decrypt an envelope into its payload. Fails closed on a wrong password or any tampering. */
export const decryptEncryptedBackup = async (envelope: EncryptedEnvelope, password: string): Promise<BackupPayload> => {
  if (password.length === 0) throw new EncryptedBackupError('Export password cannot be empty')
  return await run(EncryptedExport.decrypt(envelope, password))
}

/** Convenience: the raw entropy bytes behind a decrypted mnemonic payload's `entropyHex`. */
export const entropyHexToBytes = (entropyHex: string): Uint8Array =>
  Either.getOrThrowWith(hex.decode(entropyHex), (e) => new EncryptedBackupError(e.message))
