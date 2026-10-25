//! How long does the app's actual identity-row read take as the registry grows?
//!
//! `app/src/services/identity-row.ts` downloads the whole contract state and calls
//! `identityRowFromState`, which lands here: `tagged_deserialize` of the full blob, then one map
//! lookup. The JS/WASM `ContractState.deserialize` is a different runtime and a different cost, so
//! it cannot stand in for this.
//!
//! Run: cargo run --release --example row_read_scale -- <blob> [<blob> …]
use std::time::Instant;

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                println!("{path}: unreadable: {e}");
                continue;
            }
        };
        // A key that is almost certainly absent — the miss is the worst case and the common one
        // for a lookup of someone who has not registered.
        let c = [0x5cu8; 32];
        let t = Instant::now();
        let out = midnight_native::identity::identity_row(&bytes, c);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let name = path.rsplit('/').next().unwrap_or(&path);
        match out {
            Ok(row) => println!(
                "{name:34} {:>9.2} KiB  deserialize+lookup {ms:>10.1} ms  ({})",
                bytes.len() as f64 / 1024.0,
                if row.is_some() { "hit" } else { "miss" }
            ),
            Err(e) => println!(
                "{name:34} {:>9.2} KiB  FAILED after {ms:.1} ms: {e}",
                bytes.len() as f64 / 1024.0
            ),
        }
    }
}
