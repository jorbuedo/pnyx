/**
 * JS surface for the native Midnight key-derivation module (`MidnightNative`).
 *
 * Backed by `libmidnight_native.so` (Rust) on Android via the Kotlin module + JNI bridge. The
 * native boundary uses hex strings (no typed-array marshalling); this layer converts to/from
 * `Uint8Array`. Inputs are 32-byte secp256k1 role keys (derived host-side via wallet-sdk-hd).
 */

import {requireNativeModule} from 'expo-modules-core'
import {
  type CoFundContribution,
  type CoFundShare,
  packCoFundContributions,
  packCoFundShares,
  unpackCoFundShares,
} from './cofunded-wire'
import {packUnshieldedInputs, type UnshieldedSpend} from './unshielded-wire'
import {
  applyTransactionArg,
  coinToWire,
  collapseRangeHex,
  type DustBalance,
  type DustGenerationEntry,
  type DustRegistrationTx,
  type DustUtxo,
  generationToWire,
  type NightSignature,
  parseDecryptedCoin,
  parseDustBalance,
  parseDustRegistration,
  parseDustUtxos,
  parseIdentifiers,
  parseNightSignature,
  parseTxBalance,
  parseWalletSummary,
  registerArg,
  type ShieldedCoin,
  type TxBalanceEntry,
  u64ToLeHex,
  valueToLeHex,
  type WalletSummary,
} from './wallet-wire'

export {
  CONTRIBUTION_HEADER_LEN,
  type CoFundContribution,
  type CoFundShare,
  packCoFundContributions,
  packCoFundShares,
  SHARE_RECORD_LEN,
  unpackCoFundShares,
} from './cofunded-wire'
export type {HandleRecord} from './handle-wire'
export {NIGHT_COLOUR, type TierOffer} from './payment-wire'
export {INPUT_RECORD_LEN, packUnshieldedInputs, type UnshieldedSpend} from './unshielded-wire'

import {type HandleRecord, parseHandleRecord} from './handle-wire'
import {parseTierOffers, type TierOffer} from './payment-wire'

export type {ShieldedCoin, ShieldedCoinAt, WalletSummary} from './wallet-wire'
export {
  type DustBalance,
  type DustGenerationEntry,
  type DustRegistrationTx,
  type DustUtxo,
  deficitsOf,
  parseTxBalance,
  type TxBalanceEntry,
  type TxDeficit,
} from './wallet-wire'

type MidnightNativeSpec = {
  nightPayload(roleKeyHex: string): string
  dustPublicKey(roleKeyHex: string): string
  shieldedPublicKeys(roleKeyHex: string): string
  circuitK(zkirHex: string): number
  proveCircuit(
    zkirPath: string,
    proverKeyPath: string,
    verifierKeyPath: string,
    paramsPath: string,
    preimageHex: string,
  ): Promise<string>
  checkPreimage(zkirHex: string, preimageHex: string): Promise<string>
  provePreimageWithBinding(
    zkirPath: string,
    proverKeyPath: string,
    verifierKeyPath: string,
    paramsPath: string,
    preimageHex: string,
    bindingLeHex: string,
  ): Promise<string>
  /** Android only: false when no `.so` is bundled for this ABI. Absent on iOS (statically linked). */
  isAvailable?(): boolean
  buildPublishRowProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    anchorHex: string
    authPubHex: string
    identitySkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildSetPrimaryNameProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    nameHex: string
    identitySkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildClaimFreePermitProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    tier: number
    recipientHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildBindProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    identitySkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildRebindProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    newOwnerHex: string
    identitySkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  handleAddress(args: {keysDir: string; nameHex: string; paymentHex: string}): Promise<string>
  buildSetInviteProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    personaSkHex: string
    moderatorPathHex: string
    commitmentHex: string
    active: boolean
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildIssueInviteProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    authoritySkHex: string
    commitmentHex: string
    active: boolean
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildSetInviteAuthorityProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    personaSkHex: string
    moderatorPathHex: string
    authorityHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  compactOp(op: string, args: string): string
  buildLeaveCircleProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    personaSkHex: string
    memberPathHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildAddModeratorProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    personaSkHex: string
    moderatorPathHex: string
    targetLeafHex: string
    memberPathHex: string
    authPubHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildCastVoteProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    personaSkHex: string
    ballotOption: number
    ballotRandHex: string
    memberPathHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildRevealVoteProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    personaSkHex: string
    ballotOption: number
    ballotRandHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  proposalAddress(args: {
    keysDir: string
    circleIdHex: string
    membersRootHex: string
    contentHex: string
    authorHex: string
    optionCount: number
  }): Promise<string>
  buildProposalDeployTx(args: {
    keysDir: string
    circleIdHex: string
    membersRootHex: string
    contentHex: string
    authorHex: string
    optionCount: number
    networkId: string
    ttlSecs: number
  }): Promise<string>
  identityAddress(args: {keysDir: string; cHex: string}): Promise<string>
  circleMemberPath(args: {contractStateHex: string; leafHex: string}): Promise<string>
  circleModeratorPath(args: {contractStateHex: string; leafHex: string}): Promise<string>
  circleMembersRoot(args: {contractStateHex: string}): Promise<string>
  circleInviteAuthority(args: {contractStateHex: string}): Promise<string>
  buildIdentityDeployTx(args: {keysDir: string; cHex: string; networkId: string; ttlSecs: number}): Promise<string>
  buildHandleDeployTx(args: {
    keysDir: string
    nameHex: string
    paymentHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildSetRowProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    slot: number
    kind: number
    valueHex: string
    identitySkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildSetRowsProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    slots: readonly number[]
    kinds: readonly number[]
    valuesHex: string
    identitySkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  walletBuildSelfFundedTransfer(args: {
    nightRoleKeyHex: string
    inputsHex: string
    recipientAddressHex: string
    tokenTypeHex: string
    valueLeHex: string
    networkId: string
    ttlSecs: number
    dustStateHex: string
    dustRoleKeyHex: string
    ctimeSecs: number
    artifactDir: string
    paramsDir: string
    feeMargin: number
    changeChunks: number
  }): Promise<string>
  walletPayFeeFromDust(args: {
    transactionHex: string
    dustStateHex: string
    dustRoleKeyHex: string
    ctimeSecs: number
    ttlSecs: number
    artifactDir: string
    paramsDir: string
    feeMargin: number
  }): Promise<string>
  walletBuildCoFundedIntent(args: {
    contributionsHex: string
    recipientAddressHex: string
    tokenTypeHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  walletSignCoFundedShare(args: {intentHex: string; nightRoleKeyHex: string}): Promise<string>
  walletAssembleCoFundedTx(args: {intentHex: string; sharesHex: string; networkId: string}): Promise<string>
  walletBalanceUnsealedTransaction(args: {
    transactionHex: string
    nightRoleKeyHex: string
    inputsHex: string
  }): Promise<string>
  walletStateOp(op: string, stateHex: string, keyHex: string, argHex: string): Promise<string>
  walletReadOp(op: string, stateHex: string, keyHex: string, argHex: string): Promise<string>
  walletBuildTransfer(args: {
    stateHex: string
    zswapRoleKeyHex: string
    recipientCoinPublicKeyHex: string
    recipientEncryptionPublicKeyHex: string
    colorHex: string
    valueLeHex: string
    networkId: string
    ttlSecs: number
    artifactDir: string
    paramsDir: string
  }): Promise<string>
  identityRow(stateHex: string, identityHex: string): Promise<string>
  buildJoinProvenTx(args: {
    zkirPath: string
    proverKeyPath: string
    verifierKeyPath: string
    paramsPath: string
    contractStateHex: string
    contractAddressHex: string
    circleIdHex: string
    inviteSecretHex: string
    identitySkHex: string
    personaSkHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  buildCircleDeployTx(args: {
    keysDir: string
    circleIdHex: string
    isOpen: boolean
    founderHex: string
    founderAuthHex: string
    founderJoinedHex: string
    networkId: string
    ttlSecs: number
  }): Promise<string>
  circleDeployAddress(args: {
    keysDir: string
    circleIdHex: string
    isOpen: boolean
    founderHex: string
    founderAuthHex: string
    founderJoinedHex: string
  }): Promise<string>
  walletBuildUnshieldedTransfer(args: {
    nightRoleKeyHex: string
    inputsHex: string
    recipientAddressHex: string
    tokenTypeHex: string
    valueLeHex: string
    networkId: string
    ttlSecs: number
    changeChunks: number
  }): Promise<string>
}

// Lazy: this package reaches web bundles through the shared @pnyx/wallet
// import graph, where the native module never exists — resolving it at import
// time would crash the whole bundle instead of just on-device operations.
let nativeModule: MidnightNativeSpec | undefined
const native = (): MidnightNativeSpec => {
  nativeModule ??= requireNativeModule<MidnightNativeSpec>('MidnightNative')
  return nativeModule
}

// Hex-encoding a role key manufactures a second, unwipeable copy of secret
// material: Hermes strings are immutable, so unlike the caller's Uint8Array this
// one cannot be zeroed and may be duplicated again by GC compaction. It is a
// known residency site (Phase 16 items 43–44), not an oversight — the native ABI
// below marshals hex, so removing it means changing the Rust JNI entry points,
// the Kotlin module, the iOS C-ABI and this signature together, then rebuilding
// on-device. Do not "fix" it here alone: a bytes-in/hex-out mismatch fails at the
// JNI boundary, which no host test covers.
const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** role-0 key → 32-byte night address payload. */
export const nightPayload = (roleKey: Uint8Array): Uint8Array => fromHex(native().nightPayload(toHex(roleKey)))

/** role-2 key → 32-byte BLS12-381 scalar, little-endian. */
export const dustPublicKeyLE = (roleKey: Uint8Array): Uint8Array => fromHex(native().dustPublicKey(toHex(roleKey)))

/** role-3 key → 64 bytes = coin_public_key(32) ‖ encryption_public_key(32). */
export const shieldedPublicKeys = (roleKey: Uint8Array): Uint8Array =>
  fromHex(native().shieldedPublicKeys(toHex(roleKey)))

/** A circuit's K (log2 rows) from its `.bzkir` — names the SRS to fetch (`bls_midnight_2p<K>`). */
export const circuitK = (zkir: Uint8Array): number => native().circuitK(toHex(zkir))

/** On-device file paths to one circuit's static proving artifacts (compactc outputs + KZG SRS). */
export type CircuitArtifactPaths = {
  /** `managed/zkir/<circuit>.bzkir` — tagged `midnight:ir-source[v2]`. */
  readonly zkirPath: string
  /** `managed/keys/<circuit>.prover` — tagged `midnight:prover-key[v7](ir-source[v2])`. */
  readonly proverKeyPath: string
  /** `managed/keys/<circuit>.verifier` — tagged `midnight:verifier-key[v6]`. */
  readonly verifierKeyPath: string
  /** The KZG SRS for the circuit's K (`bls_midnight_2p<K>`). */
  readonly paramsPath: string
}

/**
 * Prove one circuit invocation natively and verify the result before returning.
 *
 * The static artifacts stay on disk (multi-MB, cached once per circuit); only the per-call
 * proof preimage (the serialized `PreProof` from the compact runtime's circuit execution)
 * crosses the bridge. Resolves to the tagged-serialized proof (`midnight:proof[v5]`).
 * CPU-bound for ~1–3 s at K=14/15 on mobile hardware — runs off the JS thread.
 */
export const proveCircuit = async (paths: CircuitArtifactPaths, preimage: Uint8Array): Promise<Uint8Array> =>
  fromHex(
    await native().proveCircuit(
      paths.zkirPath,
      paths.proverKeyPath,
      paths.verifierKeyPath,
      paths.paramsPath,
      toHex(preimage),
    ),
  )

/**
 * Check a proof preimage against its circuit without proving it.
 *
 * The `check` half of the dApp connector's `ProvingProvider`. Answers the *pi skip sequence* — one
 * entry per public input, `undefined` where nothing is skipped — and needs **only the ZKIR**: no
 * prover key, no verifier key, no SRS. Milliseconds, so a caller can check a circuit it could not
 * afford to prove.
 */
export const checkPreimage = async (zkir: Uint8Array, preimage: Uint8Array): Promise<(number | undefined)[]> => {
  const json = await native().checkPreimage(toHex(zkir), toHex(preimage))
  const parsed = JSON.parse(json) as (number | null)[]
  // `null` is the wire's "nothing skipped here"; the API's shape is `undefined`. They are different
  // absences to a `JSON.parse` and the same one to a caller, so the conversion belongs here.
  return parsed.map((entry) => (entry === null ? undefined : entry))
}

/**
 * Prove one circuit invocation, optionally replacing the preimage's binding input first.
 *
 * The `prove` half of the connector's `ProvingProvider`. `bindingInput` is 32 bytes little-endian and
 * must be a canonical field element — a value that is not is **refused**, never reduced, because a
 * reduced binding input proves a statement the caller did not ask for and the proof would still
 * verify. Omit it to prove the preimage exactly as given, which is what {@link proveCircuit} does.
 */
export const provePreimageWithBinding = async (
  paths: CircuitArtifactPaths,
  preimage: Uint8Array,
  bindingInput?: Uint8Array,
): Promise<Uint8Array> => {
  if (bindingInput !== undefined && bindingInput.length !== 32) {
    throw new Error(`a binding input is 32 bytes, got ${bindingInput.length}`)
  }
  return fromHex(
    await native().provePreimageWithBinding(
      paths.zkirPath,
      paths.proverKeyPath,
      paths.verifierKeyPath,
      paths.paramsPath,
      toHex(preimage),
      bindingInput === undefined ? '' : toHex(bindingInput),
    ),
  )
}

/** Per-call inputs for a native proven-unbound tx build (the dynamic, non-artifact part). */
export type JoinTxInputs = {
  /** The deployed contract's current serialized `ContractState` (queried from the indexer). */
  readonly contractState: Uint8Array
  /** The 32-byte contract address these artifacts + state belong to. */
  readonly contractAddress: Uint8Array
  /**
   * The circle's own 32-byte id — a constructor argument of its contract, not a counter. Every
   * nullifier hashes it, which is what keeps a persona unlinkable across circles.
   */
  readonly circleId: Uint8Array
  /**
   * The invite secret whose commitment a moderator published, or absent to join an **open** circle.
   *
   * `join` is one circuit with two transcripts: an open circle short-circuits the invite checks and
   * never touches the registry, a gated one asserts membership and removes the commitment it spends.
   * The two are built differently, so this is what selects the arm — and passing the wrong one is
   * refused when the transcript is checked against the contract's real state, not later at proving.
   */
  readonly inviteSecret?: Uint8Array | undefined
  /** The account identity secret (32 bytes). One join per identity is keyed on this, not the persona. */
  readonly identitySk: Uint8Array
  /** The persona secret key witness (32 bytes) — never leaves the device. */
  readonly personaSk: Uint8Array
  /** Network id the tx binds to (e.g. `''` for the standalone `undeployed` network). */
  readonly networkId: string
  /** Absolute intent expiry, unix seconds (caller derives from current time). */
  readonly ttlSecs: number
}

/**
 * Build a proven-unbound `join` transaction on-device: build the preimage, prove it at the
 * transaction level, and serialize. The result is the tagged `Transaction<signature,proof,pre-binding>`
 * bytes to POST to the content service's `/chain/submit` (the sponsor balances the DUST fee + submits).
 * CPU-bound for ~1–3 s on mobile — runs off the JS thread. The witness (`personaSk`) never leaves
 * the device; only public data (contract state, address) and the finished tx cross any boundary.
 */
export const buildJoinProvenTx = async (paths: CircuitArtifactPaths, inputs: JoinTxInputs): Promise<Uint8Array> =>
  fromHex(
    await native().buildJoinProvenTx({
      zkirPath: paths.zkirPath,
      proverKeyPath: paths.proverKeyPath,
      verifierKeyPath: paths.verifierKeyPath,
      paramsPath: paths.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      circleIdHex: toHex(inputs.circleId),
      // Empty is the open arm — the bridges turn it into a null pointer rather than 32 zero bytes.
      inviteSecretHex: inputs.inviteSecret === undefined ? '' : toHex(inputs.inviteSecret),
      identitySkHex: toHex(inputs.identitySk),
      personaSkHex: toHex(inputs.personaSk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * Inputs for a circle **deploy**. A circle is a contract, so creating one is not a call: there is no
 * contract state to read, no artifacts, and nothing to prove, because a constructor is not a circuit.
 *
 * The address is a hash over these three arguments plus the contract template, so it is derivable
 * offline — which is what lets a client verify an address it was handed instead of trusting it
 * (`docs/CONTRACT_MIGRATION.md` → "Decided 2026-08-11").
 */
export type CircleDeployInputs = {
  /** Directory holding every entry point's `<name>.verifier` (the app's artifact cache). */
  readonly keysDir: string
  /** The circle's 32-byte id. */
  readonly circleId: Uint8Array
  /** Whether anyone may join without an invite. */
  readonly isOpen: boolean
  /**
   * The founding moderator's persona commitment. It lands in `moderators`, not `members`, so this
   * leaf is the circle's entire moderation authority for its whole life.
   */
  readonly founder: Uint8Array
  /**
   * The auth key the constructor seats for the founder in `moderatorAuth`. The content plane verifies
   * a moderator's request signature against it — without one, the founder is a moderator no service
   * can authenticate. It feeds the initial state, so it is part of the **address**.
   */
  readonly founderAuth: Uint8Array
  /**
   * The founder's `identityJoinNullifier`, seated in `joinedIdentities` beside their member leaf.
   *
   * The constructor seats the founder as a member, which is what makes a gated circle creatable in
   * one transaction — but a leaf without its nullifier would leave them able to `join` again and hold
   * two. Computed off-chain (`@pnyx/contract-client/circle-derivations`) because a constructor has no
   * witnesses. Part of the **address**.
   */
  readonly founderJoined: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}

/**
 * Build the unproven, unbalanced deploy transaction for a circle. The sponsor balances and submits
 * it; balancing adds Zswap inputs/outputs to the surrounding intent and cannot move the address.
 *
 * Fast — no proving at all, unlike every other builder here.
 */
export const buildCircleDeployTx = async (inputs: CircleDeployInputs): Promise<Uint8Array> =>
  fromHex(
    await native().buildCircleDeployTx({
      keysDir: inputs.keysDir,
      circleIdHex: toHex(inputs.circleId),
      isOpen: inputs.isOpen,
      founderHex: toHex(inputs.founder),
      founderAuthHex: toHex(inputs.founderAuth),
      founderJoinedHex: toHex(inputs.founderJoined),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * The address a circle's constructor arguments imply, without building a transaction.
 *
 * Use it to check an address the service reported: if the two disagree, the contract at that address
 * is not the circle these arguments describe.
 */
export const circleDeployAddress = async (
  inputs: Omit<CircleDeployInputs, 'networkId' | 'ttlSecs'>,
): Promise<Uint8Array> =>
  fromHex(
    await native().circleDeployAddress({
      keysDir: inputs.keysDir,
      circleIdHex: toHex(inputs.circleId),
      isOpen: inputs.isOpen,
      founderHex: toHex(inputs.founder),
      founderAuthHex: toHex(inputs.founderAuth),
      founderJoinedHex: toHex(inputs.founderJoined),
    }),
  )

/** Inputs for a proven-unbound `publishRow` transaction. */
export type PublishRowTxInputs = {
  readonly artifacts: CircuitArtifactPaths
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  /** MLS Ed25519 signature public key. */
  readonly anchor: Uint8Array
  /** Session-login key the service checks a challenge against. */
  readonly authPub: Uint8Array
  /** The identity secret. Never leaves the device — only the proof does. */
  readonly identitySk: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}

/**
 * Build a proven-unbound `publishRow` transaction on-device.
 *
 * Must prove here rather than server-side: it carries a witness, so submitting it from the service
 * would mean handing over the identity secret. The sponsor still pays — it balances and submits the
 * proven bytes without being able to author them.
 *
 * One transcript for both a first publish and a rotation. The predecessor needed two, because it
 * branched on `identities.member(id)`; with one contract per identity the cells always exist.
 */
export const buildPublishRowProvenTx = async (inputs: PublishRowTxInputs): Promise<Uint8Array> =>
  fromHex(
    await native().buildPublishRowProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      anchorHex: toHex(inputs.anchor),
      authPubHex: toHex(inputs.authPub),
      identitySkHex: toHex(inputs.identitySk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/** A published Pnyx identity row (`docs/PNYX_IDENTITY_PLAN.md`). */
export type NativeIdentityRow = {
  /** The **MLS signature public key** — what `verifyKeyPackageAnchor` checks, not `authPub`. */
  readonly anchor: Uint8Array
  readonly authPub: Uint8Array
  /**
   * The claimed primary handle, all-zero when none is claimed.
   *
   * ⚠️ A *claim*, not proof of ownership: ownership lives in the per-name handle contract and
   * contract-to-contract calls do not exist. Apply the bidirectional rule before rendering it —
   * `handle(name).owner == C && identity(C).primaryName == name && !banned && !burned`.
   *
   * `publishRow` cannot write it; `setPrimaryName` is its only writer.
   */
  readonly name: Uint8Array
  /**
   * The contact card, ascending by slot. Empty when nothing is written.
   *
   * `value` is the full 320-byte row field. Decode it with `decodeCard` from
   * `@pnyx/contract-client/card` — the kind's flags and the two-byte length prefix are that module's
   * format, and duplicating the knowledge here is how two decoders start disagreeing.
   */
  readonly card: readonly {readonly slot: number; readonly kind: number; readonly value: Uint8Array}[]
}

/**
 * Read one identity row out of Pnyx's contract state.
 *
 * Exists so the app can resolve rows from state it fetched **itself** — the alternative was asking
 * the content service per lookup, which told it who was looking up whom. The decode has to be native
 * because Hermes has no WASM to run the generated ledger decoder.
 *
 * `undefined` means that identity has published nothing — a definite answer. An unreadable state
 * rejects instead; conflating the two turns an outage into "this person cannot be messaged".
 */
export const identityRowFromState = async (
  state: Uint8Array,
  identity: Uint8Array,
): Promise<NativeIdentityRow | undefined> => {
  if (identity.length !== 32) throw new Error(`identity must be 32 bytes, got ${identity.length}`)
  const parsed = JSON.parse(await native().identityRow(toHex(state), toHex(identity))) as null | {
    anchor: string
    authPub: string
    name: string
    card: {slot: number; kind: number; value: string}[]
  }
  if (parsed === null) return undefined
  return {
    anchor: fromHex(parsed.anchor),
    authPub: fromHex(parsed.authPub),
    name: fromHex(parsed.name),
    card: parsed.card.map((r) => ({slot: r.slot, kind: r.kind, value: fromHex(r.value)})),
  }
}

/** Per-call inputs shared by the identity write paths. */
export type IdentityWriteInputs = {
  readonly artifacts: CircuitArtifactPaths
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly identitySk: Uint8Array
  readonly networkId: string
  /** Absolute unix-second expiry, not a duration — see {@link PublishRowTxInputs.ttlSecs}. */
  readonly ttlSecs: number
}

/**
 * Build a proven-unbound `setPrimaryName` transaction — point at one of my handles, or at none.
 *
 * The contract validates nothing about the name, deliberately: ownership lives in the per-name handle
 * contract and contract-to-contract calls do not exist, so this writes a *claim*. Readers apply the
 * bidirectional rule, which is what makes a name pointed at but not pointing back inert rather than an
 * impersonation.
 */
export const buildSetPrimaryNameProvenTx = async (
  inputs: IdentityWriteInputs & {
    /** The handle padded to 32 bytes (`encodeHandle`). All-zero clears it. */
    readonly name: Uint8Array
  },
): Promise<Uint8Array> =>
  fromHex(
    await native().buildSetPrimaryNameProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      nameHex: toHex(inputs.name),
      identitySkHex: toHex(inputs.identitySk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * Build a proven-unbound `setRow` transaction — change one contact-card row.
 *
 * `value` is the full 320-byte field from `encodeCard`; kind 0 clears the slot. Clearing a slot the
 * card does not hold is rejected by the builder rather than sent, because the circuit asserts
 * "no such row" and the transcript could never prove.
 */
export const buildSetRowProvenTx = async (
  inputs: IdentityWriteInputs & {
    readonly slot: number
    readonly kind: number
    readonly value: Uint8Array
  },
): Promise<Uint8Array> => {
  if (inputs.value.length !== 320) throw new Error(`card row value must be 320 bytes, got ${inputs.value.length}`)
  return fromHex(
    await native().buildSetRowProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      slot: inputs.slot,
      kind: inputs.kind,
      valueHex: toHex(inputs.value),
      identitySkHex: toHex(inputs.identitySk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
}

/**
 * Build a proven-unbound `setRows` transaction — the "save my card" path, exactly four slots.
 *
 * Four because the template's width is fixed, and it is ~2.9x cheaper than four `setRow` proofs
 * (measured host-side: one K14 at ~4.8 s against four K13 at ~3.5 s each). Pass batches from
 * `cardBatches` in `@pnyx/contract-client/card`, which pads a short batch with clears aimed at slots
 * it is **not** writing — padding with a slot the batch also writes deletes the row it just wrote,
 * since kind 0 is the contract's remove sentinel.
 */
export const buildSetRowsProvenTx = async (
  inputs: IdentityWriteInputs & {
    readonly rows: readonly {readonly slot: number; readonly kind: number; readonly value: Uint8Array}[]
  },
): Promise<Uint8Array> => {
  if (inputs.rows.length !== 4) throw new Error(`setRows takes exactly 4 slots, got ${inputs.rows.length}`)
  const values = new Uint8Array(4 * 320)
  inputs.rows.forEach((row, i) => {
    if (row.value.length !== 320) throw new Error(`card row ${i} value must be 320 bytes, got ${row.value.length}`)
    values.set(row.value, i * 320)
  })
  return fromHex(
    await native().buildSetRowsProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      slots: inputs.rows.map((r) => r.slot),
      kinds: inputs.rows.map((r) => r.kind),
      valuesHex: toHex(values),
      identitySkHex: toHex(inputs.identitySk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
}

/** Reads take no secret; the native side ignores the key argument for them. */
const NO_KEY = '00'.repeat(32)

/**
 * The shielded wallet's own state, as opaque bytes the caller persists.
 *
 * Deliberately opaque: every operation goes back through the native module, because the rules about
 * what a coin is belong to `midnight-zswap` and a JS-side interpretation of these bytes would be a
 * second, divergent implementation of them.
 */
export type WalletStateBytes = Uint8Array

/** A fresh wallet: no coins, blank commitment tree, cursor at 0. */
export const walletStateNew = async (): Promise<WalletStateBytes> =>
  fromHex(await native().walletStateOp('new', '', '00'.repeat(32), ''))

/**
 * Fast-forward the commitment tree over a range this wallet holds no coins in.
 *
 * `update` is the indexer's `zswapMerkleTreeCollapsedUpdate`, tagged-serialized.
 *
 * ⚠️ **It is not self-validating, and this doc used to claim it was.** Only the framing is checked:
 * 311 of 377 single-byte flips in a real preprod update were accepted, each yielding a tree that
 * differs from the chain's and whose proofs fail later for no visible reason. {@link walletMerkleRoot}
 * against the indexer's `zswapMerkleTreeRoot` is what actually tells the two apart.
 */
export const walletApplyCollapsedUpdate = async (
  state: WalletStateBytes,
  zswapRoleKey: Uint8Array,
  update: Uint8Array,
): Promise<WalletStateBytes> =>
  fromHex(await native().walletStateOp('applyCollapsedUpdate', toHex(state), toHex(zswapRoleKey), toHex(update)))

/**
 * Take ownership of a coin whose values are already known.
 *
 * **The only way to hold a coin a contract minted.** A contract-initiated mint or send creates no
 * output ciphertext, so no amount of scanning will find it; the transaction that produced it is the
 * only place those values ever exist (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.4.1).
 */
export const walletInsertCoin = async (
  state: WalletStateBytes,
  zswapRoleKey: Uint8Array,
  coin: ShieldedCoin,
): Promise<WalletStateBytes> =>
  fromHex(await native().walletStateOp('insertCoin', toHex(state), toHex(zswapRoleKey), coinToWire(coin)))

/**
 * Expect a coin that has not arrived in this wallet's view yet, so applying the transaction that
 * carries it claims it. Not a balance until then — see {@link walletSummary}.
 */
export const walletWatchFor = async (
  state: WalletStateBytes,
  zswapRoleKey: Uint8Array,
  coin: ShieldedCoin,
): Promise<WalletStateBytes> =>
  fromHex(await native().walletStateOp('watchFor', toHex(state), toHex(zswapRoleKey), coinToWire(coin)))

/**
 * Apply a confirmed transaction: claim coins paid to us, retire coins we spent, advance the tree.
 *
 * `succeededSegments` are the fallible segments the ledger accepted (`transactionResult.segments`
 * where `success`), or `'all'` for a fully successful transaction — on a full success the indexer
 * reports no per-segment detail, because none of it failed. The guaranteed section is always applied,
 * since a transaction in a block has it by definition.
 *
 * ⚠️ **Never pass a segment that failed.** The wallet would insert a coin the chain never created and
 * then prove spends against a tree the chain does not share, which surfaces much later as a rejected
 * transaction with no local explanation.
 */
export const walletApplyTransaction = async (
  state: WalletStateBytes,
  zswapRoleKey: Uint8Array,
  transaction: Uint8Array,
  succeededSegments: readonly number[] | 'all',
): Promise<WalletStateBytes> =>
  fromHex(
    await native().walletStateOp(
      'applyTransaction',
      toHex(state),
      toHex(zswapRoleKey),
      applyTransactionArg(transaction, succeededSegments),
    ),
  )

/**
 * The commitment tree's root, in the same encoding the indexer reports as `zswapMerkleTreeRoot`.
 *
 * **Takes no key** — a root is a fact about the tree. Compare it against the root the indexer gives
 * for the last transaction applied: equal means this wallet's coins sit at the indices the chain gave
 * them and its spend proofs will verify; unequal means they will not, and says so now rather than at
 * submission.
 */
export const walletMerkleRoot = async (state: WalletStateBytes): Promise<string> =>
  JSON.parse(await native().walletReadOp('merkleRoot', toHex(state), NO_KEY, '')) as string

/**
 * Balances, the sync cursor, and every spendable coin.
 *
 * **Takes no key**, and that is a property rather than an omission: a balance is a fact about the state
 * blob, so it can be rendered while the vault is locked. Only spending needs the role key — as does
 * *discovering* a coin, since that decrypts ciphertexts.
 *
 * Values arrive as decimal strings and are parsed to `bigint` here: a `u128` cannot survive JSON's
 * number type, and a silently rounded balance is worse than none.
 */
export const walletSummary = async (state: WalletStateBytes): Promise<WalletSummary> =>
  parseWalletSummary(await native().walletReadOp('summary', toHex(state), NO_KEY, ''))

/**
 * Open one output ciphertext with this wallet's encryption key.
 *
 * `undefined` means the output belongs to someone else — the overwhelmingly common answer on a
 * public chain, and not an error. A malformed ciphertext rejects instead, so a corrupt stream cannot
 * masquerade as a chain with nothing of ours on it.
 */
export const walletTryDecrypt = async (
  zswapRoleKey: Uint8Array,
  ciphertext: Uint8Array,
): Promise<ShieldedCoin | undefined> =>
  parseDecryptedCoin(await native().walletReadOp('tryDecrypt', '', toHex(zswapRoleKey), toHex(ciphertext)))

/**
 * The identifiers of a proven transaction — how a submission is tracked once it leaves this device.
 *
 * **Not a hash, because there is no hash.** The ledger refuses one for what this rail builds:
 * *"Transaction hash is available for proven, signed and bound transactions only."* Binding happens at
 * the sponsor, so the device cannot compute a hash for its own transfer. Identifiers are the only
 * handle it can record, and the ledger's own `has_identifier` is a containment test — so a caller
 * matches "is one of mine among the landed transaction's", never equality.
 *
 * The hex is verified byte-for-byte against `@midnight-ntwrk/ledger-v8`'s `Transaction.identifiers()`,
 * which is what the indexer's `HexEncoded` identifier offset matches.
 */
export const provenTxIdentifiers = async (transaction: Uint8Array): Promise<readonly string[]> =>
  parseIdentifiers(await native().walletReadOp('txIdentifiers', '', NO_KEY, toHex(transaction)))

/**
 * Sign arbitrary bytes with the role-0 Night key — the dApp connector's `signData`.
 *
 * The key is the one an unshielded address names and the one a transfer is signed with, so this is an
 * exposure of existing crypto rather than new crypto. ⚠️ **Randomised**: BIP-340 signing here draws
 * auxiliary randomness, so two signatures over the same message differ. Never treat one as an
 * identifier for the other.
 *
 * `message` must already be decoded from whatever encoding the dApp asked for; this signs exactly the
 * bytes it is given.
 */
export type {NightSignature} from './wallet-wire'

export const walletSignData = async (nightRoleKey: Uint8Array, message: Uint8Array): Promise<NightSignature> =>
  parseNightSignature(await native().walletReadOp('signData', '', toHex(nightRoleKey), toHex(message)))

/** Where the protocol circuits and the shared SRS are cached on this device. */
export type ZswapArtifactDirs = {
  /** Holds `{spend,output,sign}.{bzkir,prover,verifier}`. */
  readonly artifactDir: string
  /** Holds `bls_midnight_2p<K>`. */
  readonly paramsDir: string
}

export type ShieldedTransfer = {
  /** The proven, unbound transaction — hand it to the sponsor to balance and submit. */
  readonly transaction: Uint8Array
  /**
   * The wallet state with this transfer's coins marked pending.
   *
   * **Persist this, not the one you passed in.** Keeping the old state would let the next transfer
   * select the same notes, and the ledger rejects the pair.
   */
  readonly state: WalletStateBytes
}

/**
 * Build and prove a shielded transfer on device.
 *
 * The Zswap offer balances itself — coins in equal coins out, recipient plus change — so the sponsor
 * adds only the DUST fee. Seconds of CPU: three protocol circuits are proved.
 */
export const walletBuildTransfer = async (params: {
  readonly state: WalletStateBytes
  readonly zswapRoleKey: Uint8Array
  /** Recipient's shielded address, split: 32-byte coin public key and the encryption key's bytes. */
  readonly recipientCoinPublicKey: Uint8Array
  readonly recipientEncryptionPublicKey: Uint8Array
  readonly color: Uint8Array
  readonly value: bigint
  readonly networkId: string
  readonly ttlSecs: number
  readonly artifacts: ZswapArtifactDirs
}): Promise<ShieldedTransfer> => {
  const json = await native().walletBuildTransfer({
    stateHex: toHex(params.state),
    zswapRoleKeyHex: toHex(params.zswapRoleKey),
    recipientCoinPublicKeyHex: toHex(params.recipientCoinPublicKey),
    recipientEncryptionPublicKeyHex: toHex(params.recipientEncryptionPublicKey),
    colorHex: toHex(params.color),
    valueLeHex: valueToLeHex(params.value),
    networkId: params.networkId,
    ttlSecs: params.ttlSecs,
    artifactDir: params.artifacts.artifactDir,
    paramsDir: params.artifacts.paramsDir,
  })
  const parsed = JSON.parse(json) as {tx: string; state: string}
  return {transaction: fromHex(parsed.tx), state: fromHex(parsed.state)}
}

/**
 * Build and sign an unshielded NIGHT transfer on device.
 *
 * Nothing is proved — an unshielded transfer carries no circuit — so this needs no artifacts, no SRS
 * and milliseconds rather than seconds. That is what lets a phone send NIGHT having synced nothing:
 * the DUST fee is the sponsor's, in its own segment, merged into the unbound transaction this
 * returns.
 *
 * Inputs are spent in full and the remainder comes back as a change output, because an unshielded
 * offer conserves value per token type. Select the UTxOs to spend from the set the indexer reports;
 * every one of them must be the same token as `value`, and the native side refuses the mix rather
 * than folding a stray token into NIGHT change.
 */
export const walletBuildUnshieldedTransfer = async (params: {
  /** The role-0 (Night) key — it signs each input and owns the change. */
  readonly nightRoleKey: Uint8Array
  readonly inputs: readonly UnshieldedSpend[]
  /** The recipient's 32-byte address payload, from inside an `mn_addr…` address. */
  readonly recipientAddress: Uint8Array
  readonly tokenType: Uint8Array
  readonly value: bigint
  readonly networkId: string
  readonly ttlSecs: number
  /**
   * How many outputs to return change in. Omitted or `1` keeps a single change output.
   *
   * ⚠️ A DUST generation's rate *and* cap are proportional to the value of the one NIGHT UTxO backing
   * it, and a fee must be covered by a **single** DUST output — so one large UTxO gives a wallet
   * exactly one output that can ever pay. Splitting change is how it keeps several.
   */
  readonly changeChunks?: number
}): Promise<Uint8Array> =>
  fromHex(
    await native().walletBuildUnshieldedTransfer({
      nightRoleKeyHex: toHex(params.nightRoleKey),
      inputsHex: packUnshieldedInputs(params.inputs),
      recipientAddressHex: toHex(params.recipientAddress),
      tokenTypeHex: toHex(params.tokenType),
      valueLeHex: valueToLeHex(params.value),
      networkId: params.networkId,
      ttlSecs: params.ttlSecs,
      changeChunks: params.changeChunks ?? 1,
    }),
  )

/**
 * What a transaction owes, straight from the ledger's own balance map.
 *
 * Read this **before** asking the user to approve funding it: the figure a review screen names and the
 * figure the funding spends have to be the same one, and this is where both come from. A negative
 * `delta` is owed; a positive one is a surplus the transaction is allowed to leave behind.
 *
 * Needs no wallet state and no key — the transaction says everything.
 */
export const txBalance = async (transaction: Uint8Array): Promise<readonly TxBalanceEntry[]> =>
  parseTxBalance(await native().walletReadOp('txBalance', '', NO_KEY, toHex(transaction)))

/**
 * What a transaction **contains**, as the native reader's JSON.
 *
 * The device half of `docs/MIDNIGHT_REVIEW_FROM_BYTES.md`: a review that reads the bytes instead of
 * restating what its caller asked for. Answers per-segment unshielded inputs and outputs with owner,
 * colour and value, the contract calls and deploys, the expiry, the network id, and shielded outputs
 * as a **count** — their amounts and recipients are encrypted and no reader can total them.
 *
 * ⚠️ **Returns the JSON, deliberately.** `@pnyx/tx-review`'s `parseMidnightTxFactsJson` turns it into
 * the `MidnightTxFacts` both hosts share, and that package must not become a dependency here: it
 * carries the Cardano IR and the whole Cardano tree with it. So the seam is a string, and the
 * parser lives beside the type it produces. A committed fixture pins the two ends together
 * (`rust/src/facts.rs`, `packages/tx-review/midnight-facts-wire.test.ts`).
 *
 * Needs no wallet state and no key — the transaction says all of it.
 */
export const txFactsJson = async (transaction: Uint8Array): Promise<string> =>
  native().walletReadOp('txFacts', '', NO_KEY, toHex(transaction))

/**
 * Whether a transaction is **bound** — finished, and submittable to a node as-is.
 *
 * The two states need different submission rails and nothing in the bytes distinguishes them to a
 * caller: a pre-binding transaction still needs somebody to bind it (the sponsor merges its fee and
 * does exactly that), while a bound one is complete and goes straight to `author_submitExtrinsic`.
 * Relaying the wrong shape to the wrong rail fails with a message about neither.
 *
 * Read from the native reader's own verdict rather than sniffed: `tagged_deserialize` checks the
 * header tag before reading anything, so which shape it parsed is a fact, not a guess.
 */
export const isTransactionBound = async (transaction: Uint8Array): Promise<boolean> => {
  const json = await txFactsJson(transaction)
  const parsed = JSON.parse(json) as {bound?: unknown}
  if (typeof parsed.bound !== 'boolean') {
    // Never assume one: guessing "unbound" would send a finished transaction to the sponsor to be
    // bound a second time, and guessing "bound" would submit one that nothing has paid for.
    throw new Error(`the transaction reader did not say whether it is bound: ${json.slice(0, 120)}`)
  }
  return parsed.bound
}

/**
 * Fund the deficits of a transaction a dApp composed, sign the intents that changed, and return the
 * funded transaction — the connector's `balanceUnsealedTransaction`.
 *
 * Nothing is proved: the transaction arrives proven and only unshielded value is added, which carries
 * no circuit. It also stays **unbound**, so the sponsor can still merge the DUST fee into it.
 *
 * `candidates` are offered, not spent: the native side reads what each segment owes and spends the
 * fewest UTxOs that cover it, largest first. Pass everything the wallet holds of the relevant tokens.
 *
 * ⚠️ The refusals live natively, because only that side can see them: a shielded or DUST deficit, a
 * deficit in the guaranteed segment, an intent that already spends inputs (funding it would void
 * signatures we cannot reproduce), or candidates that do not cover the shortfall. Each names what was
 * wrong so a dApp can act on it.
 */
/**
 * **Co-funding step 1 — the composer.** Gather every contributor's inputs into one finalised,
 * unsigned intent, which is exactly what each of them then signs over.
 *
 * ⚠️ **Several wallets funding ONE payment.** Not `Transaction::merge`, which bundles independent
 * payments and does not pool funds — `docs/MIDNIGHT_COFUNDING_PLAN.md`.
 *
 * ⚠️ **Nothing may change after this.** The signing payload is the whole erased intent, so a later
 * edit — another input, a different recipient, a DUST action — voids every signature already
 * gathered. Fees stay the sponsor's segment for that reason.
 */
export const walletBuildCoFundedIntent = async (params: {
  readonly contributions: readonly CoFundContribution[]
  /** The recipient's `UserAddress` payload — the 32 bytes inside an `mn_addr…` address. */
  readonly recipientAddress: Uint8Array
  readonly tokenType: Uint8Array
  readonly networkId: string
  /** Absolute expiry, unix seconds. Every contributor signs over it, so it is fixed here. */
  readonly ttlSecs: number
}): Promise<Uint8Array> =>
  fromHex(
    await native().walletBuildCoFundedIntent({
      contributionsHex: packCoFundContributions(params.contributions),
      recipientAddressHex: toHex(params.recipientAddress),
      tokenTypeHex: toHex(params.tokenType),
      networkId: params.networkId,
      ttlSecs: params.ttlSecs,
    }),
  )

/**
 * **Co-funding step 2 — a contributor.** Sign only the inputs this key owns.
 *
 * An empty list means this wallet owns none of the offer's inputs. That is an answer, not a failure:
 * a co-signer asked in error should be told which it is.
 */
export const walletSignCoFundedShare = async (params: {
  readonly intent: Uint8Array
  readonly nightRoleKey: Uint8Array
}): Promise<readonly CoFundShare[]> =>
  unpackCoFundShares(
    await native().walletSignCoFundedShare({
      intentHex: toHex(params.intent),
      nightRoleKeyHex: toHex(params.nightRoleKey),
    }),
  )

/**
 * **Co-funding step 3 — the composer.** Place every gathered signature at its input's index and
 * prove, giving the proven unbound transaction the sponsor path already submits.
 *
 * ⚠️ Refuses an incomplete round, and refuses a signature sitting at the wrong index — the second
 * would otherwise verify as a signature and fail as an offer, at the node, naming nobody.
 */
export const walletAssembleCoFundedTx = async (params: {
  readonly intent: Uint8Array
  readonly shares: readonly CoFundShare[]
  readonly networkId: string
}): Promise<Uint8Array> =>
  fromHex(
    await native().walletAssembleCoFundedTx({
      intentHex: toHex(params.intent),
      sharesHex: packCoFundShares(params.shares),
      networkId: params.networkId,
    }),
  )

export const walletBalanceUnsealedTransaction = async (params: {
  /** The dApp's `Transaction<SignatureEnabled, Proof, PreBinding>`. */
  readonly transaction: Uint8Array
  /** The role-0 (Night) key — it signs each added input and owns the change. */
  readonly nightRoleKey: Uint8Array
  readonly candidates: readonly UnshieldedSpend[]
}): Promise<Uint8Array> => {
  // Refused here rather than at the bridge: an empty candidate set can fund nothing, and on iOS an
  // empty array has no base address for the C call to take.
  if (params.candidates.length === 0) {
    throw new Error('balanceUnsealedTransaction needs at least one candidate UTxO to fund a deficit with')
  }
  return fromHex(
    await native().walletBalanceUnsealedTransaction({
      transactionHex: toHex(params.transaction),
      nightRoleKeyHex: toHex(params.nightRoleKey),
      inputsHex: packUnshieldedInputs(params.candidates),
    }),
  )
}

/**
 * The DUST state a phone holds, as the host stores it.
 *
 * Opaque bytes on purpose — the same handling as `WalletStateBytes`: every op deserializes, acts, and
 * returns the new state, so nothing outlives a call and the host owns persistence.
 */
export type DustStateBytes = Uint8Array

/**
 * A blank DUST state under the protocol's initial parameters.
 *
 * The parameters are consensus values, taken from the ledger rather than configured: a wallet that
 * disagreed with the chain about the generation rate would compute a balance nobody else agrees with.
 */
export const dustStateNew = async (): Promise<DustStateBytes> =>
  fromHex(await native().walletStateOp('dust:new', '', NO_KEY, ''))

/**
 * Fast-forward the generation tree across indices this wallet has no NIGHT in.
 *
 * 🔑 **This is the fast sync, and it is the reason to be on this rail at all.** The four
 * collapsed-update methods exist in the Rust ledger crate and in `ledger-v8`, but in **no**
 * `@midnight-ntwrk/wallet-sdk-*` package — the TS `DustWallet` can only replay the full event history,
 * which is what makes a first DUST sync cost other wallets over an hour. Each update here is one
 * ~150-byte blob (`midnight:merkle-tree-collapsed-update[v1]`) the indexer already serves.
 */
export const dustApplyGenerationCollapsedUpdate = async (
  state: DustStateBytes,
  update: Uint8Array,
): Promise<DustStateBytes> =>
  fromHex(await native().walletStateOp('dust:applyGenerationCollapsedUpdate', toHex(state), NO_KEY, toHex(update)))

/** As above, for the commitment tree. */
export const dustApplyCommitmentCollapsedUpdate = async (
  state: DustStateBytes,
  update: Uint8Array,
): Promise<DustStateBytes> =>
  fromHex(await native().walletStateOp('dust:applyCommitmentCollapsedUpdate', toHex(state), NO_KEY, toHex(update)))

/**
 * Discard the witness data for a range of generation-tree leaves this wallet does not need.
 *
 * ⚠️ **Irreversible.** A collapsed range cannot be restored from the local state — recovering it means
 * re-syncing. Collapsing is what keeps a synced state small enough to persist on a phone, so it is
 * offered, but the range is the caller's to justify.
 */
export const dustCollapseGenerationTree = async (
  state: DustStateBytes,
  start: bigint,
  end: bigint,
): Promise<DustStateBytes> =>
  fromHex(
    await native().walletStateOp('dust:collapseGenerationTree', toHex(state), NO_KEY, collapseRangeHex(start, end)),
  )

/** As above, for the commitment tree. */
export const dustCollapseCommitmentTree = async (
  state: DustStateBytes,
  start: bigint,
  end: bigint,
): Promise<DustStateBytes> =>
  fromHex(
    await native().walletStateOp('dust:collapseCommitmentTree', toHex(state), NO_KEY, collapseRangeHex(start, end)),
  )

/**
 * Drop DUST outputs whose time-to-live has passed.
 *
 * A state change rather than part of a read: expiring outputs inside a balance read would make two
 * identical reads disagree.
 */
export const dustProcessTtls = async (state: DustStateBytes, atUnixSecs: bigint): Promise<DustStateBytes> =>
  fromHex(await native().walletStateOp('dust:processTtls', toHex(state), NO_KEY, u64ToLeHex(atUnixSecs)))

/**
 * What this wallet can spend as DUST at one instant, and how far its state is synced.
 *
 * ⚠️ **The time is a parameter, deliberately.** DUST accrues from registered NIGHT towards a cap, so a
 * balance without the instant it was computed at is meaningless — and the figure shown to a user has to
 * be the same one a fee is checked against. Reading a clock in here would make those two drift.
 *
 * This is also the arithmetic the indexer will not do for NIGHT held on Midnight: its `dustGenerations`
 * feed reports `initialValue`, which is DUST at *creation*, not the spendable amount now.
 *
 * ⚠️ **Named for what it answers, because the old name caused a real bug.** It was `dustBalance`, which
 * read like a synonym for `fetchDustGenerationStatus`'s `currentCapacity` — a *Cardano-side registration*
 * figure that is `0` for a wallet that never registered. The dApp connector answered that one as the
 * balance, so a wallet holding spendable DUST told every dApp it had none. Two facts, two names.
 */
export const spendableDustAt = async (state: DustStateBytes, atUnixSecs: bigint): Promise<DustBalance> =>
  parseDustBalance(await native().walletReadOp('dust:balance', toHex(state), NO_KEY, u64ToLeHex(atUnixSecs)))

/**
 * Every output's nullifier, so the chain can be asked which of them are already spent.
 *
 * ⚠️ **`dust-spent` answers a different question.** It records what *this app* did; a wallet whose DUST
 * was spent by a `harness/` run, another device or a dApp carries no flag. A state rebuilt at `seq 0`
 * over an output the chain has retired proves fine and is refused at submit with
 * `196 — DustDoubleSpend`, and its value is counted in a balance that is simply wrong.
 * `Subscription.dustNullifierTransactions` answers by nullifier prefix, and these are the prefixes.
 *
 * Needs the dust role key: a nullifier derives from the secret, which is why it cannot be computed here.
 */
export const dustNullifiers = async (state: DustStateBytes, dustRoleKey: Uint8Array): Promise<readonly string[]> => {
  const raw = await native().walletReadOp('dust:nullifiers', toHex(state), toHex(dustRoleKey), '')
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || parsed.some((row) => typeof row !== 'string')) {
    throw new Error(`dust:nullifiers returned an unreadable shape: ${raw.slice(0, 120)}`)
  }
  return parsed as readonly string[]
}

/**
 * Drop outputs the chain has already spent.
 *
 * ⚠️ **Not a repair of their value.** Recovering the DUST means rebuilding each successor from the
 * transaction that spent it — `docs/DUST_SPEND_PROOF.md` §196. This is the half that stops the damage:
 * selection can no longer pick a dead output and build a proof the node refuses, and the balance stops
 * counting DUST this wallet does not have.
 *
 * A nullifier the state does not hold is ignored rather than refused: the indexer answers by *prefix*,
 * so a match can belong to another wallet, and a later sync re-offers ones already dropped.
 */
export const dustRemoveUtxos = async (
  state: DustStateBytes,
  nullifiers: readonly Uint8Array[],
): Promise<DustStateBytes> => {
  if (nullifiers.length === 0) return state
  const joined = new Uint8Array(nullifiers.reduce((total, one) => total + one.length, 0))
  let at = 0
  for (const one of nullifiers) {
    joined.set(one, at)
    at += one.length
  }
  return fromHex(await native().walletStateOp('dust:removeUtxos', toHex(state), NO_KEY, toHex(joined)))
}

/**
 * Replace a generation leaf that is already in the tree, from the indexer's evidence.
 *
 * ⚠️ **Not an insert, and a rebuild never needs it.** When the NIGHT backing a generation moves, the
 * ledger replaces that leaf rather than adding one — `generating_tree.update_from_evidence` in its own
 * replay branch. A sync that *rebuilds* folds the final dtime into the leaf as it inserts it; a sync
 * that *advances* a stored state cannot re-insert a leaf that is already there, so it applies the
 * evidence instead. Skipping it drifts the generation root from the chain's the moment backing NIGHT
 * moves, which surfaces as a self-funded send refused with `170` rather than as a wrong balance.
 *
 * `path` is `DustGenerationDtimeUpdateItem.treeInsertionPath`, tagged, exactly as the indexer sent it.
 */
export const dustApplyDtimeUpdate = async (state: DustStateBytes, path: Uint8Array): Promise<DustStateBytes> =>
  fromHex(await native().walletStateOp('dust:applyDtimeUpdate', toHex(state), NO_KEY, toHex(path)))

/** Both DUST tree roots as the ledger serializes them, plus the state's own `sync_time`. */
export type DustTreeRoots = {
  /** Tagged-serialized generation-tree root, or `null` when the tree has no computed hashes. */
  readonly generation: string | null
  /** Tagged-serialized commitment-tree root, or `null` for the same reason. */
  readonly commitment: string | null
  /** Unix seconds. Only an event replay advances this; a collapse-built state leaves it at 0. */
  readonly syncTime: number
}

/**
 * The roots of this state's two Merkle trees.
 *
 * ⚠️ **This is a diagnostic, and the one measurement that settles whether a locally built DUST state is
 * spendable.** A spend proof commits to these roots and the node looks its own up under the timestamp
 * the spend declares — a miss is reported as `InvalidDustSpendProof`, naming the proof rather than the
 * time. The chain publishes both roots per block, so comparing them says whether our tree *is* the
 * chain's tree at that block or merely holds the right outputs. `docs/DUST_SPEND_PROOF.md`.
 *
 * The encoding is the ledger's tagged form, which is what the indexer prints — a bare 32-byte field
 * element would report a real match as a mismatch.
 */
export const dustTreeRoots = async (state: DustStateBytes): Promise<DustTreeRoots> => {
  const raw = await native().walletReadOp('dust:treeRoots', toHex(state), NO_KEY, '')
  const parsed = JSON.parse(raw) as {generation?: unknown; commitment?: unknown; syncTime?: unknown}
  if (
    (parsed.generation !== null && typeof parsed.generation !== 'string') ||
    (parsed.commitment !== null && typeof parsed.commitment !== 'string') ||
    typeof parsed.syncTime !== 'number'
  ) {
    throw new Error(`dust:treeRoots returned an unreadable shape: ${raw}`)
  }
  return {generation: parsed.generation, commitment: parsed.commitment, syncTime: parsed.syncTime}
}

/** Every DUST output this wallet holds. `initialValue` is DUST at creation, never the spendable amount. */
export const dustUtxos = async (state: DustStateBytes): Promise<readonly DustUtxo[]> =>
  parseDustUtxos(await native().walletReadOp('dust:utxos', toHex(state), NO_KEY, ''))

/**
 * Replay ledger DUST events into the state — the sync proper.
 *
 * Upstream's own path, and the only one that maintains every invariant together: generation info,
 * commitments, nullifiers and dtime updates. The collapsed-update ops are what make it cheap — replay
 * the ranges that matter, skip the rest. The TS wallet SDK has replay and nothing else, which is why
 * its first DUST sync is measured in hours.
 *
 * `events` are the indexer's `dustLedgerEvents` blobs, each already tagged. They cross as
 * `[len(u32 LE) ‖ event]*`.
 *
 * ⚠️ **Length-framed because tagged values are not self-delimiting.** `tagged_deserialize` requires its
 * input to hold exactly one value and fails with "Not all bytes read … N bytes remaining" when more
 * follows, so a plain concatenation is rejected at the first event. Found on device against 64 real
 * events — a host test over one event, or over garbage, passes either way.
 *
 * ⚠️ Takes the **DUST role key**: replay has to recognise which outputs are ours.
 */
export const dustReplayEvents = async (
  state: DustStateBytes,
  dustRoleKey: Uint8Array,
  events: readonly Uint8Array[],
): Promise<DustStateBytes> => {
  const batch = new Uint8Array(events.reduce((n, e) => n + 4 + e.length, 0))
  const lengths = new DataView(batch.buffer)
  let at = 0
  for (const event of events) {
    lengths.setUint32(at, event.length, true)
    batch.set(event, at + 4)
    at += 4 + event.length
  }
  return fromHex(await native().walletStateOp('dust:replayEvents', toHex(state), toHex(dustRoleKey), toHex(batch)))
}

/**
 * Insert one of this wallet's own generation entries: the generation info, its commitment, and the DUST
 * output it backs.
 *
 * Three inserts that belong together — a caller that landed two of them would hold a state reporting a
 * balance it cannot spend.
 *
 * ⚠️ **Both trees insert linearly**, so the caller must first advance each to exactly this entry's index
 * with {@link dustApplyGenerationCollapsedUpdate} / {@link dustApplyCommitmentCollapsedUpdate}. That
 * alternation is the fast sync: on preprod, skipping 0..238,130 is one 343-byte blob rather than a
 * quarter of a million leaves.
 *
 * ⚠️ Do **not** use {@link dustCollapseGenerationTree} to advance — it is local, leaves `first_free`
 * alone, and makes the index unusable (`CollapsedIndex`).
 */
export const dustApplyGeneration = async (
  state: DustStateBytes,
  dustRoleKey: Uint8Array,
  entry: DustGenerationEntry,
): Promise<DustStateBytes> =>
  fromHex(
    await native().walletStateOp('dust:applyGeneration', toHex(state), toHex(dustRoleKey), generationToWire(entry)),
  )

/** A transfer that paid its own way: sealed bytes, the DUST state to persist, and the fee charged. */
export type SelfFundedTransfer = {
  /** Sealed and submittable as-is — no sponsor needs to bind it. */
  readonly transaction: Uint8Array
  /**
   * The DUST state with the fee's output spent.
   *
   * ⚠️ **Persist this, not the one you passed in.** Keeping the old state would let the next transfer
   * pick the same DUST output, and the ledger rejects the pair.
   */
  readonly dustState: DustStateBytes
  /** SPECK actually charged. `0n` means the chain was idle enough to be free — see below. */
  readonly fee: bigint
  /**
   * The transaction's identifiers, read **before** the seal.
   *
   * ⚠️ They cannot be recovered from {@link transaction}: `provenTxIdentifiers` deserializes a
   * `ProvenTx`, whose header is `embedded-fr`, and a sealed transaction is `pedersen-schnorr`. Sealing
   * adds a binding signature rather than inputs, so these identify the transaction that ships.
   */
  readonly identifiers: readonly string[]
}

/**
 * Build a transfer that pays its own DUST fee, instead of going out unbound for a sponsor.
 *
 * The one transfer builder that **proves**: paying a fee spends DUST, a dust spend is a circuit
 * (`midnight/dust/spend`, K=13), and `Transaction::prove` walks `dust_actions`. Measured at 285 ms on
 * a host in release, so expect well under a second on a phone — but it is not free, and it is the
 * reason this takes artifact directories while the sponsored builder does not.
 *
 * It also **seals**. Everything else this rail builds goes out unbound because the sponsor binds it
 * after merging a fee in; nobody does that for a transaction that funds itself.
 *
 * ⚠️ A **zero** fee is normal on an idle chain (the dust price decays), and in that case no dust action
 * is attached at all — the node rejects an *empty* `DustActions` as `NotNormalized`.
 */
export const walletBuildSelfFundedTransfer = async (params: {
  readonly nightRoleKey: Uint8Array
  readonly inputs: readonly UnshieldedSpend[]
  readonly recipientAddress: Uint8Array
  readonly tokenType: Uint8Array
  readonly value: bigint
  readonly networkId: string
  readonly ttlSecs: number
  /** A synced DUST state — see {@link spendableDustAt}. */
  readonly dustState: DustStateBytes
  readonly dustRoleKey: Uint8Array
  /** The instant the fee is priced and the DUST valued at. Unix seconds. */
  readonly ctimeSecs: number
  /** Holds `spend.{bzkir,prover,verifier}` for the dust circuit — `ensureDustArtifacts`. */
  readonly artifactDir: string
  /** Holds `bls_midnight_2p13`. */
  readonly paramsDir: string
  /**
   * Exponent for the ledger's `fees_with_margin`.
   *
   * A fee depends on the transaction's size and the dust action that pays it makes the transaction
   * bigger, so the figure is circular; the margin covers that and the dust price moving between
   * building and inclusion. `2` unless there is a reason.
   */
  readonly feeMargin?: number
  /**
   * How many outputs to return change in. Omitted or `1` keeps a single change output.
   *
   * ⚠️ A DUST generation's rate *and* cap are proportional to the value of the one NIGHT UTxO backing
   * it, and a fee must be covered by a **single** DUST output — so one large UTxO gives a wallet
   * exactly one output that can ever pay. Splitting change is how it keeps several. The caller decides
   * the count because it is the side that knows the current UTxO set and what a chunk must be worth.
   */
  readonly changeChunks?: number
}): Promise<SelfFundedTransfer> => {
  const json = await native().walletBuildSelfFundedTransfer({
    nightRoleKeyHex: toHex(params.nightRoleKey),
    inputsHex: packUnshieldedInputs(params.inputs),
    recipientAddressHex: toHex(params.recipientAddress),
    tokenTypeHex: toHex(params.tokenType),
    valueLeHex: valueToLeHex(params.value),
    networkId: params.networkId,
    ttlSecs: params.ttlSecs,
    dustStateHex: toHex(params.dustState),
    dustRoleKeyHex: toHex(params.dustRoleKey),
    ctimeSecs: params.ctimeSecs,
    artifactDir: params.artifactDir,
    paramsDir: params.paramsDir,
    feeMargin: params.feeMargin ?? 2,
    changeChunks: params.changeChunks ?? 1,
  })
  const parsed = JSON.parse(json) as {tx?: unknown; state?: unknown; fee?: unknown; identifiers?: unknown}
  if (typeof parsed.tx !== 'string' || typeof parsed.state !== 'string' || typeof parsed.fee !== 'string') {
    // A fee that crossed as a number would have rounded past 2^53; a missing state would be silently
    // dropped and the next transfer would reuse the spent output.
    throw new Error(`a self-funded transfer must return tx, state and fee as strings: ${json.slice(0, 120)}`)
  }
  if (!/^\d+$/.test(parsed.fee)) throw new Error(`a fee must be a decimal string, got ${parsed.fee}`)
  // ⚠️ **The identifiers come from here, not from the returned bytes.** They are read inside the builder
  // before it seals: `provenTxIdentifiers` deserializes a `ProvenTx` (`embedded-fr`) and a sealed
  // transaction is `pedersen-schnorr`, so reading them afterwards fails and every self-funded send was
  // untrackable. Required rather than optional — a builder that stopped returning them would otherwise
  // reintroduce that silently.
  if (!Array.isArray(parsed.identifiers) || parsed.identifiers.some((id) => typeof id !== 'string')) {
    throw new Error(`a self-funded transfer must return its identifiers: ${json.slice(0, 120)}`)
  }
  return {
    transaction: fromHex(parsed.tx),
    dustState: fromHex(parsed.state),
    fee: BigInt(parsed.fee),
    identifiers: parsed.identifiers as readonly string[],
  }
}

/** A transaction somebody else built, with this wallet's DUST paying for it. */
export type DustFeePayment = {
  /** Sealed and submittable as-is. Nobody else has to bind it. */
  readonly transaction: Uint8Array
  /**
   * The DUST state with the spent output pending.
   *
   * ⚠️ **Persist this, not the one you passed in.** Keeping the old state would let the next fee pick
   * the same output, and the ledger rejects the pair.
   */
  readonly dustState: DustStateBytes
  /** What the transaction costs, in SPECK. */
  readonly fee: bigint
  /**
   * What *this wallet* contributed. Less than {@link fee} when the transaction already carried DUST of
   * its own — a partly-funded multi-party transaction does — and equal to it otherwise. `0n` means
   * nothing was owed and no dust action was attached, so {@link dustState} came back unchanged.
   */
  readonly paid: bigint
  /** The segment the fee intent landed at. Never 0, and never one the caller already occupies. */
  readonly segment: number
  /**
   * The transaction's identifiers, read **before** the seal.
   *
   * ⚠️ They cannot be recovered from {@link transaction}: `provenTxIdentifiers` deserializes a
   * `ProvenTx`, whose header is `embedded-fr`, and a sealed transaction is `pedersen-schnorr`.
   */
  readonly identifiers: readonly string[]
}

/**
 * Pay any unbound transaction's DUST fee from this wallet — whoever built it.
 *
 * The sponsor's job, done locally, and deliberately indifferent to provenance: the transaction may
 * come from a dApp over the connector, an agent over MCP, another of this app's wallets, or a wholly
 * different seed phrase. Nothing about its author is needed, because the fee does not go *into* the
 * caller's intent — it rides in an intent of our own at a free segment, and the ledger accounts DUST
 * transaction-wide at segment 0 whichever intent carries the spend.
 *
 * That is why no signature of the caller's is disturbed. `Intent::sign` covers the proof- and
 * signature-erased intent, so adding an unshielded *input* to somebody's intent voids their signatures
 * (see `walletBalanceUnsealedTransaction`, which refuses exactly that); adding a separate intent
 * touches nothing. It is the same shape the sponsor uses server-side, where the fee rides in a
 * separate balancing transaction that is merged in.
 *
 * It **proves** (`midnight/dust/spend`, K=13) and **seals**, so it takes artifact directories and
 * costs real CPU — measured at 278 ms on a host in release for a transfer, merge and seal included.
 *
 * ⚠️ **The transaction must arrive pre-binding.** Merging sums the two halves' binding randomness and
 * sealing consumes it, so a transaction that is already sealed cannot be paid for — it comes back as
 * "not a proven, signature-enabled, pre-binding transaction".
 */
export const walletPayFeeFromDust = async (params: {
  /** Proven, signature-enabled, pre-binding bytes — whoever built them. */
  readonly transaction: Uint8Array
  /**
   * A **synced** DUST state. The spend's circuit proves membership against the chain's own commitment
   * and generation roots, so a fast-synced state cannot produce a valid spend.
   */
  readonly dustState: DustStateBytes
  readonly dustRoleKey: Uint8Array
  /**
   * The instant the DUST is valued at, Unix seconds. The node refuses a `ctime` in the future or older
   * than the dust grace period, so this must be close to now.
   */
  readonly ctimeSecs: number
  /** TTL of the fee intent, Unix seconds. */
  readonly ttlSecs: number
  /** Holds `spend.{bzkir,prover,verifier}` for the dust circuit — `ensureDustArtifacts`. */
  readonly artifactDir: string
  /** Holds `bls_midnight_2p13`. */
  readonly paramsDir: string
  /**
   * Exponent for the ledger's `fees_with_margin`, absorbing the dust price moving between building and
   * inclusion. The fee intent's own size is measured rather than estimated, so this covers drift
   * alone. `2` unless there is a reason.
   */
  readonly feeMargin?: number
}): Promise<DustFeePayment> => {
  const json = await native().walletPayFeeFromDust({
    transactionHex: toHex(params.transaction),
    dustStateHex: toHex(params.dustState),
    dustRoleKeyHex: toHex(params.dustRoleKey),
    ctimeSecs: params.ctimeSecs,
    ttlSecs: params.ttlSecs,
    artifactDir: params.artifactDir,
    paramsDir: params.paramsDir,
    feeMargin: params.feeMargin ?? 2,
  })
  const parsed = JSON.parse(json) as {
    tx?: unknown
    state?: unknown
    fee?: unknown
    paid?: unknown
    segment?: unknown
    identifiers?: unknown
  }
  if (
    typeof parsed.tx !== 'string' ||
    typeof parsed.state !== 'string' ||
    typeof parsed.fee !== 'string' ||
    typeof parsed.paid !== 'string'
  ) {
    // Amounts cross as strings because either would round past 2^53 as a number, and a missing state
    // would be silently dropped — the next fee would then reuse the output this one spent.
    throw new Error(`a dust fee payment must return tx, state, fee and paid as strings: ${json.slice(0, 120)}`)
  }
  if (!/^\d+$/.test(parsed.fee) || !/^\d+$/.test(parsed.paid)) {
    throw new Error(`fee and paid must be decimal strings, got ${parsed.fee} and ${parsed.paid}`)
  }
  if (typeof parsed.segment !== 'number') {
    throw new Error(`a dust fee payment must report the segment it used: ${json.slice(0, 120)}`)
  }
  // Required rather than optional: read after the seal they are unrecoverable, so a builder that
  // stopped returning them would make every paid transaction untrackable in silence.
  if (!Array.isArray(parsed.identifiers) || parsed.identifiers.some((id) => typeof id !== 'string')) {
    throw new Error(`a dust fee payment must return its identifiers: ${json.slice(0, 120)}`)
  }
  return {
    transaction: fromHex(parsed.tx),
    dustState: fromHex(parsed.state),
    fee: BigInt(parsed.fee),
    paid: BigInt(parsed.paid),
    segment: parsed.segment,
    identifiers: parsed.identifiers as readonly string[],
  }
}

/**
 * Register this wallet's NIGHT for DUST generation — or deregister it.
 *
 * The cheap half of the DUST rail: a registration is a **signed declaration, not a circuit**
 * (`DustActions::prove` touches only spends), so this needs no artifacts, no SRS and no proving time.
 *
 * 🔑 **It funds itself.** The ledger credits `allow_fee_payment` to the DUST balance, so the
 * registration authorises its own fee out of the DUST its NIGHT projects to generate — which is how a
 * wallet with no DUST at all can ever get any. No sponsor, and no synced state needed. It comes back
 * **sealed** and submittable for the same reason: nothing else has to be added to it.
 *
 * ⚠️ **`nightInputs` is what makes that work, and omitting it fails every time.** The ledger backs the
 * allowance only with NIGHT this very transaction spends in its *guaranteed* offer — NIGHT merely held
 * by the wallet counts for nothing. Pass the wallet's own NIGHT UTxOs and they are spent back to it;
 * pass none and the node refuses with `InsufficientDustForRegistrationFee`, whatever the balance.
 *
 * ⚠️ **The projection still has to exist.** Each input allows only what it has generated since it was
 * created — `dt × value × decay`, capped — so **freshly received NIGHT projects almost nothing** and a
 * just-funded wallet still has to wait. That is the chain's design and no wallet shortens it.
 *
 * ⚠️ **Few inputs.** They go in the guaranteed segment because the ledger reads no other, and NIGHT
 * there saturates the time-to-dismiss budget at about four (see `unshielded.ts`). A registration needs
 * enough projection for one fee, not the whole balance.
 *
 * `register: false` deregisters, which is the same transaction with the binding removed and no inputs.
 */
export const dustRegister = async (params: {
  /** Role-0 (Night) key — it owns the NIGHT and signs the registration. */
  readonly nightRoleKey: Uint8Array
  /** Role-1 (Dust) key — the address the generated DUST is bound to. */
  readonly dustRoleKey: Uint8Array
  readonly register: boolean
  readonly networkId: string
  readonly ttlSecs: number
  readonly ctimeSecs: number
  /** Margin exponent for the ledger's `fees_with_margin`. `2` unless there is a reason. */
  readonly feeMargin?: number
  /** NIGHT UTxOs this wallet owns, spent back to itself so they can back the fee allowance. */
  readonly nightInputs: readonly UnshieldedSpend[]
}): Promise<DustRegistrationTx> =>
  parseDustRegistration(
    await native().walletReadOp(
      'dust:register',
      '',
      toHex(params.nightRoleKey),
      registerArg({
        dustRoleKey: params.dustRoleKey,
        register: params.register,
        ttlSecs: params.ttlSecs,
        ctimeSecs: params.ctimeSecs,
        feeMargin: params.feeMargin ?? 2,
        nightInputs: params.nightInputs,
        networkId: params.networkId,
      }),
    ),
  )

/**
 * Which handle tiers the payment contract is currently selling, and for how much.
 *
 * `currency` is a token colour to probe for a priced row — {@link NIGHT_COLOUR} for NIGHT. Omitting it
 * asks only what is free, which is cheaper to *interpret*, not to compute: a client that shows prices
 * has to name the currency it is pricing in, because the map is keyed by a hash of it and the contract
 * cannot be asked "what currencies do you take".
 *
 * Rides `walletReadOp`, so it costs no bridge halves and needs neither a key nor a path.
 */
export const paymentTierOffers = async (
  paymentState: Uint8Array,
  currency?: Uint8Array,
): Promise<readonly TierOffer[]> => {
  if (currency !== undefined && currency.length !== 32) {
    throw new Error(`a currency colour is 32 bytes, got ${currency.length}`)
  }
  return parseTierOffers(
    await native().walletReadOp(
      'payment:tiers',
      toHex(paymentState),
      NO_KEY,
      currency === undefined ? '' : toHex(currency),
    ),
  )
}

/**
 * What a handle contract holds — who owns the name, and whether it still counts.
 *
 * ⚠️ **One half of handle validity.** `owner` says who bound the name; displaying it also requires that
 * identity's `primaryName` to fold back to this name, and the handle to be neither banned nor burned.
 * See {@link HandleRecord.owner}.
 *
 * Rides `walletReadOp`, so it costs no bridge halves and needs neither a key nor a path.
 */
export const handleRecord = async (handleState: Uint8Array): Promise<HandleRecord> =>
  parseHandleRecord(await native().walletReadOp('handle:record', toHex(handleState), NO_KEY, ''))

/** What every handle-contract call needs to name the contract it is talking to. */
export type HandleContractInputs = {
  readonly artifacts: CircuitArtifactPaths
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly identitySk: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}

/**
 * Build a proven-unbound `claimFreePermit` transaction — a tier permit out of the free tier.
 *
 * Unlike every other call on this rail the result needs no input of its own: the circuit spends
 * nothing, so the sponsor's fee segment is all it takes to submit. The permit arrives at `recipient` as
 * an ordinary unshielded UTxO, which the later `bind` spends.
 *
 * ⚠️ `recipient` is **disclosed on chain**, and `bind` ties that permit to the name — so pass a fresh
 * receive address unless the handle is meant to be publicly linked to the wallet's main one.
 */
export const buildClaimFreePermitProvenTx = async (inputs: {
  readonly artifacts: CircuitArtifactPaths
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly tier: number
  readonly recipient: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}): Promise<Uint8Array> => {
  if (!Number.isInteger(inputs.tier) || inputs.tier < 0 || inputs.tier > 6) {
    throw new Error(`tier must be an integer 0..6, got ${inputs.tier}`)
  }
  return fromHex(
    await native().buildClaimFreePermitProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      tier: inputs.tier,
      recipientHex: toHex(inputs.recipient),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
}

/**
 * Build a proven-unbound `bind` transaction — claim a handle.
 *
 * ⚠️ **The result does not balance.** `bind` spends a tier permit, so the caller has to add that UTxO
 * as an unshielded input before submitting. That is deliberate: a permit is an ordinary ledger UTxO,
 * so funding it is the wallet's job rather than this builder's.
 */
export const buildBindProvenTx = async (inputs: HandleContractInputs): Promise<Uint8Array> =>
  fromHex(
    await native().buildBindProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      identitySkHex: toHex(inputs.identitySk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/** Build a proven-unbound `rebind` transaction — hand a handle to another identity. */
export const buildRebindProvenTx = async (
  inputs: HandleContractInputs & {readonly newOwner: Uint8Array},
): Promise<Uint8Array> =>
  fromHex(
    await native().buildRebindProvenTx({
      zkirPath: inputs.artifacts.zkirPath,
      proverKeyPath: inputs.artifacts.proverKeyPath,
      verifierKeyPath: inputs.artifacts.verifierKeyPath,
      paramsPath: inputs.artifacts.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      newOwnerHex: toHex(inputs.newOwner),
      identitySkHex: toHex(inputs.identitySk),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * The address a handle contract deploys to, derived from its **canonical** name.
 *
 * This is what makes a name lookup free: hash the name, get the address, ask the indexer whether
 * anything is there. Nothing is downloaded to discover that a name is taken, and a second claim of one
 * name derives the same address and is refused on chain as `ContractAlreadyDeployed`.
 *
 * ⚠️ `name` is the **folded** spelling (`encodeHandle`), never the display one — that is what makes
 * `Alice` and `alice` one contract rather than two.
 */
export const handleAddress = async (inputs: {
  readonly keysDir: string
  readonly name: Uint8Array
  readonly payment: Uint8Array
}): Promise<Uint8Array> =>
  fromHex(
    await native().handleAddress({
      keysDir: inputs.keysDir,
      nameHex: toHex(inputs.name),
      paymentHex: toHex(inputs.payment),
    }),
  )

/** The address an identity contract deploys to, derived from `C`. */
export const identityAddress = async (inputs: {
  readonly keysDir: string
  readonly c: Uint8Array
}): Promise<Uint8Array> => fromHex(await native().identityAddress({keysDir: inputs.keysDir, cHex: toHex(inputs.c)}))

/**
 * A member's merkle path, read out of a circle's contract state.
 *
 * ⚠️ **Pass the state as of the proposal's own height, not the current one.** A proposal seals its
 * electorate's root at creation, so a path read from a later state — after one more join — has a
 * different root and the circuit refuses it. The indexer serves historic contract state
 * (`contractAction(address, offset:)`), which is what makes this a read rather than a mirror.
 *
 * Returns the 660 bytes {@link encodeMemberPath} describes, ready for the vote builders.
 */
export const circleMemberPath = async (inputs: {
  readonly contractState: Uint8Array
  readonly leaf: Uint8Array
}): Promise<Uint8Array> =>
  fromHex(
    await native().circleMemberPath({
      contractStateHex: toHex(inputs.contractState),
      leafHex: toHex(inputs.leaf),
    }),
  )

/**
 * A moderator's merkle path out of a circle's contract state, `10 × 33` bytes.
 *
 * ⚠️ **The one missing link in invite issuance.** `setInvite` and `addModerator` both take a
 * moderator path, `moderator_path` has been in Rust since the moderation port, and no layer above
 * it exposed a way to *compute* one — so the builders could be called only with a path nothing
 * could produce. That is why a founder could create a gated circle and never mint a code for it.
 *
 * Half the depth of {@link circleMemberPath}: `moderators` is a `HistoricMerkleTree<10, …>` and a
 * 20-entry path hashes to a root `requireModerator` does not match.
 */
export const circleModeratorPath = async (inputs: {
  readonly contractState: Uint8Array
  readonly leaf: Uint8Array
}): Promise<Uint8Array> =>
  fromHex(
    await native().circleModeratorPath({
      contractStateHex: toHex(inputs.contractState),
      leafHex: toHex(inputs.leaf),
    }),
  )

/**
 * The root of a circle's members tree, little-endian.
 *
 * Worth reading before proving: comparing it against the proposal's sealed `membersRoot` turns
 * "fetched the wrong height" into a sentence, where the alternative is a proof the node rejects for
 * reasons that name neither the height nor the root.
 */
export const circleMembersRoot = async (contractState: Uint8Array): Promise<Uint8Array> =>
  fromHex(await native().circleMembersRoot({contractStateHex: toHex(contractState)}))

/**
 * The commitment in a circle's `inviteAuthority` cell, or `undefined` when it has delegated to nobody.
 *
 * ⚠️ **`undefined` means "nobody", not "we could not tell".** A read failure rejects, as every binding
 * here does. Collapsing the two would let a UI tell a founder their delegation is off — and invite them
 * to redo a transaction — because a state fetch happened to fail.
 *
 * The contract is the only source for this. Whether the founder actually called `setInviteAuthority`
 * is not recorded anywhere else: the content plane caches the commitment it *would* use, which says
 * nothing about whether the circle accepted it.
 */
export const circleInviteAuthority = async (contractState: Uint8Array): Promise<Uint8Array | undefined> => {
  const hex = await native().circleInviteAuthority({contractStateHex: toHex(contractState)})
  return hex === '' ? undefined : fromHex(hex)
}

/**
 * Build an unproven, unbalanced deploy for this identity's own contract.
 *
 * One contract per identity, so this is the first transaction a new identity makes — a row cannot be
 * published until the shell it goes in exists. Unbalanced because the device holds no funds for a
 * deploy: the sponsor balances and submits it, the same relay `publishIdentityRow` uses.
 *
 * Returns the address as well as the transaction, and the address is derivable from `C` alone — so a
 * caller never has to trust anyone else's answer to "which contract did that create?", and a second
 * deploy of the same identity is refused on chain as `ContractAlreadyDeployed` rather than creating a
 * rival row.
 */
export const buildIdentityDeployTx = async (inputs: {
  readonly keysDir: string
  readonly c: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}): Promise<{readonly address: Uint8Array; readonly tx: Uint8Array}> => {
  const out = fromHex(
    await native().buildIdentityDeployTx({
      keysDir: inputs.keysDir,
      cHex: toHex(inputs.c),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
  return {address: out.slice(0, 32), tx: out.slice(32)}
}

/**
 * Build an unproven, unbalanced deploy for an unbound handle shell.
 *
 * Returns the address **and** the transaction, because a caller must never have to trust anyone else's
 * answer to "which contract did that create?" — and here the answer is checkable offline from the name.
 */
export const buildHandleDeployTx = async (inputs: {
  readonly keysDir: string
  readonly name: Uint8Array
  readonly payment: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}): Promise<{readonly address: Uint8Array; readonly tx: Uint8Array}> => {
  const out = fromHex(
    await native().buildHandleDeployTx({
      keysDir: inputs.keysDir,
      nameHex: toHex(inputs.name),
      paymentHex: toHex(inputs.payment),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
  // `address ‖ tx` — the bridge returns one buffer because a record of two byte arrays costs another
  // Record class on both platforms for no benefit.
  return {address: out.slice(0, 32), tx: out.slice(32)}
}

/**
 * A member's Merkle path as the bridge carries it: 20 x (32-byte little-endian sibling, 1 byte
 * `goes_left`) = 660 bytes.
 *
 * ⚠️ A proposal seals its electorate and holds **no tree**, so this is supplied rather than looked up.
 * The circuit's root comparison is the verification, which is what makes any source of the path safe —
 * the content plane, a peer, or a local mirror rebuilt from `join` transcripts.
 */
export const encodeMemberPath = (
  path: readonly {readonly sibling: {readonly field: bigint}; readonly goes_left: boolean}[],
): Uint8Array => {
  if (path.length !== 20) {
    throw new Error(`a member path has 20 entries, got ${path.length}`)
  }
  const out = new Uint8Array(20 * 33)
  path.forEach((entry, i) => {
    let v = entry.sibling.field
    for (let b = 0; b < 32; b++) {
      out[i * 33 + b] = Number(v & 0xffn)
      v >>= 8n
    }
    out[i * 33 + 32] = entry.goes_left ? 1 : 0
  })
  return out
}

/** A `Field` as the bridge carries it: 32 little-endian bytes, matching Rust's `Fr::as_le_bytes`. */
export const encodeFieldLe = (value: bigint): Uint8Array => {
  if (value < 0n) throw new Error('a field element is not negative')
  const out = new Uint8Array(32)
  let v = value
  for (let b = 0; b < 32; b++) {
    out[b] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('a field element does not fit in 32 bytes')
  return out
}

/** Inputs shared by both vote builders. */
type VoteTxCommon = {
  readonly zkirPath: string
  readonly proverKeyPath: string
  readonly verifierKeyPath: string
  readonly paramsPath: string
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly personaSk: Uint8Array
  /** `0 .. optionCount - 1`. The contract range-checks it against its sealed count on reveal. */
  readonly ballotOption: number
  readonly ballotRand: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}

/** Build a proven-unbound `castVote` transaction on-device. */
export const buildCastVoteProvenTx = async (
  inputs: VoteTxCommon & {readonly memberPath: Uint8Array},
): Promise<Uint8Array> =>
  fromHex(
    await native().buildCastVoteProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      personaSkHex: toHex(inputs.personaSk),
      ballotOption: inputs.ballotOption,
      ballotRandHex: toHex(inputs.ballotRand),
      memberPathHex: toHex(inputs.memberPath),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/** Build a proven-unbound `revealVote` transaction on-device. No member path is needed. */
export const buildRevealVoteProvenTx = async (inputs: VoteTxCommon): Promise<Uint8Array> =>
  fromHex(
    await native().buildRevealVoteProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      personaSkHex: toHex(inputs.personaSk),
      ballotOption: inputs.ballotOption,
      ballotRandHex: toHex(inputs.ballotRand),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/** What identifies a proposal: its circle, its content, and the electorate it sealed. */
export type ProposalDeployInputs = {
  readonly keysDir: string
  readonly circleId: Uint8Array
  /** The circle's members root at creation, little-endian. Use `encodeFieldLe`. */
  readonly membersRoot: Uint8Array
  readonly content: Uint8Array
  readonly author: Uint8Array
  readonly optionCount: number
}

/**
 * The address a proposal deploys to, derivable by anyone holding the circle id and the content
 * commitment — which is what lets a client find a proposal without a registry, and why
 * `createProposal` is not a circuit.
 */
export const proposalAddress = async (inputs: ProposalDeployInputs): Promise<Uint8Array> =>
  fromHex(
    await native().proposalAddress({
      keysDir: inputs.keysDir,
      circleIdHex: toHex(inputs.circleId),
      membersRootHex: toHex(inputs.membersRoot),
      contentHex: toHex(inputs.content),
      authorHex: toHex(inputs.author),
      optionCount: inputs.optionCount,
    }),
  )

/** Build an unproven, unbalanced proposal deploy. Returns the address **and** the transaction. */
export const buildProposalDeployTx = async (
  inputs: ProposalDeployInputs & {readonly networkId: string; readonly ttlSecs: number},
): Promise<{readonly address: Uint8Array; readonly tx: Uint8Array}> => {
  const out = fromHex(
    await native().buildProposalDeployTx({
      keysDir: inputs.keysDir,
      circleIdHex: toHex(inputs.circleId),
      membersRootHex: toHex(inputs.membersRoot),
      contentHex: toHex(inputs.content),
      authorHex: toHex(inputs.author),
      optionCount: inputs.optionCount,
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
  return {address: out.slice(0, 32), tx: out.slice(32)}
}

/** What a moderator-gated circuit needs beyond its own arguments. */
export type ModerationTxCommon = {
  readonly zkirPath: string
  readonly proverKeyPath: string
  readonly verifierKeyPath: string
  readonly paramsPath: string
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly personaSk: Uint8Array
  /**
   * The caller's path in `moderators` — **10 × 33 bytes**, half a member path.
   *
   * ⚠️ A member path passed here decodes and hashes to a root that matches nothing, which the circuit
   * reports as "not a moderator". `circle::moderator_path` reads it at the right height; the decoder
   * checks the depth rather than inferring it from the length.
   */
  readonly moderatorPath: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}

/** Issue or revoke a circle invite. `active` false requires the commitment to be present. */
export const buildSetInviteProvenTx = async (
  inputs: ModerationTxCommon & {readonly commitment: Uint8Array; readonly active: boolean},
): Promise<Uint8Array> =>
  fromHex(
    await native().buildSetInviteProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      personaSkHex: toHex(inputs.personaSk),
      moderatorPathHex: toHex(inputs.moderatorPath),
      commitmentHex: toHex(inputs.commitment),
      active: inputs.active,
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * Issue or revoke a circle invite **as the delegated authority**, not as a moderator.
 *
 * ⚠️ **No `moderatorPath`, and that is the whole point.** The authority is a commitment in the
 * circle's `inviteAuthority` cell rather than a leaf in `moderators`, so the caller needs no persona,
 * no member leaf and nothing to compute a path against — which is what lets an attestation service
 * issue invites without holding powers it can never be stripped of.
 *
 * Rejects by name before proving when the circle delegated to nobody, or when this secret is not its
 * authority.
 */
export const buildIssueInviteProvenTx = async (inputs: {
  readonly zkirPath: string
  readonly proverKeyPath: string
  readonly verifierKeyPath: string
  readonly paramsPath: string
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  /** The delegation's secret — `inviteAuthorityCommitment(authoritySk)` is what the circle stores. */
  readonly authoritySk: Uint8Array
  readonly commitment: Uint8Array
  readonly active: boolean
  readonly networkId: string
  readonly ttlSecs: number
}): Promise<Uint8Array> =>
  fromHex(
    await native().buildIssueInviteProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      authoritySkHex: toHex(inputs.authoritySk),
      commitmentHex: toHex(inputs.commitment),
      active: inputs.active,
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * Delegate invite issuance, rotate the delegate, or withdraw it. Moderator-gated.
 *
 * Pass **32 zero bytes** to withdraw. That revocability is why a circle delegates through this rather
 * than by promoting the attestor: `moderators` is insert-only, so a moderator grant is permanent for
 * the life of the circle.
 */
export const buildSetInviteAuthorityProvenTx = async (
  inputs: ModerationTxCommon & {
    /** `inviteAuthorityCommitment(sk)` of the new delegate, or 32 zero bytes to withdraw. */
    readonly authority: Uint8Array
  },
): Promise<Uint8Array> =>
  fromHex(
    await native().buildSetInviteAuthorityProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      personaSkHex: toHex(inputs.personaSk),
      moderatorPathHex: toHex(inputs.moderatorPath),
      authorityHex: toHex(inputs.authority),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * Serve one Compact-runtime leaf to the compactc-generated JS driver.
 *
 * ⚠️ **Not for application code.** This is the floor `@pnyx/compact-hermes` stands on — the WASM
 * leaves `@midnight-ntwrk/compact-runtime` cannot provide on Hermes V0. Call the runtime, not this.
 *
 * `op` names the leaf (`ctx.new`, `ctx.query`, `hash.persistent`, …); `args` and the result are
 * JSON, because a program is a recursive tagged union and hex would not carry it.
 */
export const compactOp = (op: string, args: string): string => native().compactOp(op, args)

/**
 * Leave a circle — blank your own leaf in `members`, authorised by holding the persona rather than by
 * moderating.
 *
 * ⚠️ **One-way, and the UI must say so before the tap.** `join` asserts against `joinedIdentities`
 * and nothing ever removes from that set, so this identity can never rejoin this circle — not even
 * with a fresh invite. The refusal surfaces far away, at a later `join`, as "identity already
 * joined". That set is what makes a ban permanent; leaving reuses the removal and inherits it.
 */
export const buildLeaveCircleProvenTx = async (inputs: {
  readonly zkirPath: string
  readonly proverKeyPath: string
  readonly verifierKeyPath: string
  readonly paramsPath: string
  readonly contractState: Uint8Array
  readonly contractAddress: Uint8Array
  readonly personaSk: Uint8Array
  /** The caller's own path in `members` — **20 × 33 bytes**, from `circleMemberPath`. */
  readonly memberPath: Uint8Array
  readonly networkId: string
  readonly ttlSecs: number
}): Promise<Uint8Array> =>
  fromHex(
    await native().buildLeaveCircleProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      personaSkHex: toHex(inputs.personaSk),
      memberPathHex: toHex(inputs.memberPath),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )

/**
 * Promote a member to moderator, recording the auth key their signatures are checked against. The
 * target must already be in `members`.
 */
export const buildAddModeratorProvenTx = async (
  inputs: ModerationTxCommon & {
    readonly targetLeaf: Uint8Array
    readonly memberPath: Uint8Array
    /** The promoted moderator's request-signing public key, stored in `moderatorAuth`. */
    readonly authPub: Uint8Array
  },
): Promise<Uint8Array> =>
  fromHex(
    await native().buildAddModeratorProvenTx({
      zkirPath: inputs.zkirPath,
      proverKeyPath: inputs.proverKeyPath,
      verifierKeyPath: inputs.verifierKeyPath,
      paramsPath: inputs.paramsPath,
      contractStateHex: toHex(inputs.contractState),
      contractAddressHex: toHex(inputs.contractAddress),
      personaSkHex: toHex(inputs.personaSk),
      moderatorPathHex: toHex(inputs.moderatorPath),
      targetLeafHex: toHex(inputs.targetLeaf),
      memberPathHex: toHex(inputs.memberPath),
      authPubHex: toHex(inputs.authPub),
      networkId: inputs.networkId,
      ttlSecs: inputs.ttlSecs,
    }),
  )
