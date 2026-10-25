//! What a node's `Custom error: N` means, established by submitting registrations we already know
//! the verdict of.
//!
//! The node maps the ledger's `MalformedTransaction` variants onto opaque `Custom error: N` codes and
//! publishes no table, so a rejection names nothing on its own. Every anchor this repo has was read
//! off a failure someone happened to hit, and they do not agree on a single base offset — which means
//! at least one is guesswork. This resolves it by construction: a registration built against the wrong
//! network id can only fail as `InvalidNetworkId`, which is variant 0, so whatever code comes back
//! **is** the base. A second registration, from a key holding no NIGHT, then names its own variant by
//! subtraction.
//!
//! Both transactions are rejected by design and neither can land, so this is safe to run against a
//! live chain. It is env-gated because it needs the network:
//!
//! ```sh
//! MIDNIGHT_NODE=https://rpc.preprod.midnight.network \
//!   cargo test --test dust_registration_error_codes -- --nocapture
//! ```

use bip32::{DerivationPath, XPrv};
use bip39::Mnemonic;
use midnight_native::dust::build_dust_registration_tx;

/// A throwaway role key. Nothing derived here holds NIGHT, which is the point of the second probe.
fn role_key(role: u32, index: u32) -> [u8; 32] {
    let seed = Mnemonic::parse("test test test test test test test test test test test junk")
        .unwrap()
        .to_seed("");
    let path: DerivationPath = format!("m/44'/2400'/0'/{role}/{index}").parse().unwrap();
    XPrv::derive_from_path(seed, &path).unwrap().to_bytes()
}

/// SCALE compact, and then the unsigned `Midnight.send_mn_transaction` framing — the same layout
/// `app/src/services/midnight/substrate-extrinsic.ts` builds, kept here so the probe measures
/// the chain rather than a second copy of our own encoder.
fn compact(value: usize) -> Vec<u8> {
    match value {
        v if v < 0x40 => vec![(v as u8) << 2],
        v if v < 0x4000 => ((v as u16) << 2 | 0b01).to_le_bytes().to_vec(),
        v => ((v as u32) << 2 | 0b10).to_le_bytes().to_vec(),
    }
}

fn extrinsic_hex(tx: &[u8]) -> String {
    let mut body = vec![0x04u8, 0x05, 0x00];
    body.extend(compact(tx.len()));
    body.extend_from_slice(tx);
    let mut out = compact(body.len());
    out.extend(body);
    format!(
        "0x{}",
        out.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn submit(node: &str, tx_hex: &str) -> String {
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"author_submitExtrinsic","params":["{tx_hex}"]}}"#
    );
    let out = std::process::Command::new("curl")
        .args([
            "-s",
            "-X",
            "POST",
            node,
            "-H",
            "content-type: application/json",
            "-d",
            &body,
        ])
        .output()
        .expect("curl");
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn build(network_id: &str) -> Vec<u8> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // No inputs: this probe is about naming error codes, and a key holding no NIGHT has none to spend.
    let json = build_dust_registration_tx(
        &role_key(2, 0),
        &role_key(4, 0),
        &[],
        true,
        network_id,
        now + 3600,
        now,
        10,
    )
    .expect("build the registration");
    let tx_hex = json
        .split("\"tx\":\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    hex::decode(tx_hex).expect("decode tx")
}

#[test]
fn names_the_custom_error_base() {
    let Ok(node) = std::env::var("MIDNIGHT_NODE") else {
        eprintln!("MIDNIGHT_NODE unset — skipping the live probe");
        return;
    };

    // Variant 0, `InvalidNetworkId`: the ledger compares the transaction's declared network against
    // the node's before anything else, so this cannot fail any other way.
    let wrong_network = submit(&node, &extrinsic_hex(&build("mainnet")));
    println!("wrong network id  -> {wrong_network}");

    // A well-formed registration that spends no NIGHT, so nothing backs its fee allowance:
    // `InsufficientDustForRegistrationFee`. See `self_spend_offer` for why an offer is what fixes it.
    let no_night = submit(&node, &extrinsic_hex(&build("preprod")));
    println!("no NIGHT to back  -> {no_night}");
}
