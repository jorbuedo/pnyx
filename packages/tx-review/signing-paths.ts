/**
 * Signing-path resolution: which of the wallet's keys must witness a Cardano tx
 * body, and the full set of required key hashes for coverage checking. This is
 * the pure engine behind the signing-service `CardanoTxContext` port — the app
 * adapter supplies the wallet's key registry and resolved inputs.
 *
 * Required-hash sources: resolved input payment credentials, the explicit
 * `required_signers` body field, certificate/voter credentials (via
 * `Analyze.review`), withdrawal stake credentials, and collateral input
 * credentials. Foreign-input credentials are unknowable without their UTxOs —
 * they are simply absent (a dApp signs those sides itself).
 *
 * **Script inputs contribute nothing on their own.** A script address's payment
 * credential is a script hash, not a key hash, so there is no key to require and
 * the leaves the script actually names are unknowable from the address. A caller
 * spending from a script wallet passes those leaf hashes in `scriptAuthority`;
 * without them a script spend resolves to no signing paths at all and the
 * transaction goes out unsigned.
 *
 * @module
 */

import * as Analyze from '@evolution-sdk/review/Analyze'
import type {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address} from '@pnyx/cardano-core'
import {Data, Effect} from 'effect'
import type {OwnedSigningKey, ResolvedInput} from './types.js'

/**
 * The one script this wallet can witness a spend from, and the key hashes it
 * names.
 *
 * A CIP-1854 shared wallet compiles a *different* script at every payment index,
 * because every co-signer's key differs there — so the leaves that authorise a
 * spend at index 0 authorise nothing at index 3.
 */
export type ScriptSpendAuthority = {
  /** Payment credential (script hash) of the address these leaves guard. */
  readonly scriptHashHex: string
  /** Key hashes the compiled script names. */
  readonly signerKeyHashes: readonly string[]
}

/**
 * The script guarding this wallet's *stake* credential, and the key hashes it
 * names.
 *
 * Separate from {@link ScriptSpendAuthority} because it is required for a
 * different reason and would be dropped if it travelled with them: spend
 * authorities are narrowed to the scripts the transaction's *inputs* draw on,
 * and a stake credential is never an input's payment credential. An entry added
 * to that list would therefore be filtered out, its leaves never required, and
 * the wallet's own stake key would resolve to no signing path — a delegation
 * that gathers its full payment quorum and is still missing the one witness
 * that makes it a delegation.
 */
export type ScriptStakeSpendAuthority = {
  /** Stake credential (script hash) the certificates and withdrawals name. */
  readonly scriptHashHex: string
  /** Key hashes the compiled delegation script names. */
  readonly signerKeyHashes: readonly string[]
}

/**
 * A spend selected the wallet's own UTxOs from a script the caller cannot witness
 * for.
 *
 * Raised rather than signed: a witness set built anyway would satisfy some inputs
 * and silently leave the rest unauthorised — a transaction that gathers its full
 * quorum and is still rejected, with nothing along the way saying why.
 *
 * Note what this no longer means. Spending *several* of the wallet's own indexes
 * in one transaction is fine, and the ordinary way a wallet spends: the caller
 * passes an authority per index and every one of them contributes its leaves. This
 * fires only for a script credential that is in none of them, which is a UTxO the
 * wallet cannot spend at all.
 */
export class ScriptIndexMismatchError extends Data.TaggedError('ScriptIndexMismatchError')<{
  readonly message: string
  /** The scripts the caller can witness for. */
  readonly expectedScriptHashHexes: readonly string[]
  /** Script credentials found on the selected inputs that none of them cover. */
  readonly foreignScriptHashHexes: readonly string[]
}> {}

export type ResolvedSigningPaths = {
  /** BIP-32 paths of owned keys that must sign, deduped, registry order. */
  readonly signingPaths: readonly string[]
  /** Every required key hash this wallet could establish (owned or not). */
  readonly requiredKeyHashes: readonly string[]
}

const inputKey = (txHashHex: string, index: number): string => `${txHashHex.toLowerCase()}#${index}`

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Does this body name `scriptHashHex` as a *stake* credential — a certificate or
 * a withdrawal over it?
 *
 * The one rule for "this transaction needs the delegation script", exported
 * because two places must agree on it and disagreeing is silent: signing decides
 * which keys are asked for, and the co-sign envelope decides which scripts are
 * carried to assembly. An envelope short of a script the signature covered
 * assembles into a transaction the ledger rejects, after the whole quorum has
 * already signed.
 *
 * A certificate over the same 28 bytes under a *key* credential is a different
 * account and does not count.
 */
export const bodyNamesStakeScript = (body: Inspect.TxBodyView, scriptHashHex: string): boolean => {
  const wanted = scriptHashHex.toLowerCase()
  return (
    (body.certificates ?? []).some((cert) =>
      Analyze.certificateCredentials(cert).some((cred) => cred.isScript && hex(cred.hash) === wanted),
    ) ||
    (body.withdrawals ?? []).some(
      (withdrawal) => withdrawal.credential.isScript && withdrawal.credential.hashHex.toLowerCase() === wanted,
    )
  )
}

/**
 * Resolve the signing paths + required key hashes for `bodyHex`.
 * `ownedKeys` is the wallet's key registry (payment indexes, stake, DRep…);
 * `resolvedInputs` are the tx inputs found in the wallet's UTxO set.
 *
 * `scriptAuthorities` carries the key hashes a native script names that no address
 * exposes — see the module note — and the script those leaves belong to, one entry
 * per payment index the wallet can witness for. A spend reaching a script that is
 * in none of them is refused. Omitted for an ordinary wallet, where it changes
 * nothing.
 *
 * `stakeAuthority` does the same for the wallet's stake credential, and is read
 * only when the body actually names it — a certificate or a withdrawal. A plain
 * send from the same wallet leaves it untouched, so no useless stake witness is
 * produced.
 */
export const resolveCardanoSigningPaths = (
  bodyHex: string,
  ownedKeys: readonly OwnedSigningKey[],
  resolvedInputs: readonly ResolvedInput[],
  scriptAuthorities?: readonly ScriptSpendAuthority[],
  stakeAuthority?: ScriptStakeSpendAuthority,
): Effect.Effect<ResolvedSigningPaths, CborError | Analyze.DecodeError | ScriptIndexMismatchError, Decode> =>
  Effect.gen(function* () {
    const {body} = yield* Inspect.txBody(bodyHex)
    const analyzed = yield* Analyze.review(bodyHex)

    const required: string[] = []
    const seen = new Set<string>()
    const require = (hashHex: string) => {
      const key = hashHex.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        required.push(key)
      }
    }

    const resolvedByRef = new Map(resolvedInputs.map((r) => [inputKey(r.txHashHex, r.index), r]))
    const authorities = scriptAuthorities ?? []
    const witnessable = new Set(authorities.map((a) => a.scriptHashHex.toLowerCase()))
    // Script credentials on the wallet's own selected inputs that no authority
    // covers. Only ours can appear here at all — `resolvedInputs` is the wallet's
    // UTxO set — so one of these is a UTxO the wallet holds and cannot spend.
    const foreignScripts = new Set<string>()
    /** Which of the wallet's scripts the selection actually draws on. */
    const scriptsInPlay = new Set<string>()
    const inputCred = (refs: readonly Inspect.InputView[] | undefined) => {
      for (const input of refs ?? []) {
        const resolved = resolvedByRef.get(inputKey(input.txHashHex, input.index))
        if (!resolved) continue
        const info = Address.inspect(resolved.addressHex)
        if (info.paymentCredHex === undefined) continue
        if (info.paymentIsScript !== true) {
          require(info.paymentCredHex)
        } else if (authorities.length > 0) {
          const cred = info.paymentCredHex.toLowerCase()
          if (witnessable.has(cred)) scriptsInPlay.add(cred)
          else foreignScripts.add(cred)
        }
      }
    }
    inputCred(body.inputs)
    inputCred(body.collateral?.inputs)
    if (authorities.length > 0 && foreignScripts.size > 0) {
      return yield* Effect.fail(
        new ScriptIndexMismatchError({
          message: `spend selects inputs from ${foreignScripts.size} script(s) this wallet cannot witness for`,
          expectedScriptHashHexes: [...witnessable],
          foreignScriptHashHexes: [...foreignScripts],
        }),
      )
    }

    // Only the leaves of the scripts this spend actually draws on. Requiring every
    // index's leaves would name co-signers for indexes the transaction never
    // touches — signatures the quorum panel would wait for and the ledger would
    // not want. An authority list with nothing selected from it (a build with no
    // resolved script inputs yet) contributes all of them, which is what the
    // single-index callers relied on.
    const contributing =
      scriptsInPlay.size > 0 ? authorities.filter((a) => scriptsInPlay.has(a.scriptHashHex.toLowerCase())) : authorities
    for (const authority of contributing) {
      for (const hashHex of authority.signerKeyHashes) require(hashHex)
    }
    for (const hashHex of body.signers ?? []) require(hashHex)
    for (const signer of analyzed.signers) require(signer.keyHashHex)
    for (const withdrawal of body.withdrawals ?? []) {
      if (!withdrawal.credential.isScript) require(withdrawal.credential.hashHex)
    }

    // A script stake credential names no key, so `Analyze` skips it and the
    // withdrawal loop above skips it — correctly, since the keys that satisfy it
    // are the delegation script's leaves and no part of the body says what they
    // are. Required only when this body names that exact script, so an ordinary
    // spend from the same wallet asks for no stake witness.
    if (stakeAuthority !== undefined && bodyNamesStakeScript(body, stakeAuthority.scriptHashHex)) {
      for (const hashHex of stakeAuthority.signerKeyHashes) require(hashHex)
    }

    const requiredSet = new Set(required)
    const signingPaths: string[] = []
    const pathSeen = new Set<string>()
    for (const owned of ownedKeys) {
      if (requiredSet.has(owned.keyHashHex.toLowerCase()) && !pathSeen.has(owned.path)) {
        pathSeen.add(owned.path)
        signingPaths.push(owned.path)
      }
    }

    return {signingPaths, requiredKeyHashes: required}
  })
