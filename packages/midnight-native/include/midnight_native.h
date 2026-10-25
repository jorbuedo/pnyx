// FFI contract for the native Midnight library (libmidnight_native): key derivation +
// circuit proving. Implemented in rust/src/lib.rs. All functions are synchronous and
// thread-safe (proving is CPU-bound for seconds — call off the main thread).
//
// Key derivation: each takes a 32-byte secp256k1 role secret key (derived host-side at
// m/44'/2400'/account'/role/index) and writes the raw address payload to `out`.
// Return: 0 = success; 1 = null pointer; 2 = invalid night key; 3 = serialization error;
// 4 = proving/verification error.

#ifndef MIDNIGHT_NATIVE_H
#define MIDNIGHT_NATIVE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// role-0 key (32) -> night address payload (32): SHA-256 of the BIP340 verifying key.
int32_t midnight_night_payload(const uint8_t *night_role_key, uint8_t *out);

// role-2 key (32) -> DUST public key (32): BLS12-381 scalar, little-endian.
int32_t midnight_dust_public_key(const uint8_t *dust_role_key, uint8_t *out);

// role-3 key (32) -> shielded keys (64): coin_public_key(32) ++ encryption_public_key(32).
int32_t midnight_shielded_public_keys(const uint8_t *zswap_role_key, uint8_t *out);

// Prove one compactc-compiled circuit invocation and verify the proof before returning.
// zkir = managed/zkir/<circuit>.bzkir; prover/verifier keys = managed/keys/<circuit>.{prover,verifier};
// params = the KZG SRS for the circuit's K (bls_midnight_2p<K>); preimage = the serialized
// proof preimage from the compact runtime's circuit execution.
// On success (*out_proof, *out_proof_len) holds the tagged-serialized proof; release it with
// midnight_buffer_free.
int32_t midnight_prove_circuit(const uint8_t *zkir, size_t zkir_len,
                               const uint8_t *prover_key, size_t prover_key_len,
                               const uint8_t *verifier_key, size_t verifier_key_len,
                               const uint8_t *params, size_t params_len,
                               const uint8_t *preimage, size_t preimage_len,
                               uint8_t **out_proof, size_t *out_proof_len);

// Releases a buffer returned by any function in this header (proof, tx, or error message).
// Safe on NULL.
void midnight_buffer_free(uint8_t *ptr, size_t len);

// ---- Tx assembly + circuit metadata (rust/src/c_bridge.rs) ----------------------------------
//
// The proven-tx builders mirror the Android JNI surface: static artifacts travel as
// NUL-terminated UTF-8 file paths (multi-MB cached files, read natively); dynamic data as
// (ptr, len) byte buffers. Return: 0 = success; 1 = null pointer; 5 = failed, with a UTF-8
// error message in (*out_err, *out_err_len) to release via midnight_buffer_free. On success
// (*out_tx, *out_tx_len) holds the tagged Transaction<signature,proof,pre-binding> bytes to
// POST to the service's /chain/submit — release via midnight_buffer_free. Proving is
// CPU-bound for ~1-3 s at K=14/15 — call off the main thread.

// The circuit's K (log2 rows) from its .bzkir bytes — names the SRS to fetch
// (bls_midnight_2p<K>). Writes K to *out_k.
int32_t midnight_circuit_k(const uint8_t *zkir, size_t zkir_len, uint32_t *out_k,
                           uint8_t **out_err, size_t *out_err_len);

// The check half of the dApp connector's proving provider: JSON array of
// `number | null` (the pi-skip sequence). Needs the ZKIR only — no keys, no SRS.
int32_t midnight_check_preimage(const uint8_t *zkir, size_t zkir_len,
                                const uint8_t *preimage, size_t preimage_len,
                                uint8_t **out, size_t *out_len,
                                uint8_t **out_err, size_t *out_err_len);

// midnight_prove_circuit_files with the caller's binding input replacing the
// preimage's. binding_le is NULL for "leave it alone", else 32 bytes little-endian.
int32_t midnight_prove_preimage_with_binding(const char *zkir_path, const char *prover_key_path,
                                             const char *verifier_key_path, const char *params_path,
                                             const uint8_t *preimage, size_t preimage_len,
                                             const uint8_t *binding_le,
                                             uint8_t **out_proof, size_t *out_proof_len,
                                             uint8_t **out_err, size_t *out_err_len);

// Path-based variant of midnight_prove_circuit; failures carry a message.
int32_t midnight_prove_circuit_files(const char *zkir_path, const char *prover_key_path,
                                     const char *verifier_key_path, const char *params_path,
                                     const uint8_t *preimage, size_t preimage_len,
                                     uint8_t **out_proof, size_t *out_proof_len,
                                     uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound join transaction on-device (build preimage -> tx-level
// prove -> serialize). contract_address, circle_id, identity_sk and persona_sk point to 32 bytes
// each. circle_id is the contract's own Bytes<32> id, not a counter — the join nullifier hashes it.
//
// invite_secret is the ONE pointer here that may be NULL: NULL joins an open circle, non-NULL points
// to the 32-byte secret whose commitment a moderator published, which a gated join spends. The two
// build different transcripts, so passing the wrong one is refused at build time rather than failing
// later at proving.
int32_t midnight_build_join_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *circle_id, const uint8_t *invite_secret,
    const uint8_t *identity_sk, const uint8_t *persona_sk, const char *network_id,
    uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len, uint8_t **out_err,
    size_t *out_err_len);

// Build a proven-unbound castVote transaction on-device. ballot_value is 0/1; ballot_rand
// points to 32 bytes.
/* setInvite — issue (active) or revoke a circle invite. Moderator-gated.
   moderator_path is 10 x 33 bytes (32-byte LE sibling + 1 byte goes_left), half a member path. */
int32_t midnight_build_set_invite_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *persona_sk,
    const uint8_t *moderator_path, size_t moderator_path_len,
    const uint8_t *commitment, bool active,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

/* issueInvite — the delegated authority's issuance. No Merkle path at all: the authority is a
   commitment in a ledger cell, not a leaf in `moderators`. A wrong secret, or a circle that
   delegated to nobody, is refused with a named error before proving. */
int32_t midnight_build_issue_invite_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *authority_sk,
    const uint8_t *commitment, bool active,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

/* setInviteAuthority — delegate, rotate, or withdraw. Moderator-gated, so moderator_path is
   10 x 33 bytes. 32 zero bytes in `authority` withdraws the delegation. */
int32_t midnight_build_set_invite_authority_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *persona_sk,
    const uint8_t *moderator_path, size_t moderator_path_len,
    const uint8_t *authority,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

/* One Compact-runtime leaf for the compactc-generated JS driver. JSON in, JSON out — one
   dispatcher so the bridge tax is paid once however many leaves compact.rs grows. */
int32_t midnight_compact_op(
    const char *op, const char *args, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

/* leaveCircle — remove your own leaf, self-authorised. member_path is 20 x 33 bytes.
   One-way: the join nullifier is never released, so a leaver cannot rejoin. */
int32_t midnight_build_leave_circle_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *persona_sk,
    const uint8_t *member_path, size_t member_path_len,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

/* addModerator — promote a member. Two paths of different heights: moderator 10 x 33,
   member 20 x 33. Swapping them is a length error, not a silent wrong root. */
int32_t midnight_build_add_moderator_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *persona_sk,
    const uint8_t *moderator_path, size_t moderator_path_len, const uint8_t *target_leaf,
    const uint8_t *member_path, size_t member_path_len, const uint8_t *auth_pub,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

/* Reads over a circle's own trees — a circle holds them, unlike a proposal. */
int32_t midnight_circle_member_path(
    const uint8_t *state, size_t state_len, const uint8_t *leaf, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

/* 10 x 33 bytes, half a member path — `moderators` is a shallower tree, and a 20-entry path
   hashes to a root `requireModerator` does not match. */
int32_t midnight_circle_moderator_path(
    const uint8_t *state, size_t state_len, const uint8_t *leaf, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

int32_t midnight_circle_members_root(
    const uint8_t *state, size_t state_len, uint8_t **out, size_t *out_len, uint8_t **out_err,
    size_t *out_err_len);

/* The circle's `inviteAuthority` commitment, or a **zero-length** buffer when it has delegated to
   nobody. Empty is an answer, not a failure — an unreadable state comes back as a non-zero return
   code with a message in `out_err`, and a caller must not collapse the two. */
int32_t midnight_circle_invite_authority(
    const uint8_t *state, size_t state_len, uint8_t **out, size_t *out_len, uint8_t **out_err,
    size_t *out_err_len);

/* A proposal's derived address, and its deploy. `createProposal` is not a circuit: creating a
   proposal is a deploy, which is what stops two authors conflicting. */
int32_t midnight_proposal_address(
    const char *keys_dir, const uint8_t *circle_id, const uint8_t *members_root,
    const uint8_t *content, const uint8_t *author, uint8_t option_count, uint8_t **out,
    size_t *out_len, uint8_t **out_err, size_t *out_err_len);

int32_t midnight_build_proposal_deploy_tx(
    const char *keys_dir, const uint8_t *circle_id, const uint8_t *members_root,
    const uint8_t *content, const uint8_t *author, uint8_t option_count, const char *network_id,
    uint64_t ttl_secs, uint8_t **out, size_t *out_len, uint8_t **out_err, size_t *out_err_len);

int32_t midnight_build_identity_deploy_tx(
    const char *keys_dir, const uint8_t *c, const char *network_id, uint64_t ttl_secs,
    uint8_t **out, size_t *out_len, uint8_t **out_err, size_t *out_err_len);

/* Wallet paths: an unshielded transfer, and paying any unbound transaction's DUST fee. */
int32_t midnight_wallet_build_unshielded_transfer(
    const uint8_t *night_role_key, const uint8_t *packed_inputs, size_t packed_inputs_len,
    const uint8_t *recipient_address, const uint8_t *token_type, const uint8_t *value_le,
    const char *network_id, uint64_t ttl_secs, uint32_t change_chunks, uint8_t **out,
    size_t *out_len, uint8_t **out_err, size_t *out_err_len);

int32_t midnight_wallet_pay_fee_from_dust(
    const uint8_t *transaction, size_t transaction_len, const uint8_t *dust_state,
    size_t dust_state_len, const uint8_t *dust_role_key, uint64_t ctime_secs, uint64_t ttl_secs,
    const char *artifact_dir, const char *params_dir, size_t fee_margin, uint8_t **out,
    size_t *out_len, uint8_t **out_err, size_t *out_err_len);

/* castVote — a proposal is its own contract, so there is no circle_id and no proposal_id: the
   address is the proposal. The member path is 20 x 33 bytes, supplied by the caller because the
   proposal seals its electorate and holds no tree. */
int32_t midnight_build_cast_vote_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *persona_sk, uint8_t ballot_option,
    const uint8_t *ballot_rand, const uint8_t *member_path, size_t member_path_len,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound createProposal transaction on-device. content_commitment points to

// Build a proven-unbound revealVote transaction on-device (proposal_id + the ballot to open).
// circle_id points to 32 bytes: the action nullifier hashes it.
/* revealVote — no member path: the nullifier already proves this persona voted while an elector. */
int32_t midnight_build_reveal_vote_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *persona_sk, uint8_t ballot_option,
    const uint8_t *ballot_rand, const char *network_id, uint64_t ttl_secs,
    uint8_t **out_tx, size_t *out_tx_len, uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound publishRow transaction on-device. anchor / auth_pub / identity_sk each
// point to 32 bytes. This is the identity write path: the device holds the secret and proves; the
// sponsor only pays. One transcript covers both a first publish and a rotation.
int32_t midnight_build_publish_row_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *anchor, const uint8_t *auth_pub,
    const uint8_t *identity_sk, const char *network_id, uint64_t ttl_secs,
    uint8_t **out_tx, size_t *out_tx_len, uint8_t **out_err, size_t *out_err_len);

// One Pnyx identity row from contract state. `identity` is the 32-byte `C`. On success *out holds
// JSON: a row object — anchor, authPub, name and the contact card as an array of
// {slot, kind, value} with value the full 320 bytes as hex — or the four bytes `null` when that
// identity has published nothing. A definite answer, and never to be conflated with ERR_FAILED
// ("nobody published this" is not "we could not look"). ERR_FAILED also covers a contract sealed to
// a different C, which means the caller fetched the wrong address.
int32_t midnight_identity_row(
    const uint8_t *state, size_t state_len, const uint8_t *identity, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

// Shielded wallet state. Two entry points, one per return shape: `state_op` returns the new
// serialized state (`new`, `applyCollapsedUpdate`, `insertCoin`, `watchFor`), `read_op` returns JSON
// (`summary`, `tryDecrypt`). An unrecognised op is ERR_FAILED, never a no-op. `zswap_role_key` points
// to 32 bytes; `state` and `arg` may be zero-length but must be non-null. A coin in `arg` is
// nonce(32) || color(32) || value(16, little-endian).
int32_t midnight_wallet_state_op(
    const char *op, const uint8_t *state, size_t state_len, const uint8_t *zswap_role_key,
    const uint8_t *arg, size_t arg_len, uint8_t **out, size_t *out_len, uint8_t **out_err,
    size_t *out_err_len);

// Build + prove a shielded transfer; on OK *out is JSON {"tx","state"}. `zswap_role_key`,
// `recipient_coin_public_key` and `color` are 32 bytes each, `value_le` is 16 (u128 little-endian), and
// the two directories hold the protocol circuits (`{spend,output,sign}.{bzkir,prover,verifier}`) and the
// SRS (`bls_midnight_2p<K>`). Seconds of CPU: three circuits are proved.
int32_t midnight_wallet_build_transfer(
    const uint8_t *state, size_t state_len, const uint8_t *zswap_role_key,
    const uint8_t *recipient_coin_public_key, const uint8_t *recipient_encryption_public_key,
    size_t recipient_encryption_public_key_len, const uint8_t *color, const uint8_t *value_le,
    const char *network_id, uint64_t ttl_secs, const char *artifact_dir, const char *params_dir,
    uint8_t **out, size_t *out_len, uint8_t **out_err, size_t *out_err_len);

// Build a transfer that pays its own DUST fee; on OK *out is JSON {"tx","state","fee"} — the sealed
// transaction, the dust state with its spend pending, and the fee charged. Unlike
// midnight_wallet_build_unshielded_transfer this proves (the K=13 midnight/dust/spend circuit) and
// seals, so artifact_dir holds spend.{bzkir,prover,verifier} and params_dir holds bls_midnight_2p13.
int32_t midnight_wallet_build_self_funded_transfer(
    const uint8_t *night_role_key, const uint8_t *packed_inputs, size_t packed_inputs_len,
    const uint8_t *recipient_address, const uint8_t *token_type, const uint8_t *value_le,
    const char *network_id, uint64_t ttl_secs, const uint8_t *dust_state, size_t dust_state_len,
    const uint8_t *dust_role_key, uint64_t ctime_secs, const char *artifact_dir,
    const char *params_dir, size_t fee_margin, uint32_t change_chunks, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

// Fund the deficits of a transaction a dApp composed; on OK *out is the funded, signed, still-unbound
// transaction as hex. `transaction` is a tagged Transaction<SignatureEnabled, Proof, PreBinding>,
// `night_role_key` is 32 bytes, and `packed_inputs` is 84-byte records of candidate UTxOs — more than
// needed is expected, the fewest that cover each shortfall are spent. No artifacts and no proving.
int32_t midnight_wallet_balance_unsealed_transaction(
    const uint8_t *transaction, size_t transaction_len, const uint8_t *night_role_key,
    const uint8_t *packed_inputs, size_t packed_inputs_len, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

// As above, returning JSON. `tryDecrypt` yields the four bytes `null` for an output that is not ours,
// which is an answer and not a failure. `txBalance` reports every entry of the ledger's balance map
// for the transaction in `arg`, negative deltas being what it owes.
int32_t midnight_wallet_read_op(
    const char *op, const uint8_t *state, size_t state_len, const uint8_t *zswap_role_key,
    const uint8_t *arg, size_t arg_len, uint8_t **out, size_t *out_len, uint8_t **out_err,
    size_t *out_err_len);

// The `C` holding a Pnyx handle. `name` is the 32-byte handle, UTF-8 left-aligned and zero-padded.
// On success *out is 64 hex characters, or empty when the handle is unclaimed — a definite answer,
// unlike ERR_FAILED. Label the peer from that C's row, never from the handle passed in: `names` is
// many-to-one and the row names the canonical handle.
int32_t midnight_name_owner(
    const uint8_t *state, size_t state_len, const uint8_t *name, uint8_t **out, size_t *out_len,
    uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound setPrimaryName transaction on-device. name / contract_address /
// identity_sk each point to 32 bytes; an all-zero name clears the claim.
//
// Unvalidated on chain by design: ownership lives in the per-name handle contract and
// contract-to-contract calls do not exist, so this writes a claim readers check both ways.
int32_t midnight_build_set_primary_name_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *name, const uint8_t *identity_sk,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound claimFreePermit transaction — a tier permit out of the free tier.
// Needs no unshielded input of its own: the call spends nothing, so the sponsor's fee segment is all
// it takes to submit. tier is 0..6; contract_address and recipient point to 32 bytes each.
int32_t midnight_build_claim_free_permit_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, uint8_t tier, const uint8_t *recipient,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound bind transaction — claim a handle.
// The result does NOT balance: bind spends a tier permit, so the caller adds that UTxO as an
// unshielded input. A permit is an ordinary ledger UTxO, so funding it is the wallet's job.
int32_t midnight_build_bind_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *identity_sk, const char *network_id,
    uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len, uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound rebind transaction — hand a handle to another identity, on the current
// owner's authority. Spends a per-name rebind permit.
int32_t midnight_build_rebind_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *new_owner, const uint8_t *identity_sk,
    const char *network_id, uint64_t ttl_secs, uint8_t **out_tx, size_t *out_tx_len,
    uint8_t **out_err, size_t *out_err_len);

// The address a handle contract deploys to — a pure derivation over the canonical (folded) name.
// No proving and no network: hash the name, get the address, ask the indexer whether anything is
// there. Writes 32 bytes.
/* No `admin_auth`: a handle template carries no authority of its own — the parameter went with that
   decision and the declaration kept it. */
int32_t midnight_handle_address(
    const char *keys_dir, const uint8_t *name, const uint8_t *payment, uint8_t **out,
    size_t *out_len, uint8_t **out_err, size_t *out_err_len);

// The address an identity contract deploys to — a pure derivation over C. Writes 32 bytes.
int32_t midnight_identity_address(
    const char *keys_dir, const uint8_t *c, uint8_t **out, size_t *out_len, uint8_t **out_err,
    size_t *out_err_len);

// An unproven, unbalanced handle-shell deploy. Writes address (32 bytes) followed by the
// transaction, so a caller reads the address without deserializing.
int32_t midnight_build_handle_deploy_tx(
    const char *keys_dir, const uint8_t *name, const uint8_t *payment, const char *network_id,
    uint64_t ttl_secs, uint8_t **out, size_t *out_len, uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound setRow transaction on-device — one contact-card row. value points to 320
// bytes (the full row field, length prefix and flags included); kind 0 clears the slot. Clearing a
// slot the card does not hold is ERR_FAILED from the builder, because the circuit asserts
// "no such row" and the transcript could never prove.
int32_t midnight_build_set_row_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, uint8_t slot, uint8_t kind, const uint8_t *value,
    const uint8_t *identity_sk, const char *network_id, uint64_t ttl_secs,
    uint8_t **out_tx, size_t *out_tx_len, uint8_t **out_err, size_t *out_err_len);

// Build a proven-unbound setRows transaction on-device — the "save my card" path. Exactly four
// slots, because the template's width is fixed: slots and kinds point to 4 bytes each and values to
// the four 320-byte rows concatenated (1280 bytes).
int32_t midnight_build_set_rows_proven_tx(
    const char *zkir_path, const char *prover_key_path, const char *verifier_key_path,
    const char *params_path, const uint8_t *contract_state, size_t contract_state_len,
    const uint8_t *contract_address, const uint8_t *slots, const uint8_t *kinds,
    const uint8_t *values, const uint8_t *identity_sk, const char *network_id, uint64_t ttl_secs,
    uint8_t **out_tx, size_t *out_tx_len, uint8_t **out_err, size_t *out_err_len);

// ── Circle deploy ──
//
// Creating a circle is a deploy, not a call: there is no proving and no per-circuit artifacts,
// because a constructor is not a circuit. keys_dir holds <entryPoint>.verifier for every circuit;
// circle_id and founder point to 32 bytes each; is_open is 0/1.

// Build the unproven, unbalanced deploy transaction for a circle. The sponsor balances and submits
// it; balancing cannot move the address, which is a hash over the deploy itself.
int32_t midnight_build_circle_deploy_tx(
    const char *keys_dir, const uint8_t *circle_id, uint8_t is_open, const uint8_t *founder,
    const uint8_t *founder_auth, const uint8_t *founder_joined, const char *network_id,
    uint64_t ttl_secs, uint8_t **out_tx,
    size_t *out_tx_len, uint8_t **out_err, size_t *out_err_len);

// The address a circle's constructor arguments imply, without building a transaction — so a client
// can verify an address it was handed rather than trusting it. Writes exactly 32 bytes.
int32_t midnight_circle_deploy_address(
    const char *keys_dir, const uint8_t *circle_id, uint8_t is_open, const uint8_t *founder,
    const uint8_t *founder_auth, const uint8_t *founder_joined, uint8_t **out_address,
    size_t *out_address_len,
    uint8_t **out_err, size_t *out_err_len);

#ifdef __cplusplus
}
#endif

#endif // MIDNIGHT_NATIVE_H
