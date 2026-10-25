import ExpoModulesCore

// FFI into libmidnight_native (Rust static lib, vendored as MidnightNative.xcframework).
// The C contract lives in include/midnight_native.h; we bind the `#[no_mangle] extern "C"`
// symbols directly via @_silgen_name so no Clang modulemap / bridging header is needed.
//
// Key derivation: each takes a 32-byte secp256k1 role key and writes the raw payload to `out`.
// Return: 0 ok, 1 null ptr, 2 invalid night key, 3 serialization error.
//
// Tx assembly / proving (rust/src/c_bridge.rs): static artifacts travel as file paths, dynamic
// data as byte buffers; results come back as malloc'd buffers released via midnight_buffer_free.
// Return: 0 ok, 1 null ptr, 5 failed with a UTF-8 message in the error out-buffer.

@_silgen_name("midnight_night_payload")
private func ffi_night_payload(_ key: UnsafePointer<UInt8>, _ out: UnsafeMutablePointer<UInt8>) -> Int32

@_silgen_name("midnight_dust_public_key")
private func ffi_dust_public_key(_ key: UnsafePointer<UInt8>, _ out: UnsafeMutablePointer<UInt8>) -> Int32

@_silgen_name("midnight_shielded_public_keys")
private func ffi_shielded_public_keys(_ key: UnsafePointer<UInt8>, _ out: UnsafeMutablePointer<UInt8>) -> Int32

@_silgen_name("midnight_buffer_free")
private func ffi_buffer_free(_ ptr: UnsafeMutablePointer<UInt8>?, _ len: Int)

@_silgen_name("midnight_circuit_k")
private func ffi_circuit_k(
  _ zkir: UnsafePointer<UInt8>, _ zkirLen: Int,
  _ outK: UnsafeMutablePointer<UInt32>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_prove_circuit_files")
private func ffi_prove_circuit_files(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ preimage: UnsafePointer<UInt8>, _ preimageLen: Int,
  _ outProof: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outProofLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_check_preimage")
private func ffi_check_preimage(
  _ zkir: UnsafePointer<UInt8>, _ zkirLen: Int,
  _ preimage: UnsafePointer<UInt8>, _ preimageLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_prove_preimage_with_binding")
private func ffi_prove_preimage_with_binding(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ preimage: UnsafePointer<UInt8>, _ preimageLen: Int,
  _ bindingLe: UnsafePointer<UInt8>?,
  _ outProof: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outProofLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_join_proven_tx")
private func ffi_build_join_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ contractState: UnsafePointer<UInt8>, _ contractStateLen: Int,
  _ contractAddress: UnsafePointer<UInt8>, _ circleId: UnsafePointer<UInt8>,
  // Optional: nil joins an open circle, non-nil is the invite secret a gated one spends.
  _ inviteSecret: UnsafePointer<UInt8>?,
  _ identitySk: UnsafePointer<UInt8>, _ personaSk: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ outTx: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outTxLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_publish_row_proven_tx")
private func ffi_build_publish_row_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ contractState: UnsafePointer<UInt8>, _ contractStateLen: Int,
  _ contractAddress: UnsafePointer<UInt8>, _ anchor: UnsafePointer<UInt8>,
  _ authPub: UnsafePointer<UInt8>, _ identitySk: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ outTx: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outTxLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

// ── Circle deploy ──
// A circle is a contract, so creating one is a deploy: no proving, no per-circuit artifacts, just
// the constructor's arguments and the entry points' verifier keys read from a directory.

@_silgen_name("midnight_build_circle_deploy_tx")
private func ffi_build_circle_deploy_tx(
  _ keysDir: UnsafePointer<CChar>, _ circleId: UnsafePointer<UInt8>, _ isOpen: UInt8,
  _ founder: UnsafePointer<UInt8>, _ founderAuth: UnsafePointer<UInt8>,
  _ founderJoined: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ outTx: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outTxLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_circle_deploy_address")
private func ffi_circle_deploy_address(
  _ keysDir: UnsafePointer<CChar>, _ circleId: UnsafePointer<UInt8>, _ isOpen: UInt8,
  _ founder: UnsafePointer<UInt8>, _ founderAuth: UnsafePointer<UInt8>,
  _ founderJoined: UnsafePointer<UInt8>,
  _ outAddress: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outAddressLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32


// ── Shielded wallet state ──
// Two entry points, one per return shape: state ops return the new serialized state, reads return
// JSON. `state` and `arg` may be empty but the pointers must be non-null, so callers pass a
// one-element scratch buffer rather than nil for an empty argument.
@_silgen_name("midnight_wallet_state_op")
private func ffi_wallet_state_op(
  _ op: UnsafePointer<CChar>, _ state: UnsafePointer<UInt8>, _ stateLen: Int,
  _ zswapRoleKey: UnsafePointer<UInt8>, _ arg: UnsafePointer<UInt8>, _ argLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_wallet_build_transfer")
private func ffi_wallet_build_transfer(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ zswapRoleKey: UnsafePointer<UInt8>,
  _ recipientCoinPublicKey: UnsafePointer<UInt8>, _ recipientEncryptionPublicKey: UnsafePointer<UInt8>,
  _ recipientEncryptionPublicKeyLen: Int, _ color: UnsafePointer<UInt8>, _ valueLe: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64, _ artifactDir: UnsafePointer<CChar>,
  _ paramsDir: UnsafePointer<CChar>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_wallet_build_unshielded_transfer")
private func ffi_wallet_build_unshielded_transfer(
  _ nightRoleKey: UnsafePointer<UInt8>, _ packedInputs: UnsafePointer<UInt8>, _ packedInputsLen: Int,
  _ recipientAddress: UnsafePointer<UInt8>, _ tokenType: UnsafePointer<UInt8>,
  _ valueLe: UnsafePointer<UInt8>, _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_wallet_build_self_funded_transfer")
private func ffi_wallet_build_self_funded_transfer(
  _ nightRoleKey: UnsafePointer<UInt8>, _ packedInputs: UnsafePointer<UInt8>, _ packedInputsLen: Int,
  _ recipientAddress: UnsafePointer<UInt8>, _ tokenType: UnsafePointer<UInt8>,
  _ valueLe: UnsafePointer<UInt8>, _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ dustState: UnsafePointer<UInt8>, _ dustStateLen: Int, _ dustRoleKey: UnsafePointer<UInt8>,
  _ ctimeSecs: UInt64, _ artifactDir: UnsafePointer<CChar>, _ paramsDir: UnsafePointer<CChar>,
  _ feeMargin: Int, _ changeChunks: UInt32,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_wallet_pay_fee_from_dust")
private func ffi_wallet_pay_fee_from_dust(
  _ transaction: UnsafePointer<UInt8>, _ transactionLen: Int,
  _ dustState: UnsafePointer<UInt8>, _ dustStateLen: Int, _ dustRoleKey: UnsafePointer<UInt8>,
  _ ctimeSecs: UInt64, _ ttlSecs: UInt64, _ artifactDir: UnsafePointer<CChar>,
  _ paramsDir: UnsafePointer<CChar>, _ feeMargin: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_wallet_balance_unsealed_transaction")
private func ffi_wallet_balance_unsealed_transaction(
  _ transaction: UnsafePointer<UInt8>, _ transactionLen: Int, _ nightRoleKey: UnsafePointer<UInt8>,
  _ packedInputs: UnsafePointer<UInt8>, _ packedInputsLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_wallet_read_op")
private func ffi_wallet_read_op(
  _ op: UnsafePointer<CChar>, _ state: UnsafePointer<UInt8>, _ stateLen: Int,
  _ zswapRoleKey: UnsafePointer<UInt8>, _ arg: UnsafePointer<UInt8>, _ argLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_identity_row")
private func ffi_identity_row(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ identity: UnsafePointer<UInt8>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_set_primary_name_proven_tx")
private func ffi_build_set_primary_name_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ name: UnsafePointer<UInt8>, _ identitySk: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_claim_free_permit_proven_tx")
private func ffi_build_claim_free_permit_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ tier: UInt8, _ recipient: UnsafePointer<UInt8>, _ networkId: UnsafePointer<CChar>,
  _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_bind_proven_tx")
private func ffi_build_bind_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ identitySk: UnsafePointer<UInt8>, _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_rebind_proven_tx")
private func ffi_build_rebind_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ newOwner: UnsafePointer<UInt8>, _ identitySk: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_handle_address")
private func ffi_handle_address(
  _ keysDir: UnsafePointer<CChar>, _ name: UnsafePointer<UInt8>, _ payment: UnsafePointer<UInt8>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_set_invite_proven_tx")
private func ffi_build_set_invite_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ personaSk: UnsafePointer<UInt8>,
  _ moderatorPath: UnsafePointer<UInt8>, _ moderatorPathLen: Int,
  _ commitment: UnsafePointer<UInt8>, _ active: Bool,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_issue_invite_proven_tx")
private func ffi_build_issue_invite_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ authoritySk: UnsafePointer<UInt8>,
  _ commitment: UnsafePointer<UInt8>, _ active: Bool,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_set_invite_authority_proven_tx")
private func ffi_build_set_invite_authority_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ personaSk: UnsafePointer<UInt8>,
  _ moderatorPath: UnsafePointer<UInt8>, _ moderatorPathLen: Int,
  _ authority: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_compact_op")
private func ffi_compact_op(
  _ op: UnsafePointer<CChar>, _ args: UnsafePointer<CChar>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_leave_circle_proven_tx")
private func ffi_build_leave_circle_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ personaSk: UnsafePointer<UInt8>,
  _ memberPath: UnsafePointer<UInt8>, _ memberPathLen: Int,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_add_moderator_proven_tx")
private func ffi_build_add_moderator_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ personaSk: UnsafePointer<UInt8>,
  _ moderatorPath: UnsafePointer<UInt8>, _ moderatorPathLen: Int,
  _ targetLeaf: UnsafePointer<UInt8>,
  _ memberPath: UnsafePointer<UInt8>, _ memberPathLen: Int, _ authPub: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_cast_vote_proven_tx")
private func ffi_build_cast_vote_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ personaSk: UnsafePointer<UInt8>, _ ballotOption: UInt8, _ ballotRand: UnsafePointer<UInt8>,
  _ memberPath: UnsafePointer<UInt8>, _ memberPathLen: Int,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_reveal_vote_proven_tx")
private func ffi_build_reveal_vote_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ personaSk: UnsafePointer<UInt8>, _ ballotOption: UInt8, _ ballotRand: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_proposal_address")
private func ffi_proposal_address(
  _ keysDir: UnsafePointer<CChar>, _ circleId: UnsafePointer<UInt8>,
  _ membersRoot: UnsafePointer<UInt8>, _ content: UnsafePointer<UInt8>,
  _ author: UnsafePointer<UInt8>, _ optionCount: UInt8,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_proposal_deploy_tx")
private func ffi_build_proposal_deploy_tx(
  _ keysDir: UnsafePointer<CChar>, _ circleId: UnsafePointer<UInt8>,
  _ membersRoot: UnsafePointer<UInt8>, _ content: UnsafePointer<UInt8>,
  _ author: UnsafePointer<UInt8>, _ optionCount: UInt8,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_identity_address")
private func ffi_identity_address(
  _ keysDir: UnsafePointer<CChar>, _ c: UnsafePointer<UInt8>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_circle_member_path")
private func ffi_circle_member_path(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ leaf: UnsafePointer<UInt8>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_circle_moderator_path")
private func ffi_circle_moderator_path(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ leaf: UnsafePointer<UInt8>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_circle_members_root")
private func ffi_circle_members_root(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_circle_invite_authority")
private func ffi_circle_invite_authority(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_identity_deploy_tx")
private func ffi_build_identity_deploy_tx(
  _ keysDir: UnsafePointer<CChar>, _ c: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_handle_deploy_tx")
private func ffi_build_handle_deploy_tx(
  _ keysDir: UnsafePointer<CChar>, _ name: UnsafePointer<UInt8>, _ payment: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_set_row_proven_tx")
private func ffi_build_set_row_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ slot: UInt8, _ kind: UInt8, _ value: UnsafePointer<UInt8>, _ identitySk: UnsafePointer<UInt8>,
  _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_build_set_rows_proven_tx")
private func ffi_build_set_rows_proven_tx(
  _ zkirPath: UnsafePointer<CChar>, _ proverKeyPath: UnsafePointer<CChar>,
  _ verifierKeyPath: UnsafePointer<CChar>, _ paramsPath: UnsafePointer<CChar>,
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ contractAddress: UnsafePointer<UInt8>,
  _ slots: UnsafePointer<UInt8>, _ kinds: UnsafePointer<UInt8>, _ values: UnsafePointer<UInt8>,
  _ identitySk: UnsafePointer<UInt8>, _ networkId: UnsafePointer<CChar>, _ ttlSecs: UInt64,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

@_silgen_name("midnight_name_owner")
private func ffi_name_owner(
  _ state: UnsafePointer<UInt8>, _ stateLen: Int, _ name: UnsafePointer<UInt8>,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>,
  _ outErr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outErrLen: UnsafeMutablePointer<Int>
) -> Int32

/// Arguments for a native proven-unbound tx build, mirroring the Android Kotlin Records — a
/// single Record keeps the JS↔native call to one argument so the shared TS layer
/// (`@pnyx/midnight-native`) works unchanged on both platforms. Byte data is hex; artifacts
/// are on-disk paths (multi-MB, cached); ids/ttl are numbers.
struct JoinTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

/// A shielded transfer. `valueLeHex` is a u128 little-endian: a JS number cannot carry a coin value, so
/// it crosses as bytes rather than as a number that would round.
struct ShieldedTransferArgs: Record {
  @Field var stateHex: String = ""
  @Field var zswapRoleKeyHex: String = ""
  @Field var recipientCoinPublicKeyHex: String = ""
  @Field var recipientEncryptionPublicKeyHex: String = ""
  @Field var colorHex: String = ""
  @Field var valueLeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: UInt64 = 0
  @Field var artifactDir: String = ""
  @Field var paramsDir: String = ""
}

/// An unshielded transfer. `inputsHex` is the packed UTxO set to spend — 84-byte records of
/// value(u128 LE) ‖ tokenType(32) ‖ intentHash(32) ‖ outputNo(u32 LE) — because a transfer spends a
/// variable number of outputs and this bridge marshals no lists.
struct UnshieldedTransferArgs: Record {
  @Field var nightRoleKeyHex: String = ""
  @Field var inputsHex: String = ""
  @Field var recipientAddressHex: String = ""
  @Field var tokenTypeHex: String = ""
  @Field var valueLeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: UInt64 = 0
}

/// Funding a transaction a dApp composed. `inputsHex` is the same packed record format
/// `UnshieldedTransferArgs` uses, and it carries *candidates*: the native side spends the fewest that
/// cover what the ledger says the transaction owes, so passing more than needed is expected.
/// A transfer that pays its own DUST fee. The transfer half matches `UnshieldedTransferArgs`; the rest
/// is the DUST to pay with and the circuit material to prove the payment.
struct SelfFundedTransferArgs: Record {
  @Field var nightRoleKeyHex: String = ""
  @Field var inputsHex: String = ""
  @Field var recipientAddressHex: String = ""
  @Field var tokenTypeHex: String = ""
  @Field var valueLeHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: UInt64 = 0
  @Field var dustStateHex: String = ""
  @Field var dustRoleKeyHex: String = ""
  @Field var ctimeSecs: UInt64 = 0
  @Field var artifactDir: String = ""
  @Field var paramsDir: String = ""
  @Field var feeMargin: Int = 2
  /**
   * How many outputs to return change in; `0` or `1` keeps one. Several NIGHT UTxOs mean several DUST
   * generations, and a fee must be covered by a single DUST output.
   */
  @Field var changeChunks: Int = 0
}

/// Paying any unbound transaction's DUST fee from this wallet, whoever built it. Nothing about the
/// transaction's author is needed: the fee rides in an intent of our own at a free segment.
struct PayFeeFromDustArgs: Record {
  @Field var transactionHex: String = ""
  @Field var dustStateHex: String = ""
  @Field var dustRoleKeyHex: String = ""
  @Field var ctimeSecs: UInt64 = 0
  @Field var ttlSecs: UInt64 = 0
  @Field var artifactDir: String = ""
  @Field var paramsDir: String = ""
  @Field var feeMargin: Int = 2
}

struct BalanceUnsealedArgs: Record {
  @Field var transactionHex: String = ""
  @Field var nightRoleKeyHex: String = ""
  @Field var inputsHex: String = ""
}

/// Deploying a circle: the four constructor arguments, and the directory holding every entry
/// point's verifier key. No artifacts and no proving — a constructor is not a circuit.
struct CircleDeployArgs: Record {
  @Field var keysDir: String = ""
  @Field var circleIdHex: String = ""
  @Field var isOpen: Bool = false
  @Field var founderHex: String = ""
  @Field var founderAuthHex: String = ""
  @Field var founderJoinedHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Publishing an Pnyx identity row: no circle or proposal, just the row and the identity secret.
struct PublishRowTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

/// Claiming a handle. ⚠️ The transaction this builds does NOT balance: `bind` spends a tier permit,
/// so the caller adds that UTxO as an unshielded input before submitting.
struct ClaimFreePermitTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var tier: Int = 0
  @Field var recipientHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

struct BindTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Handing a handle over, on the current owner's authority. Spends a per-name rebind permit.
struct RebindTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var newOwnerHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Deriving a handle contract's address. `nameHex` is the FOLDED spelling — the display form derives
/// a different address, which is what makes `Alice` and `alice` one name.
struct HandleAddressArgs: Record {
  @Field var keysDir: String = ""
  @Field var nameHex: String = ""
  @Field var paymentHex: String = ""
}

/// Voting on a proposal. `memberPathHex` is 20 x (32-byte LE sibling, 1 byte goes_left) = 660 bytes —
/// the electorate is sealed, so the path is supplied rather than looked up.
/// Issuing or revoking a circle invite. The moderator path is 10 x 33 bytes, half a member path.
struct SetInviteTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var moderatorPathHex: String = ""
  @Field var commitmentHex: String = ""
  @Field var active: Bool = false
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// The delegated authority issuing or revoking. **No moderator path** — the authority is a ledger
/// cell's preimage, not a leaf in `moderators`.
struct IssueInviteTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var authoritySkHex: String = ""
  @Field var commitmentHex: String = ""
  @Field var active: Bool = false
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Delegating, rotating, or withdrawing invite issuance. Moderator-gated; 32 zero bytes withdraws.
struct SetInviteAuthorityTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

/// Leaving a circle. One path (20 x 33) and no gate — the persona authorises its own removal.
struct LeaveCircleTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var personaSkHex: String = ""
  @Field var memberPathHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Promoting a member. Two paths, different heights: moderator 10 x 33, member 20 x 33.
struct AddModeratorTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

struct CastVoteTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

/// Opening a sealed ballot. No member path — the nullifier already proves the vote was cast.
struct RevealVoteTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

/// Deriving or deploying a proposal. `membersRootHex` is 32 little-endian bytes.
struct ProposalAddressArgs: Record {
  @Field var keysDir: String = ""
  @Field var circleIdHex: String = ""
  @Field var membersRootHex: String = ""
  @Field var contentHex: String = ""
  @Field var authorHex: String = ""
  @Field var optionCount: Int = 0
}

struct ProposalDeployTxArgs: Record {
  @Field var keysDir: String = ""
  @Field var circleIdHex: String = ""
  @Field var membersRootHex: String = ""
  @Field var contentHex: String = ""
  @Field var authorHex: String = ""
  @Field var optionCount: Int = 0
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

struct IdentityAddressArgs: Record {
  @Field var keysDir: String = ""
  @Field var cHex: String = ""
}

/// Reading a circle's membership tree out of its contract state.
struct CircleMemberPathArgs: Record {
  @Field var contractStateHex: String = ""
  @Field var leafHex: String = ""
}

struct CircleMembersRootArgs: Record {
  @Field var contractStateHex: String = ""
}

/// Deploying an identity's own shell. Returns `address ‖ tx`.
struct IdentityDeployTxArgs: Record {
  @Field var keysDir: String = ""
  @Field var cHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Deploying an unbound handle shell. Returns `address ‖ tx`.
struct HandleDeployTxArgs: Record {
  @Field var keysDir: String = ""
  @Field var nameHex: String = ""
  @Field var paymentHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

struct SetPrimaryNameTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var nameHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

struct SetRowTxArgs: Record {
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
  @Field var ttlSecs: Int = 0
}

struct SetRowsTxArgs: Record {
  @Field var zkirPath: String = ""
  @Field var proverKeyPath: String = ""
  @Field var verifierKeyPath: String = ""
  @Field var paramsPath: String = ""
  @Field var contractStateHex: String = ""
  @Field var contractAddressHex: String = ""
  @Field var slots: [Int] = []
  @Field var kinds: [Int] = []
  @Field var valuesHex: String = ""
  @Field var identitySkHex: String = ""
  @Field var networkId: String = ""
  @Field var ttlSecs: Int = 0
}

/// Bridges the native Midnight library to JS, mirroring the Android Kotlin module: key
/// derivation, circuit metadata, and on-device proven-unbound tx assembly. The exported
/// functions take/return hex strings so the JS↔native boundary is plain strings. Proving is
/// CPU-bound for ~1–3 s at K=14/15 — AsyncFunction keeps it off the JS thread.
public class MidnightNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MidnightNative")

    Function("nightPayload") { (keyHex: String) -> String in
      try derive(keyHex, outLen: 32, ffi_night_payload)
    }
    Function("dustPublicKey") { (keyHex: String) -> String in
      try derive(keyHex, outLen: 32, ffi_dust_public_key)
    }
    Function("shieldedPublicKeys") { (keyHex: String) -> String in
      try derive(keyHex, outLen: 64, ffi_shielded_public_keys)
    }

    Function("circuitK") { (zkirHex: String) -> Int in
      let zkir = try hexToBytes(zkirHex)
      guard !zkir.isEmpty else { throw MidnightError("zkir is empty") }
      var k: UInt32 = 0
      var err = OutBuffer()
      let code = zkir.withUnsafeBufferPointer { zp in
        ffi_circuit_k(zp.baseAddress!, zkir.count, &k, &err.ptr, &err.len)
      }
      guard code == 0 else { throw err.takeError(code) }
      return Int(k)
    }

    // The dApp connector's proving provider. `check` wants the ZKIR only — kilobytes, so bytes rather
    // than a path — and answers in milliseconds; `prove` keeps the multi-MB artifacts on paths.
    AsyncFunction("checkPreimage") { (zkirHex: String, preimageHex: String) -> String in
      let zkir = try hexToBytes(zkirHex)
      let preimage = try hexToBytes(preimageHex)
      guard !zkir.isEmpty else { throw MidnightError("zkir is empty") }
      guard !preimage.isEmpty else { throw MidnightError("preimage is empty") }
      var out = OutBuffer()
      var err = OutBuffer()
      let code = zkir.withUnsafeBufferPointer { zp in
        preimage.withUnsafeBufferPointer { pp in
          ffi_check_preimage(
            zp.baseAddress!, zkir.count, pp.baseAddress!, preimage.count,
            &out.ptr, &out.len, &err.ptr, &err.len)
        }
      }
      return try takeResult(code, &out, &err)
    }

    AsyncFunction("provePreimageWithBinding") {
      (zkirPath: String, proverKeyPath: String, verifierKeyPath: String, paramsPath: String,
       preimageHex: String, bindingLeHex: String) -> String in
      let preimage = try hexToBytes(preimageHex)
      guard !preimage.isEmpty else { throw MidnightError("preimage is empty") }
      // Empty means "leave the preimage's binding input alone"; anything else must be a full 32 bytes,
      // because a short value would be padded into a field element the caller never chose.
      let binding = bindingLeHex.isEmpty ? [] : try hexToBytes32(bindingLeHex, "binding input")
      return try withCStrings([zkirPath, proverKeyPath, verifierKeyPath, paramsPath]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = preimage.withUnsafeBufferPointer { pp in
          binding.withUnsafeBufferPointer { bp in
            ffi_prove_preimage_with_binding(
              cs[0], cs[1], cs[2], cs[3], pp.baseAddress!, preimage.count,
              binding.isEmpty ? nil : bp.baseAddress,
              &out.ptr, &out.len, &err.ptr, &err.len)
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("proveCircuit") {
      (zkirPath: String, proverKeyPath: String, verifierKeyPath: String, paramsPath: String, preimageHex: String)
        -> String in
      let preimage = try hexToBytes(preimageHex)
      guard !preimage.isEmpty else { throw MidnightError("preimage is empty") }
      return try withCStrings([zkirPath, proverKeyPath, verifierKeyPath, paramsPath]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = preimage.withUnsafeBufferPointer { pp in
          ffi_prove_circuit_files(cs[0], cs[1], cs[2], cs[3], pp.baseAddress!, preimage.count, &out.ptr, &out.len, &err.ptr, &err.len)
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildJoinProvenTx") { (args: JoinTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let circle = try hexToBytes32(args.circleIdHex, "circle id")
      // Empty is the open arm, so it stays nil rather than becoming 32 zero bytes the native side
      // would have to recognise as meaning "none".
      let invite = args.inviteSecretHex.isEmpty ? nil : try hexToBytes32(args.inviteSecretHex, "invite secret")
      let idSk = try hexToBytes32(args.identitySkHex, "identity sk")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            circle.withUnsafeBufferPointer { cip in
              idSk.withUnsafeBufferPointer { ip in
                sk.withUnsafeBufferPointer { kp in
                  invite.withPointer { vp in
                    ffi_build_join_proven_tx(
                      cs[0], cs[1], cs[2], cs[3],
                      sp.baseAddress!, state.count,
                      ap.baseAddress!, cip.baseAddress!, vp,
                      ip.baseAddress!, kp.baseAddress!,
                      cs[4], UInt64(args.ttlSecs),
                      &out.ptr, &out.len, &err.ptr, &err.len)
                  }
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildPublishRowProvenTx") { (args: PublishRowTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let anchor = try hexToBytes32(args.anchorHex, "anchor")
      let authPub = try hexToBytes32(args.authPubHex, "authPub")
      let sk = try hexToBytes32(args.identitySkHex, "identity sk")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            anchor.withUnsafeBufferPointer { anp in
              authPub.withUnsafeBufferPointer { pp in
                sk.withUnsafeBufferPointer { kp in
                  ffi_build_publish_row_proven_tx(
                    cs[0], cs[1], cs[2], cs[3],
                    sp.baseAddress!, state.count,
                    ap.baseAddress!, anp.baseAddress!, pp.baseAddress!, kp.baseAddress!,
                    cs[4], UInt64(args.ttlSecs),
                    &out.ptr, &out.len, &err.ptr, &err.len)
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildSetPrimaryNameProvenTx") { (args: SetPrimaryNameTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let name = try hexToBytes32(args.nameHex, "name")
      let sk = try hexToBytes32(args.identitySkHex, "identity sk")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            name.withUnsafeBufferPointer { np in
              sk.withUnsafeBufferPointer { kp in
                ffi_build_set_primary_name_proven_tx(
                  cs[0], cs[1], cs[2], cs[3],
                  sp.baseAddress!, state.count,
                  ap.baseAddress!, np.baseAddress!, kp.baseAddress!,
                  cs[4], UInt64(args.ttlSecs),
                  &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildClaimFreePermitProvenTx") { (args: ClaimFreePermitTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let recipient = try hexToBytes32(args.recipientHex, "recipient")
      guard let tier = UInt8(exactly: args.tier) else {
        throw MidnightError("tier must be 0..6, got \(args.tier)")
      }
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            recipient.withUnsafeBufferPointer { rp in
              ffi_build_claim_free_permit_proven_tx(
                cs[0], cs[1], cs[2], cs[3],
                sp.baseAddress!, state.count,
                ap.baseAddress!, tier, rp.baseAddress!,
                cs[4], UInt64(args.ttlSecs),
                &out.ptr, &out.len, &err.ptr, &err.len)
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }
    AsyncFunction("buildBindProvenTx") { (args: BindTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.identitySkHex, "identity sk")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              ffi_build_bind_proven_tx(
                cs[0], cs[1], cs[2], cs[3],
                sp.baseAddress!, state.count,
                ap.baseAddress!, kp.baseAddress!,
                cs[4], UInt64(args.ttlSecs),
                &out.ptr, &out.len, &err.ptr, &err.len)
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildRebindProvenTx") { (args: RebindTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let newOwner = try hexToBytes32(args.newOwnerHex, "new owner")
      let sk = try hexToBytes32(args.identitySkHex, "identity sk")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            newOwner.withUnsafeBufferPointer { np in
              sk.withUnsafeBufferPointer { kp in
                ffi_build_rebind_proven_tx(
                  cs[0], cs[1], cs[2], cs[3],
                  sp.baseAddress!, state.count,
                  ap.baseAddress!, np.baseAddress!, kp.baseAddress!,
                  cs[4], UInt64(args.ttlSecs),
                  &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("handleAddress") { (args: HandleAddressArgs) -> String in
      let name = try hexToBytes32(args.nameHex, "name")
      let payment = try hexToBytes32(args.paymentHex, "payment address")
      return try withCStrings([args.keysDir]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = name.withUnsafeBufferPointer { np in
          payment.withUnsafeBufferPointer { pp in
            ffi_handle_address(
              cs[0], np.baseAddress!, pp.baseAddress!,
              &out.ptr, &out.len, &err.ptr, &err.len)
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildSetInviteProvenTx") { (args: SetInviteTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      let commitment = try hexToBytes32(args.commitmentHex, "invite commitment")
      let path = try hexToBytes(args.moderatorPathHex)
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              path.withUnsafeBufferPointer { pp in
                commitment.withUnsafeBufferPointer { cp in
                  ffi_build_set_invite_proven_tx(
                    cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                    kp.baseAddress!, pp.baseAddress!, path.count, cp.baseAddress!, args.active,
                    cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildIssueInviteProvenTx") { (args: IssueInviteTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.authoritySkHex, "invite authority sk")
      let commitment = try hexToBytes32(args.commitmentHex, "invite commitment")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              commitment.withUnsafeBufferPointer { cp in
                ffi_build_issue_invite_proven_tx(
                  cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                  kp.baseAddress!, cp.baseAddress!, args.active,
                  cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildSetInviteAuthorityProvenTx") { (args: SetInviteAuthorityTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      let authority = try hexToBytes32(args.authorityHex, "invite authority commitment")
      let path = try hexToBytes(args.moderatorPathHex)
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              path.withUnsafeBufferPointer { pp in
                authority.withUnsafeBufferPointer { aup in
                  ffi_build_set_invite_authority_proven_tx(
                    cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                    kp.baseAddress!, pp.baseAddress!, path.count, aup.baseAddress!,
                    cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    // Synchronous: the generated driver calls into this from a non-async call stack. See Kotlin.
    Function("compactOp") { (op: String, args: String) -> String in
      return try withCStrings([op, args]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = ffi_compact_op(cs[0], cs[1], &out.ptr, &out.len, &err.ptr, &err.len)
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildLeaveCircleProvenTx") { (args: LeaveCircleTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      let path = try hexToBytes(args.memberPathHex)
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              path.withUnsafeBufferPointer { pp in
                ffi_build_leave_circle_proven_tx(
                  cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                  kp.baseAddress!, pp.baseAddress!, path.count,
                  cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildAddModeratorProvenTx") { (args: AddModeratorTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      let target = try hexToBytes32(args.targetLeafHex, "target leaf")
      let authPub = try hexToBytes32(args.authPubHex, "auth pub")
      let modPath = try hexToBytes(args.moderatorPathHex)
      let memberPath = try hexToBytes(args.memberPathHex)
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              modPath.withUnsafeBufferPointer { mp in
                target.withUnsafeBufferPointer { tp in
                  memberPath.withUnsafeBufferPointer { bp in
                    authPub.withUnsafeBufferPointer { aup in
                      ffi_build_add_moderator_proven_tx(
                        cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                        kp.baseAddress!, mp.baseAddress!, modPath.count, tp.baseAddress!,
                        bp.baseAddress!, memberPath.count, aup.baseAddress!,
                        cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
                    }
                  }
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildCastVoteProvenTx") { (args: CastVoteTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      let rand = try hexToBytes32(args.ballotRandHex, "ballot rand")
      let path = try hexToBytes(args.memberPathHex)
      let option = try uint8(args.ballotOption, "ballot option")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              rand.withUnsafeBufferPointer { rp in
                path.withUnsafeBufferPointer { pp in
                  ffi_build_cast_vote_proven_tx(
                    cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                    kp.baseAddress!, option, rp.baseAddress!, pp.baseAddress!, path.count,
                    cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildRevealVoteProvenTx") { (args: RevealVoteTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.personaSkHex, "persona sk")
      let rand = try hexToBytes32(args.ballotRandHex, "ballot rand")
      let option = try uint8(args.ballotOption, "ballot option")
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            sk.withUnsafeBufferPointer { kp in
              rand.withUnsafeBufferPointer { rp in
                ffi_build_reveal_vote_proven_tx(
                  cs[0], cs[1], cs[2], cs[3], sp.baseAddress!, state.count, ap.baseAddress!,
                  kp.baseAddress!, option, rp.baseAddress!,
                  cs[4], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("proposalAddress") { (args: ProposalAddressArgs) -> String in
      let circle = try hexToBytes32(args.circleIdHex, "circle id")
      let root = try hexToBytes32(args.membersRootHex, "members root")
      let content = try hexToBytes32(args.contentHex, "content")
      let author = try hexToBytes32(args.authorHex, "author")
      let count = try uint8(args.optionCount, "option count")
      return try withCStrings([args.keysDir]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = circle.withUnsafeBufferPointer { cp in
          root.withUnsafeBufferPointer { rp in
            content.withUnsafeBufferPointer { np in
              author.withUnsafeBufferPointer { ap in
                ffi_proposal_address(
                  cs[0], cp.baseAddress!, rp.baseAddress!, np.baseAddress!, ap.baseAddress!, count,
                  &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildProposalDeployTx") { (args: ProposalDeployTxArgs) -> String in
      let circle = try hexToBytes32(args.circleIdHex, "circle id")
      let root = try hexToBytes32(args.membersRootHex, "members root")
      let content = try hexToBytes32(args.contentHex, "content")
      let author = try hexToBytes32(args.authorHex, "author")
      let count = try uint8(args.optionCount, "option count")
      return try withCStrings([args.keysDir, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = circle.withUnsafeBufferPointer { cp in
          root.withUnsafeBufferPointer { rp in
            content.withUnsafeBufferPointer { np in
              author.withUnsafeBufferPointer { ap in
                ffi_build_proposal_deploy_tx(
                  cs[0], cp.baseAddress!, rp.baseAddress!, np.baseAddress!, ap.baseAddress!, count,
                  cs[1], UInt64(args.ttlSecs), &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("identityAddress") { (args: IdentityAddressArgs) -> String in
      let c = try hexToBytes32(args.cHex, "identity commitment")
      return try withCStrings([args.keysDir]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = c.withUnsafeBufferPointer { cp in
          ffi_identity_address(cs[0], cp.baseAddress!, &out.ptr, &out.len, &err.ptr, &err.len)
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("circleMemberPath") { (args: CircleMemberPathArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let leaf = try hexToBytes32(args.leafHex, "member leaf")
      var out = OutBuffer()
      var err = OutBuffer()
      let code = state.withUnsafeBufferPointer { sp in
        leaf.withUnsafeBufferPointer { lp in
          ffi_circle_member_path(
            sp.baseAddress!, state.count, lp.baseAddress!,
            &out.ptr, &out.len, &err.ptr, &err.len)
        }
      }
      return try takeResult(code, &out, &err)
    }
    AsyncFunction("circleModeratorPath") { (args: CircleMemberPathArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let leaf = try hexToBytes32(args.leafHex, "moderator leaf")
      var out = OutBuffer()
      var err = OutBuffer()
      let code = state.withUnsafeBufferPointer { sp in
        leaf.withUnsafeBufferPointer { lp in
          ffi_circle_moderator_path(
            sp.baseAddress!, state.count, lp.baseAddress!,
            &out.ptr, &out.len, &err.ptr, &err.len)
        }
      }
      return try takeResult(code, &out, &err)
    }

    AsyncFunction("circleMembersRoot") { (args: CircleMembersRootArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      var out = OutBuffer()
      var err = OutBuffer()
      let code = state.withUnsafeBufferPointer { sp in
        ffi_circle_members_root(
          sp.baseAddress!, state.count,
          &out.ptr, &out.len, &err.ptr, &err.len)
      }
      return try takeResult(code, &out, &err)
    }

    // Empty when the circle has delegated to nobody. `takeResult` returns "" for a zero-length
    // buffer, which is the answer — a read failure comes back as a thrown error instead.
    AsyncFunction("circleInviteAuthority") { (args: CircleMembersRootArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      var out = OutBuffer()
      var err = OutBuffer()
      let code = state.withUnsafeBufferPointer { sp in
        ffi_circle_invite_authority(
          sp.baseAddress!, state.count,
          &out.ptr, &out.len, &err.ptr, &err.len)
      }
      return try takeResult(code, &out, &err)
    }

    AsyncFunction("buildIdentityDeployTx") { (args: IdentityDeployTxArgs) -> String in
      let c = try hexToBytes32(args.cHex, "identity commitment")
      return try withCStrings([args.keysDir, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = c.withUnsafeBufferPointer { cp in
          ffi_build_identity_deploy_tx(
            cs[0], cp.baseAddress!,
            cs[1], UInt64(args.ttlSecs),
            &out.ptr, &out.len, &err.ptr, &err.len)
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildHandleDeployTx") { (args: HandleDeployTxArgs) -> String in
      let name = try hexToBytes32(args.nameHex, "name")
      let payment = try hexToBytes32(args.paymentHex, "payment address")
      return try withCStrings([args.keysDir, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = name.withUnsafeBufferPointer { np in
          payment.withUnsafeBufferPointer { pp in
            ffi_build_handle_deploy_tx(
              cs[0], np.baseAddress!, pp.baseAddress!,
              cs[1], UInt64(args.ttlSecs),
              &out.ptr, &out.len, &err.ptr, &err.len)
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildSetRowProvenTx") { (args: SetRowTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.identitySkHex, "identity sk")
      let value = try hexToBytes(args.valueHex)
      guard value.count == 320 else { throw MidnightError("card row value must be 320 bytes, got \(value.count)") }
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            value.withUnsafeBufferPointer { vp in
              sk.withUnsafeBufferPointer { kp in
                ffi_build_set_row_proven_tx(
                  cs[0], cs[1], cs[2], cs[3],
                  sp.baseAddress!, state.count,
                  ap.baseAddress!, UInt8(args.slot), UInt8(args.kind), vp.baseAddress!, kp.baseAddress!,
                  cs[4], UInt64(args.ttlSecs),
                  &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("buildSetRowsProvenTx") { (args: SetRowsTxArgs) -> String in
      let state = try stateBytes(args.contractStateHex)
      let address = try hexToBytes32(args.contractAddressHex, "contract address")
      let sk = try hexToBytes32(args.identitySkHex, "identity sk")
      let values = try hexToBytes(args.valuesHex)
      // Exactly four, because the template's width is fixed.
      guard args.slots.count == 4, args.kinds.count == 4, values.count == 4 * 320 else {
        throw MidnightError("setRows takes 4 slots, 4 kinds and 1280 value bytes")
      }
      let slots = args.slots.map { UInt8($0) }
      let kinds = args.kinds.map { UInt8($0) }
      return try withCStrings([args.zkirPath, args.proverKeyPath, args.verifierKeyPath, args.paramsPath, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = state.withUnsafeBufferPointer { sp in
          address.withUnsafeBufferPointer { ap in
            slots.withUnsafeBufferPointer { slp in
              kinds.withUnsafeBufferPointer { kdp in
                values.withUnsafeBufferPointer { vp in
                  sk.withUnsafeBufferPointer { kp in
                    ffi_build_set_rows_proven_tx(
                      cs[0], cs[1], cs[2], cs[3],
                      sp.baseAddress!, state.count,
                      ap.baseAddress!, slp.baseAddress!, kdp.baseAddress!, vp.baseAddress!,
                      kp.baseAddress!, cs[4], UInt64(args.ttlSecs),
                      &out.ptr, &out.len, &err.ptr, &err.len)
                  }
                }
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("nameOwner") { (stateHex: String, nameHex: String) -> String in
      let state = try stateBytes(stateHex)
      let name = try hexToBytes(nameHex)
      guard name.count == 32 else {
        throw MidnightError("name must be 32 bytes, got \(name.count)")
      }
      var out = OutBuffer()
      var err = OutBuffer()
      let code = state.withUnsafeBufferPointer { sp in
        name.withUnsafeBufferPointer { np in
          ffi_name_owner(
            sp.baseAddress!, state.count, np.baseAddress!,
            &out.ptr, &out.len, &err.ptr, &err.len)
        }
      }
      return try takeTextResult(code, &out, &err)
    }

    AsyncFunction("buildCircleDeployTx") { (args: CircleDeployArgs) -> String in
      let circle = try hexToBytes32(args.circleIdHex, "circle id")
      let founder = try hexToBytes32(args.founderHex, "founder")
      let founderAuth = try hexToBytes32(args.founderAuthHex, "founder auth")
      let founderJoined = try hexToBytes32(args.founderJoinedHex, "founder join nullifier")
      return try withCStrings([args.keysDir, args.networkId]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = circle.withUnsafeBufferPointer { cip in
          founder.withUnsafeBufferPointer { fp in
            founderAuth.withUnsafeBufferPointer { fap in
              founderJoined.withUnsafeBufferPointer { fjp in
                ffi_build_circle_deploy_tx(
                  cs[0], cip.baseAddress!, args.isOpen ? 1 : 0, fp.baseAddress!, fap.baseAddress!,
                  fjp.baseAddress!, cs[1], UInt64(args.ttlSecs),
                  &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

    AsyncFunction("circleDeployAddress") { (args: CircleDeployArgs) -> String in
      let circle = try hexToBytes32(args.circleIdHex, "circle id")
      let founder = try hexToBytes32(args.founderHex, "founder")
      let founderAuth = try hexToBytes32(args.founderAuthHex, "founder auth")
      let founderJoined = try hexToBytes32(args.founderJoinedHex, "founder join nullifier")
      return try withCStrings([args.keysDir]) { cs in
        var out = OutBuffer()
        var err = OutBuffer()
        let code = circle.withUnsafeBufferPointer { cip in
          founder.withUnsafeBufferPointer { fp in
            founderAuth.withUnsafeBufferPointer { fap in
              founderJoined.withUnsafeBufferPointer { fjp in
                ffi_circle_deploy_address(
                  cs[0], cip.baseAddress!, args.isOpen ? 1 : 0, fp.baseAddress!, fap.baseAddress!,
                  fjp.baseAddress!,
                  &out.ptr, &out.len, &err.ptr, &err.len)
              }
            }
          }
        }
        return try takeResult(code, &out, &err)
      }
    }

  }
}

private func MidnightError(_ description: String) -> Exception {
  Exception(name: "MidnightNativeError", description: description)
}

/// A (`*mut u8`, `usize`) out-parameter pair the Rust side fills with a malloc'd buffer.
private struct OutBuffer {
  var ptr: UnsafeMutablePointer<UInt8>? = nil
  var len: Int = 0

  /// Copies the buffer out and releases the native allocation.
  mutating func take() -> [UInt8] {
    guard let p = ptr else { return [] }
    let bytes = Array(UnsafeBufferPointer(start: p, count: len))
    ffi_buffer_free(p, len)
    ptr = nil
    len = 0
    return bytes
  }

  /// Builds the thrown error from a failure code, consuming the error-message buffer if set.
  mutating func takeError(_ code: Int32) -> Exception {
    let bytes = take()
    let message = bytes.isEmpty
      ? "midnight native call failed (code \(code))"
      : String(decoding: bytes, as: UTF8.self)
    return MidnightError(message)
  }
}

/// The shared body of both wallet entry points: hex in, one FFI call, `finish`-style result out.
///
/// `state` and `arg` are legitimately empty (`new` takes neither), and the C side requires non-null
/// pointers, so an empty argument passes a one-byte scratch buffer with a length of zero rather than
/// nil — a null pointer there is ERR_NULL, which would read as a bug rather than an empty argument.
private func walletOp(
  _ op: String, _ stateHex: String, _ keyHex: String, _ argHex: String,
  _ ffi: (UnsafePointer<CChar>, UnsafePointer<UInt8>, Int, UnsafePointer<UInt8>, UnsafePointer<UInt8>, Int,
          UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, UnsafeMutablePointer<Int>,
          UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, UnsafeMutablePointer<Int>) -> Int32,
  _ finish: (Int32, inout OutBuffer, inout OutBuffer) throws -> String
) throws -> String {
  let state = try hexToBytes(stateHex)
  let key = try hexToBytes32(keyHex, "zswap role key")
  let arg = try hexToBytes(argHex)
  var out = OutBuffer()
  var err = OutBuffer()
  let scratch: [UInt8] = [0]
  let code = try withCStrings([op]) { ops -> Int32 in
    (state.isEmpty ? scratch : state).withUnsafeBufferPointer { sp in
      key.withUnsafeBufferPointer { kp in
        (arg.isEmpty ? scratch : arg).withUnsafeBufferPointer { ap in
          ffi(
            ops[0], sp.baseAddress!, state.count, kp.baseAddress!, ap.baseAddress!, arg.count,
            &out.ptr, &out.len, &err.ptr, &err.len)
        }
      }
    }
  }
  return try finish(code, &out, &err)
}

private func takeResult(_ code: Int32, _ out: inout OutBuffer, _ err: inout OutBuffer) throws -> String {
  guard code == 0 else { throw err.takeError(code) }
  return bytesToHex(out.take())
}

/// Same contract as `takeResult`, but the payload is already UTF-8 text rather
/// than bytes to hex-encode. Hex-encoding it would hand JS a string it would have to decode again.
private func takeTextResult(_ code: Int32, _ out: inout OutBuffer, _ err: inout OutBuffer) throws -> String {
  guard code == 0 else { throw err.takeError(code) }
  let bytes = out.take()
  guard let text = String(bytes: bytes, encoding: .utf8) else {
    throw MidnightError("native result is not valid UTF-8")
  }
  return text
}

/// Runs `body` with stable C-string copies of `strings` (paths + network id).
private func withCStrings<T>(_ strings: [String], _ body: ([UnsafePointer<CChar>]) throws -> T) throws -> T {
  let copies: [UnsafeMutablePointer<CChar>] = strings.map { strdup($0)! }
  defer { copies.forEach { free($0) } }
  return try body(copies.map { UnsafePointer($0) })
}

private func stateBytes(_ hex: String) throws -> [UInt8] {
  let state = try hexToBytes(hex)
  guard !state.isEmpty else { throw MidnightError("contract state is empty") }
  return state
}

/// Pass an optional byte array to C as a pointer that may be NULL.
///
/// `join`'s invite secret is the only argument shaped this way: NULL is the open circle, which is a
/// meaningful absence rather than a missing argument. Without this the call would have to be written
/// twice, once per branch.
private extension Optional where Wrapped == [UInt8] {
  func withPointer<R>(_ body: (UnsafePointer<UInt8>?) throws -> R) rethrows -> R {
    guard let bytes = self else { return try body(nil) }
    return try bytes.withUnsafeBufferPointer { try body($0.baseAddress) }
  }
}

private func hexToBytes32(_ hex: String, _ what: String) throws -> [UInt8] {
  let bytes = try hexToBytes(hex)
  guard bytes.count == 32 else { throw MidnightError("\(what) must be 32 bytes, got \(bytes.count)") }
  return bytes
}

private typealias FfiFn = (UnsafePointer<UInt8>, UnsafeMutablePointer<UInt8>) -> Int32

private func derive(_ keyHex: String, outLen: Int, _ fn: FfiFn) throws -> String {
  let key = try hexToBytes(keyHex)
  guard key.count == 32 else {
    throw MidnightError("role key must be 32 bytes, got \(key.count)")
  }
  var out = [UInt8](repeating: 0, count: outLen)
  let code = key.withUnsafeBufferPointer { kp in
    out.withUnsafeMutableBufferPointer { op in
      fn(kp.baseAddress!, op.baseAddress!)
    }
  }
  guard code == 0 else {
    throw MidnightError("midnight derive failed (code \(code))")
  }
  return bytesToHex(out)
}

/// A bridge integer narrowed to `UInt8`, refused by name rather than truncated — a wrapped ballot
/// option would vote for a different choice than the caller asked for.
private func uint8(_ value: Int, _ what: String) throws -> UInt8 {
  guard let narrowed = UInt8(exactly: value) else {
    throw NSError(domain: "MidnightNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(what) must be 0..255, got \(value)"])
  }
  return narrowed
}

private func hexToBytes(_ s: String) throws -> [UInt8] {
  guard s.count % 2 == 0 else {
    throw MidnightError("hex string must have even length")
  }
  let chars = Array(s)
  var out = [UInt8]()
  out.reserveCapacity(s.count / 2)
  var i = 0
  while i < chars.count {
    guard let b = UInt8(String(chars[i ... i + 1]), radix: 16) else {
      throw MidnightError("invalid hex byte at \(i)")
    }
    out.append(b)
    i += 2
  }
  return out
}

private func bytesToHex(_ bytes: [UInt8]) -> String {
  bytes.map { String(format: "%02x", $0) }.joined()
}
