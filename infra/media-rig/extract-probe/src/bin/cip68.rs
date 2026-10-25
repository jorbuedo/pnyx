//! CIP-68 extractor: CIP-68 metadata lives in the reference-NFT (label 100) output's
//! INLINE DATUM — and inline datums are in the immutable chunks, so no kupo/ogmios is
//! needed. One pass: (1) collect minted user-token names (222/333/444) as ground truth,
//! (2) for every output carrying a label-100 ref token with an inline datum, parse the
//! CIP-68 datum's `image`, keeping the latest slot per ref token (≈ current ledger state).
//! Then map each ref (100) to its minted user token and emit.
//!
//! Emits cip68.jsonl: {"slot":u64,"policy":"hex","name":"userTokenHex","image":"uri","kind":"nft222|ft333|rft444|unresolved"}

use pallas_hardano::storage::immutable;
use pallas_primitives::babbage::PseudoDatumOption;
use pallas_primitives::PlutusData;
use pallas_traverse::MultiEraBlock;
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

fn key128(policy: &[u8], name: &[u8]) -> u128 {
    let mut h1 = DefaultHasher::new();
    0x9e3779b97f4a7c15u64.hash(&mut h1);
    policy.hash(&mut h1);
    name.hash(&mut h1);
    let mut h2 = DefaultHasher::new();
    0xff51afd7ed558ccdu64.hash(&mut h2);
    name.hash(&mut h2);
    policy.hash(&mut h2);
    ((h1.finish() as u128) << 64) | (h2.finish() as u128)
}

const REF100: [u8; 4] = [0x00, 0x06, 0x43, 0xb0];
const NFT222: [u8; 4] = [0x00, 0x0d, 0xe1, 0x40];
const FT333: [u8; 4] = [0x00, 0x14, 0xdf, 0x10];
const RFT444: [u8; 4] = [0x00, 0x1b, 0xc2, 0x80];

fn is_user_token(name: &[u8]) -> bool {
    name.len() >= 4 && (name[0..4] == NFT222 || name[0..4] == FT333 || name[0..4] == RFT444)
}

/// Concatenate a Plutus string value: BoundedBytes, or an array of BoundedBytes (chunked).
fn plutus_str(v: &PlutusData) -> Option<String> {
    match v {
        PlutusData::BoundedBytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        PlutusData::Array(a) => {
            let mut s = String::new();
            for it in a.iter() {
                if let PlutusData::BoundedBytes(b) = it {
                    s.push_str(&String::from_utf8_lossy(b));
                } else {
                    return None;
                }
            }
            if s.is_empty() { None } else { Some(s) }
        }
        _ => None,
    }
}

/// CIP-68 datum: Constr{ fields:[ metadata_map, version, .. ] }. Pull metadata["image"].
fn cip68_image(pd: &PlutusData) -> Option<String> {
    if let PlutusData::Constr(c) = pd {
        if let Some(PlutusData::Map(m)) = c.fields.get(0) {
            for pair in m.iter() {
                if let PlutusData::BoundedBytes(kb) = &pair.0 {
                    if kb.as_slice() == b"image" {
                        return plutus_str(&pair.1);
                    }
                }
            }
        }
    }
    None
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: {} <immutabledb-dir> [out.jsonl] [block-limit]", env!("CARGO_BIN_NAME"));
        std::process::exit(2);
    };
    let out = args.next().unwrap_or_else(|| "cip68.jsonl".to_string());

    let blocks = immutable::read_blocks(Path::new(&dir)).expect("read_blocks failed");
    let mut minted_user: HashSet<u128> = HashSet::with_capacity(400_000);
    // (policy, refname) -> (slot, image)
    let mut ref_latest: HashMap<(Vec<u8>, Vec<u8>), (u64, String)> = HashMap::with_capacity(400_000);
    let (mut nblocks, mut n_datum_outputs, mut n_ref) = (0u64, 0u64, 0u64);
    let start = Instant::now();

    for b in blocks {
        let raw = match b { Ok(x) => x, Err(_) => continue };
        let blk = match MultiEraBlock::decode(&raw) { Ok(x) => x, Err(_) => continue };
        let slot = blk.slot();
        for tx in blk.txs() {
            for pa in tx.mints() {
                let policy = pa.policy();
                for a in pa.assets() {
                    if a.mint_coin().unwrap_or(0) > 0 && is_user_token(a.name()) {
                        minted_user.insert(key128(policy.as_ref(), a.name()));
                    }
                }
            }
            for out in tx.outputs() {
                let dat = match out.datum() { Some(d) => d, None => continue };
                let pd: &PlutusData = match &dat {
                    PseudoDatumOption::Data(cbor) => &cbor.0,
                    PseudoDatumOption::Hash(_) => continue,
                };
                n_datum_outputs += 1;
                // does this output carry a label-100 reference token?
                let assets = out.non_ada_assets();
                let mut img: Option<String> = None;
                for pa in &assets {
                    for a in pa.assets() {
                        let name = a.name();
                        if name.len() >= 4 && name[0..4] == REF100 {
                            n_ref += 1;
                            if img.is_none() {
                                img = cip68_image(pd);
                            }
                            if let Some(ref image) = img {
                                let key = (pa.policy().to_vec(), name.to_vec());
                                let e = ref_latest.entry(key).or_insert((0, String::new()));
                                if slot >= e.0 {
                                    *e = (slot, image.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
        nblocks += 1;
        if nblocks % 1_000_000 == 0 {
            let el = start.elapsed().as_secs_f64();
            eprintln!("[{el:.0}s] blocks={nblocks} slot={slot} datumOutputs={n_datum_outputs} refHits={n_ref} refTokens={} userMints={} rate={:.0} blk/s",
                ref_latest.len(), minted_user.len(), nblocks as f64 / el);
        }
    }

    // resolve each ref to its minted user token and emit
    let file = std::fs::File::create(&out).expect("create output");
    let mut w = BufWriter::with_capacity(1 << 20, file);
    let (mut emitted, mut unresolved) = (0u64, 0u64);
    for ((policy, refname), (slot, image)) in &ref_latest {
        let suffix = &refname[4..];
        let mut resolved: Option<(Vec<u8>, &str)> = None;
        for (pfx, kind) in [(NFT222, "nft222"), (FT333, "ft333"), (RFT444, "rft444")] {
            let mut name = pfx.to_vec();
            name.extend_from_slice(suffix);
            if minted_user.contains(&key128(policy, &name)) {
                resolved = Some((name, kind));
                break;
            }
        }
        let (name, kind) = match resolved {
            Some(x) => x,
            None => {
                unresolved += 1;
                let mut name = NFT222.to_vec();
                name.extend_from_slice(suffix);
                (name, "unresolved")
            }
        };
        let rec = json!({"slot": slot, "policy": hex::encode(policy), "name": hex::encode(&name), "image": image, "kind": kind});
        serde_json::to_writer(&mut w, &rec).unwrap();
        w.write_all(b"\n").unwrap();
        emitted += 1;
    }
    w.flush().unwrap();
    let el = start.elapsed().as_secs_f64();
    eprintln!("==== CIP-68 EXTRACTION COMPLETE ({el:.1}s) ====");
    eprintln!("blocks={nblocks} datumOutputs={n_datum_outputs} refTokenHits={n_ref}");
    eprintln!("distinct ref tokens with image={} emitted={emitted} unresolved-user-token={unresolved}", ref_latest.len());
    println!("{}", json!({"ref_tokens": ref_latest.len(), "emitted": emitted, "unresolved": unresolved, "user_mints": minted_user.len()}));
}
