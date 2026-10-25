package expo.modules.midnightnative

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * Arguments for a native proven-unbound tx build. A single Record keeps the JS↔native call to one
 * argument (Expo caps positional args at 8; this needs 10). Byte data is hex; artifacts are on-disk
 * paths (multi-MB, cached); `circleId` is 32 hex-encoded bytes (the contract's own id, not a
 * counter — the nullifiers hash it); `ttlSecs` is a number.
 */
class JoinTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var circleIdHex: String = ""
  /** Empty joins an open circle; a gated one needs the secret whose commitment was published. */
  @Field var inviteSecretHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/**
 * Deploying a circle. A circle is a contract, so creating one is a deploy: no artifacts and no
 * proving, because a constructor is not a circuit. `keysDir` holds every entry point's
 * `<name>.verifier`; the three constructor arguments are what the address commits to.
 */
class CircleDeployArgs : Record {
  @Field var keysDir: String = ""
  @Field var circleIdHex: String = ""
  @Field var isOpen: Boolean = false
  @Field var founderHex: String = ""
  @Field var founderAuthHex: String = ""
  @Field var founderJoinedHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/**
 * A shielded transfer. `valueLeHex` is a u128 little-endian — a JS number cannot carry a coin value, so
 * it crosses as bytes rather than as a number that would round.
 */
class ShieldedTransferArgs : Record {
  @Field var stateHex: String = ""
  @Field var zswapRoleKeyHex: String = ""
  @Field var recipientCoinPublicKeyHex: String = ""
  @Field var recipientEncryptionPublicKeyHex: String = ""
  @Field var colorHex: String = ""
  @Field var valueLeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
  @Field var artifactDir: String = ""
  @Field var paramsDir: String = ""
}

/**
 * An unshielded transfer. `inputsHex` is the packed UTxO set to spend — 84-byte records of
 * value(u128 LE) ‖ tokenType(32) ‖ intentHash(32) ‖ outputNo(u32 LE) — because a transfer spends a
 * variable number of outputs and this bridge marshals no lists.
 */
class UnshieldedTransferArgs : Record {
  @Field var nightRoleKeyHex: String = ""
  @Field var inputsHex: String = ""
  @Field var recipientAddressHex: String = ""
  @Field var tokenTypeHex: String = ""
  @Field var valueLeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
  /**
   * How many outputs to return change in; `0` or `1` keeps one. Spreading NIGHT across several UTxOs is
   * what gives a wallet several DUST generations, and a fee must be covered by a single DUST output.
   */
  @Field var changeChunks: Int = 0
}

/**
 * A transfer that pays its own DUST fee. The transfer half matches [UnshieldedTransferArgs]; the rest
 * is the DUST to pay with and the circuit material to prove the payment. `feeMargin` is the exponent
 * for the ledger's `fees_with_margin` — it covers both the dust action's own size and the dust price
 * moving between building and inclusion.
 */
class SelfFundedTransferArgs : Record {
  @Field var nightRoleKeyHex: String = ""
  @Field var inputsHex: String = ""
  @Field var recipientAddressHex: String = ""
  @Field var tokenTypeHex: String = ""
  @Field var valueLeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
  @Field var dustStateHex: String = ""
  @Field var dustRoleKeyHex: String = ""
  @Field var ctimeSecs: Long = 0
  @Field var artifactDir: String = ""
  @Field var paramsDir: String = ""
  @Field var feeMargin: Int = 2
  /**
   * How many outputs to return change in; `0` or `1` keeps one. Spreading NIGHT across several UTxOs is
   * what gives a wallet several DUST generations, and a fee must be covered by a single DUST output.
   */
  @Field var changeChunks: Int = 0
}

/**
 * Paying any unbound transaction's DUST fee from this wallet, whoever built it. Only the DUST side is
 * here — nothing about the transaction's author is needed, which is the point: the fee rides in an
 * intent of our own at a free segment and leaves the caller's untouched.
 */
class PayFeeFromDustArgs : Record {
  @Field var transactionHex: String = ""
  @Field var dustStateHex: String = ""
  @Field var dustRoleKeyHex: String = ""
  @Field var ctimeSecs: Long = 0
  @Field var ttlSecs: Long = 0
  @Field var artifactDir: String = ""
  @Field var paramsDir: String = ""
  @Field var feeMargin: Int = 2
}

/**
 * Funding a transaction a dApp composed. `inputsHex` is the same packed record format
 * [UnshieldedTransferArgs] uses, and it carries *candidates*: the native side spends the fewest that
 * cover what the ledger says the transaction owes, so passing more than needed is expected.
 */
/** Co-funding step 1: every contributor's inputs, packed, plus what the payment is. */
class CoFundedIntentArgs : Record {
  @Field var contributionsHex: String = ""
  @Field var recipientAddressHex: String = ""
  @Field var tokenTypeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Co-funding step 2: the finalised intent, and the key of the wallet signing its own inputs. */
class CoFundedShareArgs : Record {
  @Field var intentHex: String = ""
  @Field var nightRoleKeyHex: String = ""
}

/** Co-funding step 3: the same intent, and every gathered share. */
class CoFundedAssembleArgs : Record {
  @Field var intentHex: String = ""
  @Field var sharesHex: String = ""
  @Field var networkId: String = ""
}

class BalanceUnsealedArgs : Record {
  @Field var transactionHex: String = ""
  @Field var nightRoleKeyHex: String = ""
  @Field var inputsHex: String = ""
}

/** Publishing an identity row: the two rotatable keys and the identity secret. Naming is a separate
 *  circuit, deliberately — a third writer with no rules is how a primary handle stops meaning
 *  anything. */
class PublishRowTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var anchorHex: String = ""
  @Field var authPubHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Pointing at one of my handles, or at none. Unvalidated on chain: ownership lives in the per-name
 *  handle contract, so this cell is a claim readers must check both ways. */
class SetPrimaryNameTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var nameHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Claiming a handle. ⚠️ The transaction this builds does NOT balance: `bind` spends a tier permit,
 *  so the caller adds that UTxO as an unshielded input before submitting. */
/** A free-tier permit claim on the payment contract. `tier` is 0..6; the permit lands at
 *  `recipientHex` as an ordinary unshielded UTxO, which the later `bind` spends. */
class ClaimFreePermitTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var tier: Int = 0
  @Field var recipientHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

class BindTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Handing a handle over, on the current owner's authority. Spends a per-name rebind permit. */
class RebindTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var newOwnerHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Deriving a handle contract's address from its canonical name. `nameHex` is the FOLDED spelling —
 *  the display form derives a different address, which is what makes `Alice` and `alice` one name. */
class HandleAddressArgs : Record {
  @Field var keysDir: String = ""
  @Field var nameHex: String = ""
  @Field var paymentHex: String = ""
}

/** Voting on a proposal. `memberPathHex` is 20 x (32-byte LE sibling, 1 byte goes_left) = 660 bytes —
 *  the electorate is sealed, so the path is supplied rather than looked up. */
/** Issuing or revoking a circle invite. The moderator path is 10 x 33 bytes, half a member path. */
class SetInviteTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var moderatorPathHex: String = ""
  @Field var commitmentHex: String = ""
  @Field var active: Boolean = false
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** The delegated authority issuing or revoking. **No moderator path** — the authority is a ledger
 *  cell's preimage, not a leaf in `moderators`. */
class IssueInviteTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var authoritySkHex: String = ""
  @Field var commitmentHex: String = ""
  @Field var active: Boolean = false
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Delegating, rotating, or withdrawing invite issuance. Moderator-gated; 32 zero bytes withdraws. */
class SetInviteAuthorityTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var moderatorPathHex: String = ""
  @Field var authorityHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Leaving a circle. One path (20 x 33) and no gate — the persona authorises its own removal. */
class LeaveCircleTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var memberPathHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Promoting a member. Two paths, different heights: moderator 10 x 33, member 20 x 33. */
class AddModeratorTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var moderatorPathHex: String = ""
  @Field var targetLeafHex: String = ""
  @Field var memberPathHex: String = ""
  @Field var authPubHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

class CastVoteTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var ballotOption: Int = 0
  @Field var ballotRandHex: String = ""
  @Field var memberPathHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Opening a sealed ballot. No member path — the nullifier already proves the vote was cast. */
class RevealVoteTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var ballotOption: Int = 0
  @Field var ballotRandHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Deriving or deploying a proposal. `membersRootHex` is 32 little-endian bytes. */
class ProposalAddressArgs : Record {
  @Field var keysDir: String = ""
  @Field var circleIdHex: String = ""
  @Field var membersRootHex: String = ""
  @Field var contentHex: String = ""
  @Field var authorHex: String = ""
  @Field var optionCount: Int = 0
}

class ProposalDeployTxArgs : Record {
  @Field var keysDir: String = ""
  @Field var circleIdHex: String = ""
  @Field var membersRootHex: String = ""
  @Field var contentHex: String = ""
  @Field var authorHex: String = ""
  @Field var optionCount: Int = 0
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

class IdentityAddressArgs : Record {
  @Field var keysDir: String = ""
  @Field var cHex: String = ""
}

/** Deploying an identity's own shell. Returns `address ‖ tx`; the address is derivable from `C`. */
/** Reading a circle's membership tree. `stateHex` is whatever state the caller fetched. */
class CircleMemberPathArgs : Record {
  @Field var contractStateHex: String = ""
  @Field var leafHex: String = ""
}

/** The root of a circle's members tree, for comparing against a proposal's sealed root. */
class CircleMembersRootArgs : Record {
  @Field var contractStateHex: String = ""
}

class IdentityDeployTxArgs : Record {
  @Field var keysDir: String = ""
  @Field var cHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** Deploying an unbound handle shell. Returns `address ‖ tx`, so the caller never has to trust
 *  anyone else's answer to which contract it creates. */
class HandleDeployTxArgs : Record {
  @Field var keysDir: String = ""
  @Field var nameHex: String = ""
  @Field var paymentHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** One contact-card row. `valueHex` is the full 320-byte field — its length prefix and flags are the
 *  client's format, so it crosses as opaque bytes. Kind 0 clears the slot. */
class SetRowTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var slot: Int = 0
  @Field var kind: Int = 0
  @Field var valueHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/** A four-slot card save. Exactly four, because the template's width is fixed; `valuesHex` is the
 *  four 320-byte rows concatenated. */
class SetRowsTxArgs : Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var slots: List<Int> = emptyList()
  @Field var kinds: List<Int> = emptyList()
  @Field var valuesHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Long = 0
}

/**
 * Bridges the native Midnight key-derivation library (libmidnight_native.so, Rust) to JS.
 *
 * The three `external fun`s bind to the `Java_expo_modules_midnightnative_MidnightNativeModule_*`
 * symbols in the Rust JNI layer (rust/src/jni_bridge.rs). The exported `Function`s take/return hex
 * strings so the JS↔native boundary is plain strings (no typed-array marshalling). Inputs are the
 * 32-byte secp256k1 role keys (derived host-side via wallet-sdk-hd); outputs are the raw payloads.
 *
 * Loading is fail-soft: if the .so is absent (fresh checkout before scripts/build-android.sh, or
 * an ABI without a build yet) the module still registers, `isAvailable` returns false, and the
 * derivation functions throw a descriptive error instead of crashing app startup.
 */
class MidnightNativeModule : Module() {
  external fun nightPayload(key: ByteArray): ByteArray
  external fun dustPublicKey(key: ByteArray): ByteArray
  external fun shieldedPublicKeys(key: ByteArray): ByteArray
  external fun proveCircuit(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    preimage: ByteArray,
  ): ByteArray
  external fun circuitK(zkir: ByteArray): Int
  external fun checkPreimage(zkir: ByteArray, preimage: ByteArray): String
  external fun provePreimageWithBinding(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    preimage: ByteArray,
    bindingLeHex: String,
  ): ByteArray
  external fun buildJoinProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    circleId: ByteArray,
    inviteSecret: ByteArray?,
    identitySk: ByteArray,
    personaSk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray
  // A circle is a deploy, not a call: no artifacts and no proving. `keysDir` holds every entry
  // point's verifier key, and the address is a hash over the constructor's arguments.
  external fun buildCircleDeployTx(
    keysDir: String,
    circleId: ByteArray,
    isOpen: Boolean,
    founder: ByteArray,
    founderAuth: ByteArray,
    founderJoined: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun circleDeployAddress(
    keysDir: String,
    circleId: ByteArray,
    isOpen: Boolean,
    founder: ByteArray,
    founderAuth: ByteArray,
    founderJoined: ByteArray,
  ): ByteArray

  external fun buildPublishRowProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    anchor: ByteArray,
    authPub: ByteArray,
    identitySk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildSetPrimaryNameProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    name: ByteArray,
    identitySk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildClaimFreePermitProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    tier: Int,
    recipient: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildBindProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    identitySk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildRebindProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    newOwner: ByteArray,
    identitySk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun handleAddress(keysDir: String, name: ByteArray, payment: ByteArray): ByteArray

  external fun buildSetInviteProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    personaSk: ByteArray,
    moderatorPath: ByteArray,
    commitment: ByteArray,
    active: Boolean,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildIssueInviteProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    authoritySk: ByteArray,
    commitment: ByteArray,
    active: Boolean,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildSetInviteAuthorityProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    personaSk: ByteArray,
    moderatorPath: ByteArray,
    authority: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun compactOp(op: String, args: String): String

  external fun buildLeaveCircleProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    personaSk: ByteArray,
    memberPath: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildAddModeratorProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    personaSk: ByteArray,
    moderatorPath: ByteArray,
    targetLeaf: ByteArray,
    memberPath: ByteArray,
    authPub: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildCastVoteProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    personaSk: ByteArray,
    ballotOption: Int,
    ballotRand: ByteArray,
    memberPath: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildRevealVoteProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    personaSk: ByteArray,
    ballotOption: Int,
    ballotRand: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun proposalAddress(
    keysDir: String,
    circleId: ByteArray,
    membersRoot: ByteArray,
    content: ByteArray,
    author: ByteArray,
    optionCount: Int,
  ): ByteArray

  external fun buildProposalDeployTx(
    keysDir: String,
    circleId: ByteArray,
    membersRoot: ByteArray,
    content: ByteArray,
    author: ByteArray,
    optionCount: Int,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun identityAddress(keysDir: String, c: ByteArray): ByteArray

  external fun circleMemberPath(state: ByteArray, leaf: ByteArray): ByteArray

  external fun circleModeratorPath(state: ByteArray, leaf: ByteArray): ByteArray

  external fun circleMembersRoot(state: ByteArray): ByteArray

  /** Empty when the circle has delegated to nobody — a read failure throws instead. */
  external fun circleInviteAuthority(state: ByteArray): ByteArray

  external fun buildIdentityDeployTx(
    keysDir: String,
    c: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildHandleDeployTx(
    keysDir: String,
    name: ByteArray,
    payment: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildSetRowProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    slot: Int,
    kind: Int,
    value: ByteArray,
    identitySk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  external fun buildSetRowsProvenTx(
    zkirPath: String,
    proverKeyPath: String,
    verifierKeyPath: String,
    paramsPath: String,
    contractState: ByteArray,
    contractAddress: ByteArray,
    slots: IntArray,
    kinds: IntArray,
    values: ByteArray,
    identitySk: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): ByteArray

  // Shielded wallet state. Two exports, one per return shape: `walletStateOp` returns the new
  // serialized state, `walletReadOp` returns JSON. The op names live in the Rust match, which rejects
  // an unknown one rather than defaulting.
  external fun walletStateOp(op: String, state: ByteArray, zswapRoleKey: ByteArray, arg: ByteArray): ByteArray

  external fun walletReadOp(op: String, state: ByteArray, zswapRoleKey: ByteArray, arg: ByteArray): String

  // Build + prove a shielded transfer. JSON {"tx","state"}: the transaction to submit, and the state
  // with its spends pending — a caller that kept the first and dropped the second would build its next
  // transfer from the same coins.
  external fun walletBuildTransfer(
    state: ByteArray,
    zswapRoleKey: ByteArray,
    recipientCoinPublicKey: ByteArray,
    recipientEncryptionPublicKey: ByteArray,
    color: ByteArray,
    valueLe: ByteArray,
    networkId: String,
    ttlSecs: Long,
    artifactDir: String,
    paramsDir: String,
  ): String

  // Build + sign an unshielded transfer. Returns the proven, unbound transaction as hex — no
  // artifacts and no proving, because a transfer carries no circuit.
  external fun walletBuildUnshieldedTransfer(
    nightRoleKey: ByteArray,
    packedInputs: ByteArray,
    recipientAddress: ByteArray,
    tokenType: ByteArray,
    valueLe: ByteArray,
    networkId: String,
    ttlSecs: Long,
    changeChunks: Int,
  ): String

  // Build a transfer that pays its own DUST fee. Returns JSON {"tx","state","fee"}. Proves the K=13
  // dust spend circuit and seals, so unlike walletBuildUnshieldedTransfer this costs real CPU.
  external fun walletBuildSelfFundedTransfer(
    nightRoleKey: ByteArray,
    packedInputs: ByteArray,
    recipientAddress: ByteArray,
    tokenType: ByteArray,
    valueLe: ByteArray,
    networkId: String,
    ttlSecs: Long,
    dustState: ByteArray,
    dustRoleKey: ByteArray,
    ctimeSecs: Long,
    artifactDir: String,
    paramsDir: String,
    feeMargin: Int,
    changeChunks: Int,
  ): String

  // Pay any unbound transaction's DUST fee from this wallet. Returns JSON
  // {"tx","state","fee","paid","segment","identifiers"}. Proves the K=13 dust spend circuit, merges
  // and seals, so like walletBuildSelfFundedTransfer this costs real CPU.
  external fun walletPayFeeFromDust(
    transaction: ByteArray,
    dustState: ByteArray,
    dustRoleKey: ByteArray,
    ctimeSecs: Long,
    ttlSecs: Long,
    artifactDir: String,
    paramsDir: String,
    feeMargin: Int,
  ): String

  // Co-funding, the three steps in order. See rust/src/cofunded.rs: the intent must be FINAL before
  // anyone signs, because inputs sort and every signature is bound to its input's index.
  external fun walletBuildCoFundedIntent(
    packedContributions: ByteArray,
    recipientAddress: ByteArray,
    tokenType: ByteArray,
    networkId: String,
    ttlSecs: Long,
  ): String

  // Signs only the inputs this key owns; "" means this wallet owns none of them, which is an answer.
  external fun walletSignCoFundedShare(intent: ByteArray, nightRoleKey: ByteArray): String

  external fun walletAssembleCoFundedTx(
    intent: ByteArray,
    packedShares: ByteArray,
    networkId: String,
  ): String

  // Fund the deficits of a transaction a dApp composed and sign the intents that changed. Returns the
  // funded, still-unbound transaction as hex. No artifacts and no proving: it arrives proven.
  external fun walletBalanceUnsealedTransaction(
    transaction: ByteArray,
    nightRoleKey: ByteArray,
    packedInputs: ByteArray,
  ): String

  // One Pnyx identity row from contract state the TS layer fetched (from the indexer directly, so
  // no service learns the lookup). JSON, or the string `null` for an unpublished identity.
  external fun identityRow(state: ByteArray, identity: ByteArray): String

  /** The `C` holding a handle, as 64 hex characters, or "" when unclaimed. */
  external fun nameOwner(state: ByteArray, name: ByteArray): String



  override fun definition() = ModuleDefinition {
    Name("MidnightNative")
    Function("isAvailable") { libraryLoaded }
    Function("nightPayload") { keyHex: String -> requireLibrary(); nightPayload(hexToBytes(keyHex)).toHex() }
    Function("dustPublicKey") { keyHex: String -> requireLibrary(); dustPublicKey(hexToBytes(keyHex)).toHex() }
    Function("circuitK") { zkirHex: String -> requireLibrary(); circuitK(hexToBytes(zkirHex)) }
    Function("shieldedPublicKeys") { keyHex: String ->
      requireLibrary()
      shieldedPublicKeys(hexToBytes(keyHex)).toHex()
    }
    // Proving is CPU-bound for ~1-3s at K=14/15 — AsyncFunction keeps it off the JS thread.
    // Static artifacts travel as file paths (multi-MB, cached on device); only the per-call
    // preimage and the returned proof cross the bridge, hex-encoded like the functions above.
    // The dApp connector's proving provider. `check` needs the ZKIR alone and is milliseconds, so it
    // takes bytes; `prove` keeps the multi-MB artifacts on paths like proveCircuit does.
    AsyncFunction("checkPreimage") { zkirHex: String, preimageHex: String ->
      requireLibrary()
      checkPreimage(hexToBytes(zkirHex), hexToBytes(preimageHex))
    }
    AsyncFunction("provePreimageWithBinding") {
      zkirPath: String,
      proverKeyPath: String,
      verifierKeyPath: String,
      paramsPath: String,
      preimageHex: String,
      bindingLeHex: String,
      ->
      requireLibrary()
      provePreimageWithBinding(
        zkirPath,
        proverKeyPath,
        verifierKeyPath,
        paramsPath,
        hexToBytes(preimageHex),
        bindingLeHex,
      ).toHex()
    }
    AsyncFunction("proveCircuit") {
      zkirPath: String,
      proverKeyPath: String,
      verifierKeyPath: String,
      paramsPath: String,
      preimageHex: String,
      ->
      requireLibrary()
      proveCircuit(zkirPath, proverKeyPath, verifierKeyPath, paramsPath, hexToBytes(preimageHex)).toHex()
    }
    // Build a proven-unbound join transaction on-device (build preimage → tx-level prove
    // → serialize). Static artifacts as paths; live state/address/witness as hex; returns the
    // tagged tx bytes (hex) to POST to /chain/submit. CPU-bound seconds — off the JS thread.
    AsyncFunction("buildJoinProvenTx") { args: JoinTxArgs ->
      requireLibrary()
      buildJoinProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.circleIdHex),
        // null, not empty bytes: absence is the open arm, and the native side branches on the
        // pointer being null rather than on a sentinel value it would have to recognise.
        if (args.inviteSecretHex.isEmpty()) null else hexToBytes(args.inviteSecretHex),
        hexToBytes(args.identitySkHex),
        hexToBytes(args.personaSkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildCircleDeployTx") { args: CircleDeployArgs ->
      requireLibrary()
      buildCircleDeployTx(
        args.keysDir,
        hexToBytes(args.circleIdHex),
        args.isOpen,
        hexToBytes(args.founderHex),
        hexToBytes(args.founderAuthHex),
        hexToBytes(args.founderJoinedHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("circleDeployAddress") { args: CircleDeployArgs ->
      requireLibrary()
      circleDeployAddress(
        args.keysDir,
        hexToBytes(args.circleIdHex),
        args.isOpen,
        hexToBytes(args.founderHex),
        hexToBytes(args.founderAuthHex),
        hexToBytes(args.founderJoinedHex),
      ).toHex()
    }
    AsyncFunction("buildPublishRowProvenTx") { args: PublishRowTxArgs ->
      requireLibrary()
      buildPublishRowProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.anchorHex),
        hexToBytes(args.authPubHex),
        hexToBytes(args.identitySkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildSetPrimaryNameProvenTx") { args: SetPrimaryNameTxArgs ->
      requireLibrary()
      buildSetPrimaryNameProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.nameHex),
        hexToBytes(args.identitySkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildClaimFreePermitProvenTx") { args: ClaimFreePermitTxArgs ->
      requireLibrary()
      buildClaimFreePermitProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        args.tier,
        hexToBytes(args.recipientHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildBindProvenTx") { args: BindTxArgs ->
      requireLibrary()
      buildBindProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.identitySkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildRebindProvenTx") { args: RebindTxArgs ->
      requireLibrary()
      buildRebindProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.newOwnerHex),
        hexToBytes(args.identitySkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    // Pure derivations: no proving, no network, no artifacts beyond the verifier keys. Cheap enough
    // to be a `Function`, but they read files, so they stay async like every other path-taking op.
    AsyncFunction("handleAddress") { args: HandleAddressArgs ->
      requireLibrary()
      handleAddress(
        args.keysDir,
        hexToBytes(args.nameHex),
        hexToBytes(args.paymentHex),
      ).toHex()
    }
    AsyncFunction("buildSetInviteProvenTx") { args: SetInviteTxArgs ->
      requireLibrary()
      buildSetInviteProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.personaSkHex),
        hexToBytes(args.moderatorPathHex),
        hexToBytes(args.commitmentHex),
        args.active,
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildIssueInviteProvenTx") { args: IssueInviteTxArgs ->
      requireLibrary()
      buildIssueInviteProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.authoritySkHex),
        hexToBytes(args.commitmentHex),
        args.active,
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildSetInviteAuthorityProvenTx") { args: SetInviteAuthorityTxArgs ->
      requireLibrary()
      buildSetInviteAuthorityProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.personaSkHex),
        hexToBytes(args.moderatorPathHex),
        hexToBytes(args.authorityHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    // ⚠️ **Synchronous on purpose.** The compactc-generated driver and every layer of
    // `compact-runtime` are synchronous — `queryLedgerState` returns a value, it does not await one
    // — so an AsyncFunction here could not be called from where it is needed at all.
    Function("compactOp") { op: String, args: String ->
      requireLibrary()
      compactOp(op, args)
    }
    AsyncFunction("buildLeaveCircleProvenTx") { args: LeaveCircleTxArgs ->
      requireLibrary()
      buildLeaveCircleProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.personaSkHex),
        hexToBytes(args.memberPathHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildAddModeratorProvenTx") { args: AddModeratorTxArgs ->
      requireLibrary()
      buildAddModeratorProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.personaSkHex),
        hexToBytes(args.moderatorPathHex),
        hexToBytes(args.targetLeafHex),
        hexToBytes(args.memberPathHex),
        hexToBytes(args.authPubHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildCastVoteProvenTx") { args: CastVoteTxArgs ->
      requireLibrary()
      buildCastVoteProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.personaSkHex),
        args.ballotOption,
        hexToBytes(args.ballotRandHex),
        hexToBytes(args.memberPathHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildRevealVoteProvenTx") { args: RevealVoteTxArgs ->
      requireLibrary()
      buildRevealVoteProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        hexToBytes(args.personaSkHex),
        args.ballotOption,
        hexToBytes(args.ballotRandHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("proposalAddress") { args: ProposalAddressArgs ->
      requireLibrary()
      proposalAddress(
        args.keysDir,
        hexToBytes(args.circleIdHex),
        hexToBytes(args.membersRootHex),
        hexToBytes(args.contentHex),
        hexToBytes(args.authorHex),
        args.optionCount,
      ).toHex()
    }
    AsyncFunction("buildProposalDeployTx") { args: ProposalDeployTxArgs ->
      requireLibrary()
      buildProposalDeployTx(
        args.keysDir,
        hexToBytes(args.circleIdHex),
        hexToBytes(args.membersRootHex),
        hexToBytes(args.contentHex),
        hexToBytes(args.authorHex),
        args.optionCount,
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("identityAddress") { args: IdentityAddressArgs ->
      requireLibrary()
      identityAddress(args.keysDir, hexToBytes(args.cHex)).toHex()
    }
    AsyncFunction("circleMemberPath") { args: CircleMemberPathArgs ->
      requireLibrary()
      circleMemberPath(hexToBytes(args.contractStateHex), hexToBytes(args.leafHex)).toHex()
    }
    AsyncFunction("circleModeratorPath") { args: CircleMemberPathArgs ->
      requireLibrary()
      circleModeratorPath(hexToBytes(args.contractStateHex), hexToBytes(args.leafHex)).toHex()
    }
    AsyncFunction("circleMembersRoot") { args: CircleMembersRootArgs ->
      requireLibrary()
      circleMembersRoot(hexToBytes(args.contractStateHex)).toHex()
    }
    AsyncFunction("circleInviteAuthority") { args: CircleMembersRootArgs ->
      requireLibrary()
      circleInviteAuthority(hexToBytes(args.contractStateHex)).toHex()
    }
    AsyncFunction("buildIdentityDeployTx") { args: IdentityDeployTxArgs ->
      requireLibrary()
      buildIdentityDeployTx(
        args.keysDir,
        hexToBytes(args.cHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildHandleDeployTx") { args: HandleDeployTxArgs ->
      requireLibrary()
      buildHandleDeployTx(
        args.keysDir,
        hexToBytes(args.nameHex),
        hexToBytes(args.paymentHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildSetRowProvenTx") { args: SetRowTxArgs ->
      requireLibrary()
      buildSetRowProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        args.slot,
        args.kind,
        hexToBytes(args.valueHex),
        hexToBytes(args.identitySkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    AsyncFunction("buildSetRowsProvenTx") { args: SetRowsTxArgs ->
      requireLibrary()
      buildSetRowsProvenTx(
        args.zkirPath,
        args.proverKeyPath,
        args.verifierKeyPath,
        args.paramsPath,
        hexToBytes(args.contractStateHex),
        hexToBytes(args.contractAddressHex),
        args.slots.toIntArray(),
        args.kinds.toIntArray(),
        hexToBytes(args.valuesHex),
        hexToBytes(args.identitySkHex),
        args.networkId,
        args.ttlSecs,
      ).toHex()
    }
    // Async for the same reason as identityRow: a wallet state carrying thousands of coins is not
    // something to deserialize on the JS thread while a balance renders.
    AsyncFunction("walletStateOp") { op: String, stateHex: String, keyHex: String, argHex: String ->
      requireLibrary()
      walletStateOp(op, hexToBytes(stateHex), hexToBytes(keyHex), hexToBytes(argHex)).toHex()
    }
    AsyncFunction("walletReadOp") { op: String, stateHex: String, keyHex: String, argHex: String ->
      requireLibrary()
      walletReadOp(op, hexToBytes(stateHex), hexToBytes(keyHex), hexToBytes(argHex))
    }
    // Three circuits to prove, so seconds of CPU — async for the same reason the tx builders are.
    AsyncFunction("walletBuildTransfer") { args: ShieldedTransferArgs ->
      requireLibrary()
      walletBuildTransfer(
        hexToBytes(args.stateHex),
        hexToBytes(args.zswapRoleKeyHex),
        hexToBytes(args.recipientCoinPublicKeyHex),
        hexToBytes(args.recipientEncryptionPublicKeyHex),
        hexToBytes(args.colorHex),
        hexToBytes(args.valueLeHex),
        args.networkId,
        args.ttlSecs,
        args.artifactDir,
        args.paramsDir,
      )
    }
    // Milliseconds, not seconds — nothing is proved. Async anyway: it signs, and every caller
    // reaches it from an already-async keystore read.
    AsyncFunction("walletBuildUnshieldedTransfer") { args: UnshieldedTransferArgs ->
      requireLibrary()
      walletBuildUnshieldedTransfer(
        hexToBytes(args.nightRoleKeyHex),
        hexToBytes(args.inputsHex),
        hexToBytes(args.recipientAddressHex),
        hexToBytes(args.tokenTypeHex),
        hexToBytes(args.valueLeHex),
        args.networkId,
        args.ttlSecs,
        args.changeChunks,
      )
    }
    // Proving, so genuinely CPU-bound — the one transfer builder that is.
    AsyncFunction("walletBuildSelfFundedTransfer") { args: SelfFundedTransferArgs ->
      requireLibrary()
      walletBuildSelfFundedTransfer(
        hexToBytes(args.nightRoleKeyHex),
        hexToBytes(args.inputsHex),
        hexToBytes(args.recipientAddressHex),
        hexToBytes(args.tokenTypeHex),
        hexToBytes(args.valueLeHex),
        args.networkId,
        args.ttlSecs,
        hexToBytes(args.dustStateHex),
        hexToBytes(args.dustRoleKeyHex),
        args.ctimeSecs,
        args.artifactDir,
        args.paramsDir,
        args.feeMargin,
        args.changeChunks,
      )
    }
    // Proving, merging and sealing — the same cost shape as walletBuildSelfFundedTransfer.
    AsyncFunction("walletPayFeeFromDust") { args: PayFeeFromDustArgs ->
      requireLibrary()
      walletPayFeeFromDust(
        hexToBytes(args.transactionHex),
        hexToBytes(args.dustStateHex),
        hexToBytes(args.dustRoleKeyHex),
        args.ctimeSecs,
        args.ttlSecs,
        args.artifactDir,
        args.paramsDir,
        args.feeMargin,
      )
    }
    // Milliseconds too, and async for the same reason: it signs.
    AsyncFunction("walletBalanceUnsealedTransaction") { args: BalanceUnsealedArgs ->
      requireLibrary()
      walletBalanceUnsealedTransaction(
        hexToBytes(args.transactionHex),
        hexToBytes(args.nightRoleKeyHex),
        hexToBytes(args.inputsHex),
      )
    }
    // Async for the same reason as every other builder here: it signs, and on a phone that is long
    // enough to hold the JS thread.
    AsyncFunction("walletBuildCoFundedIntent") { args: CoFundedIntentArgs ->
      requireLibrary()
      walletBuildCoFundedIntent(
        hexToBytes(args.contributionsHex),
        hexToBytes(args.recipientAddressHex),
        hexToBytes(args.tokenTypeHex),
        args.networkId,
        args.ttlSecs,
      )
    }
    AsyncFunction("walletSignCoFundedShare") { args: CoFundedShareArgs ->
      requireLibrary()
      walletSignCoFundedShare(hexToBytes(args.intentHex), hexToBytes(args.nightRoleKeyHex))
    }
    AsyncFunction("walletAssembleCoFundedTx") { args: CoFundedAssembleArgs ->
      requireLibrary()
      walletAssembleCoFundedTx(hexToBytes(args.intentHex), hexToBytes(args.sharesHex), args.networkId)
    }
    // Async because deserializing Pnyx's state is ~20ms on a host and more on
    // a phone, which is too long to hold the JS thread while a chat list renders.
    AsyncFunction("identityRow") { stateHex: String, identityHex: String ->
      requireLibrary()
      identityRow(hexToBytes(stateHex), hexToBytes(identityHex))
    }
    AsyncFunction("nameOwner") { stateHex: String, nameHex: String ->
      requireLibrary()
      nameOwner(hexToBytes(stateHex), hexToBytes(nameHex))
    }
  }

  private fun requireLibrary() {
    if (!libraryLoaded) {
      throw IllegalStateException(
        "libmidnight_native.so is not bundled for this ABI — run packages/midnight-native/scripts/build-android.sh",
      )
    }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  companion object {
    val libraryLoaded: Boolean =
      try {
        System.loadLibrary("midnight_native")
        true
      } catch (e: UnsatisfiedLinkError) {
        false
      }

    private fun hexToBytes(s: String): ByteArray =
      ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }
}
