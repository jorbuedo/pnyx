//! Emit the artifact manifest for the **protocol** circuits a shielded spend needs, in the shape
//! `app/src/services/pnyx-artifacts.ts` fetches.
//!
//! These three circuits — `midnight/zswap/{spend,output,sign}` — are the ledger's, not ours, so there
//! is no `contract/managed` directory to build a manifest from. The hashes come from
//! `ZSWAP_EXPECTED_FILES`, which the **crate** pins: mirroring to our own origin is then verified end
//! to end, because the device checks each download against the same hash upstream published.
//!
//! `codeDigest` is the ledger major that names the artifacts' own path (the `9` in `zswap/9/...`),
//! taken from the directory rather than a constant here — the crate that defines it,
//! `midnight-ledger-static`, is not one of our dependencies. It is the honest version key: these files
//! change when that major changes, and the app caches under `<target>-<codeDigest>`.
//!
//! K per circuit is read from the `.bzkir` rather than tabulated, so the SRS list cannot drift from
//! what the circuits actually need.
//!
//! Usage: `cargo run --example zswap_manifest -- <artifact-dir>`
//! where `<artifact-dir>` holds the nine files (see `tests/spend_shielded_coin.rs` for the fetch).

use std::path::PathBuf;

use midnight_native::prove::circuit_k;
use midnight_zswap::ZSWAP_EXPECTED_FILES;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: zswap_manifest <artifact-dir>"),
    );
    // The last path segment is the ledger major the artifacts belong to (`.../zswap/9`).
    let version = dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| s.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or_else(|| {
            panic!(
                "the artifact dir's last segment must be the ledger major, got {}",
                dir.display()
            )
        })
        .to_string();

    // ("zswap/9/spend.prover", hash, description) → circuit "spend", kind "prover".
    let mut circuits: Vec<(String, Vec<(String, u64, String)>)> = Vec::new();
    let mut ks: Vec<u8> = Vec::new();

    for (path, expected_hash, _description) in ZSWAP_EXPECTED_FILES {
        let file = path.rsplit('/').next().expect("expected files are paths");
        let (circuit, kind) = file
            .split_once('.')
            .expect("expected files are <circuit>.<kind>");
        let on_disk = dir.join(file);
        let bytes =
            std::fs::read(&on_disk).unwrap_or_else(|e| panic!("read {}: {e}", on_disk.display()));

        // The mirror must carry upstream's bytes, not merely *some* bytes: a mismatch here means the
        // local cache is stale or tampered with, and publishing it would hand every device a file that
        // fails its own hash check.
        let actual: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(&bytes).into();
        assert_eq!(
            &actual, expected_hash,
            "{file} does not match the hash the crate pins"
        );

        if kind == "bzkir" {
            let k = circuit_k(&bytes).unwrap_or_else(|e| panic!("K for {file}: {e}"));
            if !ks.contains(&k) {
                ks.push(k);
            }
        }

        let entry = (kind.to_string(), bytes.len() as u64, hex(&actual));
        match circuits.iter_mut().find(|(name, _)| name == circuit) {
            Some((_, kinds)) => kinds.push(entry),
            None => circuits.push((circuit.to_string(), vec![entry])),
        }
    }

    let circuit_json: Vec<String> = circuits
        .iter()
        .map(|(name, kinds)| {
            let fields: Vec<String> = kinds
                .iter()
                .map(|(kind, size, sha)| {
                    format!("\"{kind}\":{{\"size\":{size},\"sha256\":\"{sha}\"}}")
                })
                .collect();
            format!("\"{name}\":{{{}}}", fields.join(","))
        })
        .collect();

    ks.sort_unstable();
    let ks_json: Vec<String> = ks.iter().map(|k| format!("\"{k}\"")).collect();

    println!(
        "{{\"target\":\"zswap\",\"codeDigest\":\"{}\",\"circuits\":{{{}}},\"srsK\":[{}]}}",
        version,
        circuit_json.join(","),
        ks_json.join(","),
    );
}
