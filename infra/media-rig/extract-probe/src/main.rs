//! Full-chain extractor: reads the mainnet ImmutableDB directly (no node socket),
//! emits one JSONL record per tx carrying CIP-25 (label 721) metadata, and tallies
//! distinct minted assets by CIP-67 label class (for the CIP-25-vs-CIP-68 counts).
//!
//! Record shape (meta721.jsonl):
//!   {"slot":u64,"tx":"hex","mints":[["policyHex","nameHex",qty],...],"m721":<tagged-json>}
//! Tagged Metadatum JSON: {"int":"..."} | {"bytes":"hex"} | {"text":"..."} | {"arr":[...]} | {"map":[[k,v],...]}

use pallas_hardano::storage::immutable;
use pallas_primitives::alonzo::Metadatum;
use pallas_traverse::MultiEraBlock;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

fn md_to_json(m: &Metadatum) -> Value {
    match m {
        Metadatum::Int(i) => json!({ "int": i.to_string() }),
        Metadatum::Bytes(b) => json!({ "bytes": hex::encode(b.as_ref() as &[u8]) }),
        Metadatum::Text(s) => json!({ "text": s }),
        Metadatum::Array(a) => json!({ "arr": a.iter().map(md_to_json).collect::<Vec<_>>() }),
        Metadatum::Map(kv) => json!({
            "map": kv.iter().map(|(k, v)| vec![md_to_json(k), md_to_json(v)]).collect::<Vec<_>>()
        }),
    }
}

/// Effectively-exact 128-bit key for a minted asset (policy ‖ name), two seeded hashes.
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

/// CIP-67 class from the asset name's 4-byte prefix. Index into counts.
/// 0=ref(100) 1=nft(222) 2=ft(333) 3=rft(444) 4=other-cip67 5=non-cip68
fn cip67_class(name: &[u8]) -> usize {
    if name.len() >= 4 {
        match &name[0..4] {
            [0x00, 0x06, 0x43, 0xb0] => return 0,
            [0x00, 0x0d, 0xe1, 0x40] => return 1,
            [0x00, 0x14, 0xdf, 0x10] => return 2,
            [0x00, 0x1b, 0xc2, 0x80] => return 3,
            [0x00, _, _, d] if (d & 0x0f) == 0x00 => return 4,
            _ => {}
        }
    }
    5
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: {} <immutabledb-dir> [out.jsonl] [block-limit]", env!("CARGO_BIN_NAME"));
        std::process::exit(2);
    };
    let out = args.next().unwrap_or_else(|| "meta721.jsonl".to_string());
    let limit: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(u64::MAX);

    let file = std::fs::File::create(&out).expect("create output");
    let mut w = BufWriter::with_capacity(1 << 22, file);

    let blocks = immutable::read_blocks(Path::new(&dir)).expect("read_blocks failed");

    let (mut nblocks, mut ntx, mut n721, mut n721_records, mut first_slot, mut last_slot) =
        (0u64, 0u64, 0u64, 0u64, u64::MAX, 0u64);
    let mut seen: HashSet<u128> = HashSet::with_capacity(16_000_000);
    let mut counts = [0u64; 6];
    let mut policies: HashSet<u128> = HashSet::with_capacity(2_000_000);
    let start = Instant::now();

    for b in blocks {
        let raw = match b { Ok(x) => x, Err(e) => { eprintln!("block err: {e:?}"); continue } };
        let blk = match MultiEraBlock::decode(&raw) { Ok(x) => x, Err(e) => { eprintln!("decode err: {e:?}"); continue } };
        let slot = blk.slot();
        if slot < first_slot { first_slot = slot; }
        last_slot = slot;

        for tx in blk.txs() {
            ntx += 1;

            let mints = tx.mints();
            let mut mint_pairs: Vec<Value> = Vec::new();
            for pa in &mints {
                let policy = pa.policy();
                policies.insert(key128(policy.as_ref(), b""));
                for a in pa.assets() {
                    let qty = a.mint_coin().unwrap_or(0);
                    if qty > 0 {
                        let name = a.name();
                        if seen.insert(key128(policy.as_ref(), name)) {
                            counts[cip67_class(name)] += 1;
                        }
                        mint_pairs.push(json!([hex::encode(policy.as_ref() as &[u8]), hex::encode(name), qty]));
                    }
                }
            }

            if let Some(m) = tx.metadata().find(721) {
                n721 += 1;
                let rec = json!({
                    "slot": slot,
                    "tx": hex::encode(tx.hash()),
                    "mints": mint_pairs,
                    "m721": md_to_json(m),
                });
                serde_json::to_writer(&mut w, &rec).unwrap();
                w.write_all(b"\n").unwrap();
                n721_records += 1;
            }
        }

        nblocks += 1;
        if nblocks % 500_000 == 0 {
            let el = start.elapsed().as_secs_f64();
            eprintln!(
                "[{el:.0}s] blocks={nblocks} slot={last_slot} txs={ntx} 721tx={n721} distinctAssets={} nft222={} ref100={} ft333={} rate={:.0} blk/s",
                seen.len(), counts[1], counts[0], counts[2], nblocks as f64 / el
            );
        }
        if nblocks >= limit { break; }
    }
    w.flush().unwrap();
    let el = start.elapsed().as_secs_f64();
    eprintln!("==== EXTRACTION COMPLETE ====");
    eprintln!("blocks={nblocks} txs={ntx} first_slot={first_slot} last_slot={last_slot} elapsed={el:.1}s");
    eprintln!("721 txs={n721} (records written={n721_records}) -> {out}");
    eprintln!("distinct policies={}", policies.len());
    eprintln!("distinct minted assets={}", seen.len());
    eprintln!("  ref(100)={}  nft(222)={}  ft(333)={}  rft(444)={}  other-cip67={}  non-cip68={}",
        counts[0], counts[1], counts[2], counts[3], counts[4], counts[5]);
    println!("{}", json!({
        "blocks": nblocks, "txs": ntx, "first_slot": first_slot, "last_slot": last_slot,
        "elapsed_s": el, "n721_tx": n721, "n721_records": n721_records,
        "distinct_policies": policies.len(), "distinct_assets": seen.len(),
        "class": {"ref100": counts[0], "nft222": counts[1], "ft333": counts[2], "rft444": counts[3], "other_cip67": counts[4], "non_cip68": counts[5]}
    }));
}
