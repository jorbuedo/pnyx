/**
 * Direct-message transport: MLS (RFC 9420) via `ts-mls`.
 *
 * Replaced the static-ECDH seal/open that used to live in `dm-crypto.ts` (deleted 2026-07-31) — see
 * `docs/DIRECT_MESSAGES_PLAN.md` → "Transport vetting". MLS gives forward secrecy and
 * post-compromise security from its key schedule, and answers 1:1 and groups with one protocol.
 * What survives from phase 1: the identity here is still derived from `forumRoot` alone, so that
 * remains the only thing a user must back up, and `conversationId` still names a thread.
 *
 * Pure protocol logic — no React, no RN, no network — so it is unit-tested directly.
 *
 * @module
 */

import {ed25519PublicKey, hkdfSha256, randomBytes} from '@pnyx/crypto'
import {Data, Effect} from 'effect'
import type {CiphersuiteImpl} from 'ts-mls'
import {
  type ClientState,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  joinGroup,
  type KeyPackage,
  nobleCryptoProvider,
  type PrivateKeyPackage,
  processPrivateMessage,
} from 'ts-mls'
// Deep import: `defaultClientConfig` is reachable through the package's `./*.js` exports pattern
// but is not re-exported from the barrel (only its type is). Needed by decodeDmState — see there.
import {defaultClientConfig} from 'ts-mls/clientConfig.js'
// Same reason as above: these codecs are reachable through `./*.js` but are not in the barrel.
// The wire boundary is bytes, so a KeyPackage and a RatchetTree must both serialise.
import {decodeKeyPackage, encodeKeyPackage, makeKeyPackageRef} from 'ts-mls/keyPackage.js'
import {decodeRatchetTree, encodeRatchetTree} from 'ts-mls/ratchetTree.js'

/** An MLS operation failed (bad state, decode failure, unsupported capability, …). */
export class DmMlsError extends Data.TaggedError('DmMlsError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * The one ciphersuite we speak. X25519 + AES-128-GCM + SHA-256 + Ed25519 is MLS's mandatory
 * baseline suite, so every conforming implementation interops with us, and it is the suite whose
 * WebCrypto operations `react-native-quick-crypto` actually covers (verified on device — see
 * `docs/DIRECT_MESSAGES_PLAN.md` → tier 4). Do not widen this without re-running that check:
 * a suite is only as portable as the `crypto.subtle` primitives behind it.
 */
export const DM_SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const

/**
 * We pass `nobleCryptoProvider` rather than the default, deliberately.
 *
 * Both providers route the KEM, KDF and HPKE through `@hpke/core` → `crypto.subtle`; the noble one
 * additionally moves the hash and the MLS-layer AEAD onto `@noble/hashes` / `@noble/ciphers`, which
 * we already ship and already test. That is strictly fewer calls into a `subtle` whose own author
 * describes it as "not fully implemented" (`react-native-quick-crypto/src/index.ts:77`), for no
 * bundle cost, since noble is in the graph regardless. It is **not** a WebCrypto-free
 * configuration — `nobleCryptoProvider` re-exports the default KDF and KEM.
 */
const provider = nobleCryptoProvider

let suiteCache: Promise<CiphersuiteImpl> | undefined

/** The ciphersuite implementation, built once — constructing it does async WebCrypto key setup. */
export const dmCiphersuite = (): Effect.Effect<CiphersuiteImpl, DmMlsError> =>
  Effect.tryPromise({
    try: () => {
      suiteCache ??= provider.getCiphersuiteImpl(getCiphersuiteFromName(DM_SUITE))
      return suiteCache
    },
    catch: (cause) => new DmMlsError({message: 'dmCiphersuite: ciphersuite unavailable', cause}),
  })

/**
 * The MLS signature keypair. Its public half is what an identity row publishes as `anchor`, so a
 * peer can check that a claimed KeyPackage really came from us.
 *
 * `signKey = HKDF-SHA256(forumRoot, "pnyx:dm:mls:sig")`, used as an Ed25519 seed.
 * Derived from `forumRoot` for the same reason the phase-1 X25519 key was: `forumRoot` must stay
 * the only thing a user backs up to recover their anonymous identity. Not network-scoped: an
 * identity is not either (see `@pnyx/contract-client/identity`), and this key is the `anchor` a
 * peer checks a KeyPackage against — so scoping it per network would break every DM at the
 * preprod→mainnet migration for no gain.
 *
 * `ts-mls` accepts a 32-byte raw seed here and wraps it into PKCS#8 itself when it goes through
 * WebCrypto (`makeNobleSignatureImpl`), so no ASN.1 handling is needed on our side.
 */
export type MlsIdentity = {
  readonly signKey: Uint8Array
  readonly publicKey: Uint8Array
}

const SIG_INFO: Uint8Array = utf8('pnyx:dm:mls:sig')

export const deriveMlsIdentity = (forumRoot: Uint8Array): Effect.Effect<MlsIdentity, DmMlsError> =>
  Effect.gen(function* () {
    const signKey = yield* hkdfSha256(forumRoot, SIG_INFO, 32).pipe(
      Effect.mapError((cause) => new DmMlsError({message: 'deriveMlsIdentity: HKDF failed', cause})),
    )
    return {signKey, publicKey: ed25519PublicKey(signKey)}
  })

/**
 * A KeyPackage others consume to add us to a group, plus its private half.
 *
 * The credential identity is the sender's `pnyx_id`, so a group's member list is self-describing
 * and every leaf can be checked against that identity's row — see {@link verifyKeyPackageAnchor}.
 */
export type DmKeyPackage = {
  readonly publicPackage: KeyPackage
  readonly privatePackage: PrivateKeyPackage
}

export const makeDmKeyPackage = (
  identity: MlsIdentity,
  pnyxId: string,
  cs: CiphersuiteImpl,
): Effect.Effect<DmKeyPackage, DmMlsError> =>
  Effect.tryPromise({
    try: () =>
      generateKeyPackageWithKey(
        {credentialType: 'basic', identity: utf8(pnyxId)},
        defaultCapabilities(),
        defaultLifetime,
        [],
        {signKey: identity.signKey, publicKey: identity.publicKey},
        cs,
      ),
    catch: (cause) => new DmMlsError({message: 'makeDmKeyPackage: generation failed', cause}),
  })

/**
 * Serialise a KeyPackage pair for local storage, so an arriving Welcome can be joined.
 *
 * Both halves are stored, and both are needed. `joinGroup` wants the **public** package as well as
 * the private one, and a Welcome does not carry it back to us — so keeping only the private half
 * (the obvious shortcut) yields a package that can be claimed and never joined. All three private
 * fields matter too: the init key is what the Welcome is encrypted to.
 *
 * `ts-mls` exports no codec for the private half, so framing is explicit: a 2-byte big-endian length
 * per field, which makes a future field addition fail loudly on decode rather than mis-slice.
 */
export const encodeDmKeyPackageRecord = (pair: DmKeyPackage): Uint8Array => {
  const pkg = pair.privatePackage
  const fields = [encodeKeyPackage(pair.publicPackage), pkg.initPrivateKey, pkg.hpkePrivateKey, pkg.signaturePrivateKey]
  const total = fields.reduce((sum, field) => sum + 2 + field.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const field of fields) {
    out[at] = (field.length >> 8) & 0xff
    out[at + 1] = field.length & 0xff
    out.set(field, at + 2)
    at += 2 + field.length
  }
  return out
}

export const decodeDmKeyPackageRecord = (bytes: Uint8Array): Effect.Effect<DmKeyPackage, DmMlsError> =>
  Effect.try({
    try: () => {
      const fields: Uint8Array[] = []
      let at = 0
      while (at < bytes.length) {
        if (at + 2 > bytes.length) throw new Error('truncated length prefix')
        const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number)
        if (at + 2 + length > bytes.length) throw new Error('truncated field')
        fields.push(bytes.slice(at + 2, at + 2 + length))
        at += 2 + length
      }
      if (fields.length !== 4) throw new Error(`expected 4 fields, got ${fields.length}`)
      const decodedPublic = decodeKeyPackage(fields[0] as Uint8Array, 0)
      if (decodedPublic === undefined) throw new Error('undecodable public key package')
      return {
        publicPackage: decodedPublic[0],
        privatePackage: {
          initPrivateKey: fields[1] as Uint8Array,
          hpkePrivateKey: fields[2] as Uint8Array,
          signaturePrivateKey: fields[3] as Uint8Array,
        },
      }
    },
    catch: (cause) => new DmMlsError({message: 'decodeDmKeyPackageRecord: failed', cause}),
  })

/**
 * The KeyPackage refs a Welcome is addressed to.
 *
 * An inviter seals the group secrets to `makeKeyPackageRef(ourPackage)`, so this is how a recipient
 * works out *which* of its published packages opens a given Welcome. Matching on the ref rather than
 * trying every stored half in turn keeps the join deterministic and cheap.
 */
export const welcomeRecipientRefs = (welcomeBytes: Uint8Array): Effect.Effect<readonly Uint8Array[], DmMlsError> =>
  Effect.try({
    try: () => {
      const decoded = decodeMlsMessage(welcomeBytes, 0)
      const msg = decoded?.[0]
      if (msg === undefined || msg.wireformat !== 'mls_welcome') {
        throw new Error('welcomeRecipientRefs: not a Welcome message')
      }
      return msg.welcome.secrets.map((secret) => secret.newMember)
    },
    catch: (cause) => new DmMlsError({message: 'welcomeRecipientRefs: failed', cause}),
  })

/** Our ref for a KeyPackage — the value an inviter puts in the Welcome. */
export const keyPackageRef = (kp: KeyPackage, cs: CiphersuiteImpl): Effect.Effect<Uint8Array, DmMlsError> =>
  Effect.tryPromise({
    try: () => makeKeyPackageRef(kp, cs.hash),
    catch: (cause) => new DmMlsError({message: 'keyPackageRef: failed', cause}),
  })

/** Serialise a KeyPackage for publishing to the pool. */
export const encodeMlsKeyPackage = (kp: KeyPackage): Uint8Array => encodeKeyPackage(kp)

/**
 * Parse a KeyPackage claimed from the pool.
 *
 * Parsing proves nothing about who made it — {@link verifyKeyPackageAnchor} is what does, and it
 * must be called before the package is used.
 */
export const decodeMlsKeyPackage = (bytes: Uint8Array): Effect.Effect<KeyPackage, DmMlsError> =>
  Effect.try({
    try: () => {
      const decoded = decodeKeyPackage(bytes, 0)
      if (decoded === undefined) throw new Error('decodeMlsKeyPackage: undecodable key package')
      return decoded[0]
    },
    catch: (cause) => new DmMlsError({message: 'decodeMlsKeyPackage: failed', cause}),
  })

/**
 * Check that a peer's KeyPackage really belongs to the `pnyx_id` it claims.
 *
 * This is what phase 1 could not do at all (`dm-crypto.ts` has no sender authentication). Three
 * bindings must hold, and all three matter:
 *
 * 1. the leaf's signature key equals the `anchor` resolved from the peer's identity row — so the
 *    package was made by whoever controls that anchor;
 * 2. the credential identity equals `pnyxId` — so a valid package for identity A cannot be
 *    replayed as identity B;
 * 3. the caller read `anchor` from the row keyed by `pnyxId`. **This function cannot check 3** — it
 *    never sees the chain. What makes 3 sound is that the circuit authenticated the write: only
 *    `identitySk`'s holder can write row `C`, so the row needs no reader-side signature check.
 *    Callers must resolve the anchor from the row, never from the message.
 */
export const verifyKeyPackageAnchor = (kp: KeyPackage, anchor: Uint8Array, pnyxId: string): boolean => {
  const leafKey = kp.leafNode.signaturePublicKey
  if (leafKey.length !== anchor.length) return false
  let diff = 0
  for (let i = 0; i < anchor.length; i++) diff |= (leafKey[i] as number) ^ (anchor[i] as number)
  if (diff !== 0) return false
  const claimed = kp.leafNode.credential
  if (claimed.credentialType !== 'basic') return false
  return new TextDecoder().decode(claimed.identity) === pnyxId
}

/**
 * A fresh MLS group id.
 *
 * ⚠️ **Random, and deliberately NOT the conversation id.** This used to be `utf8(conversationId)` —
 * a hash of the two `pnyx_id`s, so every group ever built for a pair carried the *same* id. RFC 9420
 * says the opposite: group IDs "SHOULD be constructed in such a way that there is an overwhelmingly
 * low probability of honest group creators generating the same group ID … for example, by making
 * the group ID a freshly generated random value of size KDF.Nh".
 *
 * That is not pedantry. Two independently built groups sharing an id are indistinguishable on the
 * wire, which is how two devices sat in different groups under one conversation and neither could
 * tell — every message simply failed to open, for ever, with no signal. With a random id,
 * {@link dmFrameInfo} can say "this is not my group" from the cleartext framing before any decrypt
 * is attempted, and MLS's own joiner-side uniqueness check starts working for us too.
 *
 * The conversation id keeps its job: addressing the thread on the delivery service, derivable by
 * both sides without a lookup. What it stops being is the group's identity.
 */
export const newDmGroupId = (): Effect.Effect<Uint8Array, DmMlsError> =>
  randomBytes(32).pipe(Effect.mapError((cause) => new DmMlsError({message: 'newDmGroupId: no CSPRNG', cause})))

/**
 * Start a conversation.
 *
 * `groupId` comes from {@link newDmGroupId}. The joiner learns it from the Welcome, so it never has
 * to be sent separately or agreed in advance.
 */
export const createDmGroup = (
  groupId: Uint8Array,
  own: DmKeyPackage,
  cs: CiphersuiteImpl,
): Effect.Effect<ClientState, DmMlsError> =>
  Effect.tryPromise({
    try: () => createGroup(groupId, own.publicPackage, own.privatePackage, [], cs),
    catch: (cause) => new DmMlsError({message: 'createDmGroup: failed', cause}),
  })

/** The group this state belongs to, and how far it has ratcheted. */
export const dmGroupIdOf = (state: ClientState): Uint8Array => state.groupContext.groupId
export const dmEpochOf = (state: ClientState): bigint => state.groupContext.epoch

/**
 * What an inbound frame says about itself, read from the cleartext framing.
 *
 * MLS puts `group_id` and `epoch` outside the encryption precisely so a recipient can route a
 * message to the right group before opening it. That makes "this message is not for the group I
 * hold" a *fact* available without a key, rather than something inferred from a decrypt failure —
 * and a decrypt failure cannot tell a wrong group from a corrupt ciphertext from a lost ratchet.
 *
 * `undefined` when the bytes are not a private message at all.
 */
export const dmFrameInfo = (bytes: Uint8Array): {readonly groupId: Uint8Array; readonly epoch: bigint} | undefined => {
  const decoded = decodeMlsMessage(bytes, 0)
  const msg = decoded?.[0]
  if (msg === undefined || msg.wireformat !== 'mls_private_message') return undefined
  return {groupId: msg.privateMessage.groupId, epoch: msg.privateMessage.epoch}
}

/** The result of adding a member: our advanced state, plus the Welcome to hand to the invitee. */
export type DmInvite = {
  readonly state: ClientState
  readonly welcome: Uint8Array
  /** Serialised — the joiner receives it over the wire alongside the Welcome. */
  readonly ratchetTree: Uint8Array
}

/**
 * Add a peer and produce their Welcome. The commit is applied to our state immediately, so the
 * caller must persist the returned state before delivering the Welcome — dropping it after the
 * peer joins would desynchronise the group.
 */
export const addDmMember = (
  state: ClientState,
  peer: KeyPackage,
  cs: CiphersuiteImpl,
): Effect.Effect<DmInvite, DmMlsError> =>
  Effect.tryPromise({
    try: async () => {
      const commit = await createCommit(
        {state, cipherSuite: cs},
        {extraProposals: [{proposalType: 'add', add: {keyPackage: peer}}]},
      )
      if (commit.welcome === undefined) {
        throw new Error('addDmMember: commit produced no welcome')
      }
      return {
        state: commit.newState,
        welcome: encodeMlsMessage({wireformat: 'mls_welcome', welcome: commit.welcome, version: 'mls10'}),
        ratchetTree: encodeRatchetTree(commit.newState.ratchetTree),
      }
    },
    catch: (cause) => new DmMlsError({message: 'addDmMember: failed', cause}),
  })

/** Join from a Welcome. `ratchetTree` comes from the inviter alongside the Welcome. */
export const joinDmGroup = (
  welcomeBytes: Uint8Array,
  own: DmKeyPackage,
  ratchetTreeBytes: Uint8Array,
  cs: CiphersuiteImpl,
): Effect.Effect<ClientState, DmMlsError> =>
  Effect.tryPromise({
    try: () => {
      const decoded = decodeMlsMessage(welcomeBytes, 0)
      const msg = decoded?.[0]
      if (msg === undefined || msg.wireformat !== 'mls_welcome') {
        throw new Error('joinDmGroup: not a Welcome message')
      }
      const tree = decodeRatchetTree(ratchetTreeBytes, 0)
      if (tree === undefined) {
        throw new Error('joinDmGroup: undecodable ratchet tree')
      }
      return joinGroup(msg.welcome, own.publicPackage, own.privatePackage, emptyPskIndex, cs, tree[0])
    },
    catch: (cause) => new DmMlsError({message: 'joinDmGroup: failed', cause}),
  })

/** Encrypt an application message. Returns our advanced state — persist it or lose the ratchet. */
export type DmSealed = {
  readonly state: ClientState
  readonly message: Uint8Array
}

export const sealDmMessage = (
  state: ClientState,
  plaintext: Uint8Array,
  cs: CiphersuiteImpl,
): Effect.Effect<DmSealed, DmMlsError> =>
  Effect.tryPromise({
    try: async () => {
      const sent = await createApplicationMessage(state, plaintext, cs)
      return {
        state: sent.newState,
        message: encodeMlsMessage({
          wireformat: 'mls_private_message',
          privateMessage: sent.privateMessage,
          version: 'mls10',
        }),
      }
    },
    catch: (cause) => new DmMlsError({message: 'sealDmMessage: failed', cause}),
  })

/**
 * Decrypt an application message.
 *
 * A received frame can also be a *handshake* message (a commit that rotates the group), in which
 * case there is no plaintext and only the state advances — hence `plaintext` is optional rather
 * than the function throwing. Callers must persist `state` in both cases.
 */
export type DmOpened = {
  readonly state: ClientState
  readonly plaintext?: Uint8Array
}

export const openDmMessage = (
  state: ClientState,
  messageBytes: Uint8Array,
  cs: CiphersuiteImpl,
): Effect.Effect<DmOpened, DmMlsError> =>
  Effect.tryPromise({
    try: async () => {
      const decoded = decodeMlsMessage(messageBytes, 0)
      const msg = decoded?.[0]
      if (msg === undefined || msg.wireformat !== 'mls_private_message') {
        throw new Error('openDmMessage: not a private message')
      }
      const result = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, cs)
      return result.kind === 'newState' ? {state: result.newState} : {state: result.newState, plaintext: result.message}
    },
    catch: (cause) => new DmMlsError({message: 'openDmMessage: failed', cause}),
  })

/**
 * Serialise group state for storage. This is **secret material** — it carries the ratchet's private
 * path and the signature private key — so it must be written only to the encrypted store, never to
 * plain MMKV or a log.
 */
export const encodeDmState = (state: ClientState): Uint8Array => encodeGroupState(state)

/**
 * Restore group state, re-attaching the client config.
 *
 * `ClientState` is `GroupState & {clientConfig}` but only the `GroupState` half is serialisable —
 * `clientConfig.authService.validateCredential` is a *function*, so it is behaviour rather than
 * data and cannot round-trip. Casting the decoded value to `ClientState` therefore produces a
 * state that decrypts nothing (caught by the persistence test). The config must be supplied
 * fresh; `createGroup` / `joinGroup` default to the same value, so a restored state and a live one
 * behave identically.
 */
export const decodeDmState = (bytes: Uint8Array): Effect.Effect<ClientState, DmMlsError> =>
  Effect.try({
    try: () => {
      const decoded = decodeGroupState(bytes, 0)
      if (decoded === undefined) throw new Error('decodeDmState: undecodable group state')
      return {...decoded[0], clientConfig: defaultClientConfig}
    },
    catch: (cause) => new DmMlsError({message: 'decodeDmState: failed', cause}),
  })
