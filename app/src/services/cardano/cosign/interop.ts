/**
 * Moving a co-signing session between our envelope and the cardano-cli text
 * envelope every other Cardano tool speaks.
 *
 * Out: the transaction as it stands, witnesses and all, so a co-signer can
 * finish it with `cardano-cli transaction sign` or a hardware tool — and each
 * collected witness on its own, which is what `cardano-cli transaction assemble`
 * takes.
 *
 * In: a transaction file becomes a co-signing session with no help from us. The
 * roster is not in the file, so it is reconstructed from the native script the
 * transaction carries: the key hashes it names *are* the signers, the quorum is
 * what the script requires, and a witness already present is matched to its
 * signer by key hash. Names are the one thing that cannot be recovered — nobody
 * wrote them down — so the rows are labelled by key hash and say so rather than
 * inventing people.
 *
 * The forms are computed, never stored alongside the envelope. Two copies of the
 * same transaction in one file is two things that can disagree, and the one that
 * disagrees silently would be the one a co-signer signs.
 *
 * @module
 */

import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Keys, Tx} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {type CardanoChainId, cardanoNetworkOf} from '@pnyx/config'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {addSignature, networkOfChainId} from './envelope'
import {pubkeyLeavesOf, requiredSignaturesOf, splitNativeScriptList} from './native-script'
import {
  LEDGER_CDDL,
  parseTextEnvelope,
  TEXT_ENVELOPE_TX,
  TEXT_ENVELOPE_UNWITNESSED,
  TEXT_ENVELOPE_WITNESS,
  type TextEnvelope,
  textEnvelopeKind,
  witnessCborHex,
  witnessFromCborHex,
} from './text-envelope'
import type {EnvelopeSigner, TxEnvelope} from './types'

/** The witness-set key native scripts live under. */
const NATIVE_SCRIPT_KEY = 1

/**
 * The whole transaction as a text envelope.
 *
 * Typed `Unwitnessed` while no signature has been collected, matching what
 * `cardano-cli transaction build` writes — both are a full transaction with a
 * witness set, so the only difference is the label a reader sees.
 */
export const toTxTextEnvelope = (envelope: TxEnvelope): Effect.Effect<TextEnvelope, CoreError> =>
  Tx.assemble(
    envelope.bodyHex,
    envelope.witnesses.map((w) => ({vkeyHex: w.vkeyHex, sigHex: w.sigHex})),
    {
      nativeScripts: envelope.nativeScriptHexes,
      ...(envelope.auxHex === undefined ? {} : {auxHex: envelope.auxHex}),
    },
  ).pipe(
    Effect.map((cborHex) => ({
      type: envelope.witnesses.length === 0 ? TEXT_ENVELOPE_UNWITNESSED : TEXT_ENVELOPE_TX,
      description: LEDGER_CDDL,
      cborHex,
    })),
  )

/** Each collected witness on its own, in the shape `transaction assemble` takes. */
export const toWitnessTextEnvelopes = (envelope: TxEnvelope): readonly TextEnvelope[] =>
  envelope.witnesses.map((w) => ({
    type: TEXT_ENVELOPE_WITNESS,
    description: '',
    cborHex: witnessCborHex(w.vkeyHex, w.sigHex),
  }))

/**
 * The signer rows a native script implies.
 *
 * Every key the script names is a signer, in the order the script names them —
 * which is the only order anyone can agree on without the roster. A witness
 * already in the transaction marks its signer as signed.
 */
export const signersFromScript = (
  scriptHex: string,
  signedKeyHashes: ReadonlySet<string>,
  /** Which script in the file this is, so the quorum can be judged per script. */
  scriptIndex = 0,
): readonly EnvelopeSigner[] =>
  pubkeyLeavesOf(scriptHex).map((keyHashHex, index) => ({
    // Unique across scripts: two scripts naming the same leaf position are two
    // different keys and two different signatures owed.
    id: scriptIndex === 0 ? `key#${index}` : `key#${scriptIndex}.${index}`,
    // No name to recover — the file never carried one. A truncated key hash is
    // at least something a co-signer can check against their own key.
    name: `${keyHashHex.slice(0, 8)}…${keyHashHex.slice(-4)}`,
    keyHashHex,
    signed: signedKeyHashes.has(keyHashHex.toLowerCase()),
    ...(scriptIndex === 0 ? {} : {scriptIndex}),
  }))

/**
 * Every script's leaves, as one roster.
 *
 * A transaction spending several payment indexes carries a script per index, and
 * every one of them owes its own signatures — reading only the first reported a
 * quorum the ledger would not accept.
 */
export const signersFromScripts = (
  nativeScriptHexes: readonly string[],
  signedKeyHashes: ReadonlySet<string>,
): readonly EnvelopeSigner[] =>
  nativeScriptHexes.flatMap((hex, scriptIndex) => signersFromScript(hex, signedKeyHashes, scriptIndex))

/**
 * The signer rows a **scriptless** transaction's inputs imply.
 *
 * A multiparty transaction carries no script — each party's own key authorises their own
 * inputs — so the roster is the set of payment credentials the inputs sit on. That is not in
 * the file: a body holds outpoints, and an outpoint says nothing about whose coin it is. The
 * caller resolves them against the chain and hands the addresses in.
 *
 * One row per distinct key, because one key owes one witness however many of its coins the
 * transaction spends. Named by truncated key hash for the same reason `signersFromScript`
 * is: the file never carried names, and inventing them would be inventing people.
 *
 * A script payment credential is skipped. It cannot produce a vkey witness, and a body
 * mixing script and key inputs is not something this import can describe — the script side
 * needs the script, which by construction is absent here.
 */
export const signersFromInputAddresses = (
  inputAddressHexes: readonly string[],
  signedKeyHashes: ReadonlySet<string>,
): readonly EnvelopeSigner[] => {
  const seen = new Set<string>()
  const signers: EnvelopeSigner[] = []
  for (const addressHex of inputAddressHexes) {
    let info: ReturnType<typeof Address.inspect>
    try {
      info = Address.inspect(addressHex)
    } catch (e: unknown) {
      logger.debug('Input address could not be inspected; skipping it', {
        origin: 'cosign/interop',
        error: String(e),
      })
      continue
    }
    if (info.paymentCredHex === undefined || info.paymentIsScript === true) continue
    const keyHashHex = info.paymentCredHex.toLowerCase()
    if (seen.has(keyHashHex)) continue
    seen.add(keyHashHex)
    signers.push({
      id: `key#${signers.length}`,
      name: `${keyHashHex.slice(0, 8)}…${keyHashHex.slice(-4)}`,
      keyHashHex,
      signed: signedKeyHashes.has(keyHashHex),
    })
  }
  return signers
}

export class TextEnvelopeImportError extends Error {
  constructor(readonly reason: 'not-a-text-envelope' | 'unsupported-type' | 'no-native-script' | 'undecodable') {
    super(reason)
    this.name = 'TextEnvelopeImportError'
  }
}

/**
 * Turn a cardano-cli transaction file into a co-signing session.
 *
 * Two shapes, and which one it is depends on whether the transaction carries a native
 * script.
 *
 * **With a script** it is a multisig session: the script names the keys, so the roster and
 * the quorum are both readable straight out of the file.
 *
 * **Without one** it is a *multiparty* session — several ordinary wallets each authorising
 * their own inputs — and the roster is the payment credentials those inputs sit on. Which
 * the file does not contain: a body holds outpoints, and an outpoint says nothing about
 * whose coin it is. So `inputAddressHexes` is asked of the caller, which has a chain to
 * resolve them against; without it the import is still refused, because a session that
 * cannot say who has to sign is a screen pretending to track something.
 */
export const envelopeFromTxTextEnvelope = (params: {
  readonly cborHex: string
  readonly chainId: CardanoChainId
  readonly createdBy: string
  readonly createdAt: string
  /**
   * The addresses this body's inputs sit on, resolved against the chain.
   *
   * Only read for a scriptless transaction, and only to name its signers. Coming from the
   * chain rather than from the file matters for the same reason it does in the review: the
   * sender of a transaction must not get to describe the coins it spends.
   */
  readonly inputAddressHexes?: readonly string[]
}): Effect.Effect<TxEnvelope, CborError | CoreError | TextEnvelopeImportError> =>
  Effect.gen(function* () {
    const bodyHex = yield* Inspect.txBodyFromTx(params.cborHex)
    const witnessSetHex = yield* Inspect.witnessSetFromTx(params.cborHex)
    const entries = yield* Inspect.witnessSetEntries(witnessSetHex)
    // The entry is the whole list (a tag-258 set since Conway), not one script.
    const nativeScriptHexes = entries
      .filter(([key]) => key === NATIVE_SCRIPT_KEY)
      .flatMap(([, valueHex]) => splitNativeScriptList(valueHex))
    const scriptless = nativeScriptHexes.length === 0
    if (scriptless && (params.inputAddressHexes === undefined || params.inputAddressHexes.length === 0)) {
      return yield* Effect.fail(new TextEnvelopeImportError('no-native-script'))
    }
    const auxHex = yield* Inspect.auxFromTx(params.cborHex).pipe(Effect.orElseSucceed(() => undefined))
    const vkeys = yield* Inspect.witnessSetVkeys(witnessSetHex).pipe(Effect.orElseSucceed(() => []))
    const witnesses = yield* Effect.forEach(vkeys, (w) =>
      Effect.map(Keys.keyHash(w.vkeyHex), (keyHashHex) => ({vkeyHex: w.vkeyHex, sigHex: w.sigHex, keyHashHex})),
    )
    const {networkId, protocolMagic} = networkOfChainId(params.chainId)
    const signedKeyHashes = new Set(witnesses.map((w) => w.keyHashHex.toLowerCase()))
    return {
      version: 1 as const,
      chainId: params.chainId,
      createdAt: params.createdAt,
      createdBy: params.createdBy,
      kind: scriptless ? ('multiparty' as const) : ('multisig' as const),
      bodyHex,
      nativeScriptHexes,
      ...(auxHex === undefined ? {} : {auxHex}),
      networkId,
      protocolMagic,
      // The file says nothing about derivation, and the addresses cannot reveal
      // it — a script address is a hash. So `keyIndexes` is *absent*, not zero:
      // absent means the screen cannot offer to sign, which is true, while a
      // literal 0 would have sent a co-signer to sign with the wrong key and
      // produce a witness that silently fails to count. `accountIndex` stays 0
      // because it is only ever read alongside a key index.
      //
      // A *scriptless* import needs neither: multiparty signing resolves its paths from the
      // body against the signer's own UTxOs, the way an ordinary send does.
      accountIndex: 0,
      signers: scriptless
        ? signersFromInputAddresses(params.inputAddressHexes ?? [], signedKeyHashes)
        : signersFromScripts(nativeScriptHexes, signedKeyHashes),
      witnesses,
    }
  })

/** Merge a witness text envelope's signature into an envelope we already hold. */
export const addWitnessTextEnvelope = (
  envelope: TxEnvelope,
  cborHex: string,
): Effect.Effect<TxEnvelope, TextEnvelopeImportError | CoreError> =>
  Effect.gen(function* () {
    const parsed = witnessFromCborHex(cborHex)
    if (parsed === null) return yield* Effect.fail(new TextEnvelopeImportError('undecodable'))
    const keyHashHex = yield* Keys.keyHash(parsed.vkeyHex)
    return addSignature(envelope, {...parsed, keyHashHex})
  })

/**
 * What an incoming pasted or imported file is.
 *
 * The co-sign screen takes one input for both formats — a co-signer should not
 * have to know which kind of file they were sent.
 */
export type IncomingCosign =
  | {readonly kind: 'text-envelope-tx'; readonly cborHex: string}
  | {readonly kind: 'text-envelope-witness'; readonly cborHex: string}

/** Classify a text envelope, or `null` when the input is not one at all. */
export const classifyIncoming = (raw: string): IncomingCosign | null => {
  const text = parseTextEnvelope(raw)
  if (text === null) return null
  switch (textEnvelopeKind(text.type)) {
    case 'tx':
      return {kind: 'text-envelope-tx', cborHex: text.cborHex}
    case 'witness':
      return {kind: 'text-envelope-witness', cborHex: text.cborHex}
    default:
      return null
  }
}

/** The quorum a transaction's own script requires, for a session built from a file. */
export const quorumFromScript = (scriptHex: string): number => requiredSignaturesOf(scriptHex)

/** The network a chain id names, for labelling an exported file. */
export const networkNameOf = (chainId: CardanoChainId): string => cardanoNetworkOf(chainId)
