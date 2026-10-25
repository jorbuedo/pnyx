//! Native circuit proving — the same path the Midnight proof server takes, in-process.
//!
//! The proof server (midnightntwrk/proof-server, ledger 8.1) proves a compactc-compiled
//! circuit by deserializing the tagged artifacts and calling `Zkir::prove` from
//! `midnight-transient-crypto`, with `midnight-zkir` (`zkir_v2`) as the ZKIR v2
//! implementation. This module exposes exactly that, byte-in/byte-out:
//!
//! - `zkir`:         `managed/zkir/<circuit>.bzkir`   — tagged `midnight:ir-source[v2]`
//! - `prover_key`:   `managed/keys/<circuit>.prover`  — tagged `midnight:prover-key[v7](ir-source[v2])`
//! - `verifier_key`: `managed/keys/<circuit>.verifier`— tagged `midnight:verifier-key[v6]`
//! - `params`:       the KZG SRS for the circuit's K (`bls_midnight_2p<K>`, the
//!   `MidnightDataProvider` cache files under `~/.cache/midnight/zk-params`)
//! - `preimage`:     tagged `midnight:proof-preimage` — the `ProofPreimage` produced by the
//!   compact runtime's circuit execution (in JS: `ContractCall<PreProof>.proof.serialize()`
//!   on an unproven transaction)
//!
//! The proof is verified against the verifier key before returning, mirroring the
//! self-check in `ProofPreimage::prove` — a returned proof is a *verified* proof.

use std::io;

use midnight_ledger::structure::ProofPreimageVersioned;
use midnight_serialize::{tagged_deserialize, tagged_serialize};
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::proofs::{
    ParamsProver, ParamsProverProvider, ParamsVerifier, ProofPreimage, ProverKey, VerifierKey, Zkir,
};
use midnight_zkir::IrSource;
use rand::rngs::OsRng;

/// A successful proving run: the tagged-serialized `Proof` plus the public-input
/// statement vector (one 32-byte little-endian BLS12-381 scalar per input).
pub struct ProveOutput {
    /// Tagged-serialized `midnight:proof[v5]` bytes.
    pub proof: Vec<u8>,
    /// The statement (public inputs) the proof verifies against, 32 bytes per `Fr`.
    pub public_inputs: Vec<[u8; 32]>,
}

/// Hands the single provided SRS to every `get_params` call. The caller supplies the
/// params file for the circuit's K; proving and the self-verification both request that K.
/// Shared with [`crate::tx`] (tx-level proving reuses the same SRS path).
pub(crate) struct FixedParams(ParamsProver);

impl FixedParams {
    /// Read a KZG SRS (`bls_midnight_2p<K>` bytes) into a fixed-params provider.
    pub(crate) fn read(params: &[u8]) -> Result<Self, String> {
        Ok(FixedParams(
            ParamsProver::read(params).map_err(|e| format!("read KZG params: {e}"))?,
        ))
    }
}

impl ParamsProverProvider for FixedParams {
    async fn get_params(&self, _k: u8) -> io::Result<ParamsProver> {
        Ok(self.0.clone())
    }
}

/// Accepts both preimage encodings: the ledger's versioned wrapper
/// (`midnight:proof-preimage-versioned`, what ledger-v8's `PreProof.serialize()` emits) and
/// the bare `midnight:proof-preimage`.
fn deserialize_preimage(bytes: &[u8]) -> Result<ProofPreimage, String> {
    match tagged_deserialize::<ProofPreimageVersioned>(&mut &bytes[..]) {
        Ok(ProofPreimageVersioned::V2(preimage)) => Ok((*preimage).clone()),
        Ok(other) => Err(format!("unsupported proof preimage version: {other:?}")),
        Err(versioned_err) => {
            tagged_deserialize::<ProofPreimage>(&mut &bytes[..]).map_err(|bare_err| {
                format!("deserialize proof preimage: {versioned_err}; as bare preimage: {bare_err}")
            })
        }
    }
}

fn fr_to_le_bytes(fr: &Fr) -> Result<[u8; 32], String> {
    fr.as_le_bytes()
        .try_into()
        .map_err(|v: Vec<u8>| format!("Fr is {} bytes, expected 32", v.len()))
}

/// Check a proof preimage against its circuit, without proving it.
///
/// The `ProvingProvider::check` half of the dApp connector's proving provider: it answers "is this
/// preimage well formed for this circuit, and which public inputs does it skip?" — the *pi skip
/// sequence*, one entry per input, `None` where nothing is skipped.
///
/// **Only the ZKIR is needed.** No prover key, no verifier key and no SRS, which is what makes this the
/// cheap half: `midnight-zkir`'s own `LocalProvingProvider::check` is exactly `preimage.check(&ir)`, and
/// a caller can therefore check a circuit it could not afford to prove.
pub fn check_preimage(zkir: &[u8], preimage: &[u8]) -> Result<Vec<Option<usize>>, String> {
    let ir: IrSource =
        tagged_deserialize(&mut &zkir[..]).map_err(|e| format!("deserialize zkir: {e}"))?;
    let preimage = deserialize_preimage(preimage)?;
    preimage
        .check(&ir)
        .map_err(|e| format!("check proof preimage: {e}"))
}

/// Prove one compactc-compiled circuit invocation and verify the result.
///
/// All inputs are the raw artifact bytes described in the module docs. Returns the
/// tagged-serialized proof plus the public-input vector on success.
pub fn prove_circuit(
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    preimage: &[u8],
) -> Result<ProveOutput, String> {
    prove_circuit_binding(zkir, prover_key, verifier_key, params, preimage, None)
}

/// [`prove_circuit`], with the option to replace the preimage's binding input first.
///
/// The `ProvingProvider::prove` half of the connector's proving provider. `overwrite_binding_input` is
/// the API's `overwriteBindingInput`: a caller assembling a transaction from several proofs binds them
/// together by proving each against a shared value, and the preimage it holds carries the wrong one
/// until this replaces it. 32 bytes, little-endian, and it must be a canonical `Fr` — a value that is
/// not gets refused rather than reduced, because a silently reduced binding input proves the wrong
/// statement.
///
/// `None` leaves the preimage exactly as given, which is why [`prove_circuit`] delegates here.
pub fn prove_circuit_binding(
    zkir: &[u8],
    prover_key: &[u8],
    verifier_key: &[u8],
    params: &[u8],
    preimage: &[u8],
    overwrite_binding_input: Option<&[u8; 32]>,
) -> Result<ProveOutput, String> {
    crate::diag::note(&format!(
        "prove: enter (zkir {} B, prover key {} B, srs {} B, preimage {} B)",
        zkir.len(),
        prover_key.len(),
        params.len(),
        preimage.len()
    ));
    let ir: IrSource =
        tagged_deserialize(&mut &zkir[..]).map_err(|e| format!("deserialize zkir: {e}"))?;
    let pk: ProverKey<IrSource> = tagged_deserialize(&mut &prover_key[..])
        .map_err(|e| format!("deserialize prover key: {e}"))?;
    let vk: VerifierKey = tagged_deserialize(&mut &verifier_key[..])
        .map_err(|e| format!("deserialize verifier key: {e}"))?;
    let mut preimage = deserialize_preimage(preimage)?;
    if let Some(bytes) = overwrite_binding_input {
        preimage.binding_input = Fr::from_le_bytes(bytes)
            .ok_or_else(|| "binding input is not a canonical Fr".to_string())?;
    }
    let srs = ParamsProver::read(params).map_err(|e| format!("read KZG params: {e}"))?;

    crate::diag::note(&format!("prove: artifacts deserialized, k={}", ir.k()));
    let (proof, statement, _pi_skips) =
        futures::executor::block_on(ir.prove(OsRng, &FixedParams(srs), pk, &preimage))
            .map_err(|e| format!("prove: {e}"))?;
    crate::diag::note("prove: proved, verifying");

    let verifier_params =
        ParamsVerifier::read(params).map_err(|e| format!("read verifier params: {e}"))?;
    vk.verify(&verifier_params, &proof, statement.iter().copied())
        .map_err(|e| format!("proof failed verification: {e}"))?;

    let mut proof_bytes = Vec::new();
    tagged_serialize(&proof, &mut proof_bytes).map_err(|e| format!("serialize proof: {e}"))?;
    let public_inputs = statement
        .iter()
        .map(fr_to_le_bytes)
        .collect::<Result<Vec<_>, _>>()?;
    crate::diag::note("prove: done");
    Ok(ProveOutput {
        proof: proof_bytes,
        public_inputs,
    })
}

/// Verify a proof produced by [`prove_circuit`] against a statement, standalone.
pub fn verify_proof(
    verifier_key: &[u8],
    params: &[u8],
    proof: &[u8],
    public_inputs: &[[u8; 32]],
) -> Result<(), String> {
    let vk: VerifierKey = tagged_deserialize(&mut &verifier_key[..])
        .map_err(|e| format!("deserialize verifier key: {e}"))?;
    let proof: midnight_transient_crypto::proofs::Proof =
        tagged_deserialize(&mut &proof[..]).map_err(|e| format!("deserialize proof: {e}"))?;
    let verifier_params =
        ParamsVerifier::read(params).map_err(|e| format!("read verifier params: {e}"))?;
    let statement = public_inputs
        .iter()
        .map(|bytes| {
            Fr::from_le_bytes(bytes).ok_or_else(|| "public input is not a canonical Fr".to_string())
        })
        .collect::<Result<Vec<Fr>, _>>()?;
    vk.verify(&verifier_params, &proof, statement.into_iter())
        .map_err(|e| format!("verification failed: {e}"))
}

/// The circuit's K (log2 rows) — names the SRS file the circuit needs (`bls_midnight_2p<K>`).
pub fn circuit_k(zkir: &[u8]) -> Result<u8, String> {
    let ir: IrSource =
        tagged_deserialize(&mut &zkir[..]).map_err(|e| format!("deserialize zkir: {e}"))?;
    Ok(ir.k())
}
