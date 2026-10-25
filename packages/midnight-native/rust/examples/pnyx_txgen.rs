//! Build the transactions only the Rust rail can build, for a harness to balance and submit.
//!
//! Two things live here rather than in TypeScript, for one reason each:
//!
//! - **`handle-deploy`** — `ContractDeploy::new` samples its nonce from `OsRng` and the wasm binding
//!   exposes no alternative, so an SDK-built deploy has a random address. A name with a random address
//!   is a name with no canonical contract, and the whole uniqueness claim goes with it.
//! - **`bind`** — the device has no Compact runtime, so the transcript is hand-written here
//!   (`preimage.rs`) and proved natively.
//! - **`circle-deploy`** — same nonce problem as `handle-deploy`: a circle with a random address has
//!   no canonical contract, only what a registry claims, and `circle.compact`'s constructor seats the
//!   founder in `moderators` — so whoever controls the address controls invites and bans for the
//!   circle's life.
//! - **`join`** — the open-circle path, hand-written and proved natively for the same reason as
//!   `bind`.
//! - **`issue-invite`** — the one subcommand a *service* needs rather than a harness. An invite is
//!   minted by whoever knows the circle's `inviteAuthority` preimage, and the attestation service is
//!   that holder — so it has to build and prove a contract call with no device in the loop. Proving
//!   here rather than in TypeScript for the usual reason plus one more: this transcript is already
//!   gated by a prove+verify oracle (`tests/build_moderation_preimages.rs`), and a second
//!   implementation on the host would be a second thing to keep in step with the compiler.
//!
//! Output is hex on stdout, so a harness can capture it without a temp file:
//!   cargo run --release --example pnyx_txgen -- handle-deploy <keys-dir> <name-hex> <payment-hex> <network> <ttl>
//!   cargo run --release --example pnyx_txgen -- bind <managed-dir> <state-file> <address-hex> <sk-hex> <network> <ttl>
//!   cargo run --release --example pnyx_txgen -- circle-deploy <keys-dir> <circle-id-hex> <open> <founder-hex> <founder-auth-hex> <founder-joined-hex> <network> <ttl>
//!   cargo run --release --example pnyx_txgen -- join <managed-dir> <state-file> <address-hex> <circle-id-hex> <identity-sk-hex> <persona-sk-hex> <network> <ttl>
//!   cargo run --release --example pnyx_txgen -- issue-invite <managed-dir> <state-file> <address-hex> <authority-sk-hex> <commitment-hex> <active> <network> <ttl>
//!
//! `handle-deploy` and `circle-deploy` print `address ‖ tx`; the first 32 bytes are the address the
//! deploy will create, which the caller can and should re-derive rather than trust.

use std::fs;
use std::path::PathBuf;

fn hex32(s: &str, what: &str) -> [u8; 32] {
    hex::decode(s)
        .unwrap_or_else(|e| panic!("{what} is not hex: {e}"))
        .try_into()
        .unwrap_or_else(|v: Vec<u8>| panic!("{what} must be 32 bytes, got {}", v.len()))
}

fn srs_path(k: u8) -> PathBuf {
    let dir = std::env::var("MIDNIGHT_PP")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").expect("$HOME")).join(".cache/midnight/zk-params")
        });
    dir.join(format!("bls_midnight_2p{k}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: pnyx_txgen handle-deploy <keys-dir> <name-hex> <payment-hex> <network> <ttl>\n       pnyx_txgen bind <managed-dir> <state-file> <address-hex> <sk-hex> <network> <ttl>\n       pnyx_txgen circle-deploy <keys-dir> <circle-id-hex> <open> <founder-hex> <founder-auth-hex> <founder-joined-hex> <network> <ttl>\n       pnyx_txgen join <managed-dir> <state-file> <address-hex> <circle-id-hex> <identity-sk-hex> <persona-sk-hex> <network> <ttl>\n       pnyx_txgen issue-invite <managed-dir> <state-file> <address-hex> <authority-sk-hex> <commitment-hex> <active> <network> <ttl>";
    match args.get(1).map(String::as_str) {
        Some("handle-deploy") => {
            let keys_dir = args.get(2).expect(usage);
            let name = hex32(args.get(3).expect(usage), "name");
            let payment = hex32(args.get(4).expect(usage), "payment address");
            let network = args.get(5).expect(usage);
            let ttl: u64 = args.get(6).expect(usage).parse().expect("ttl is a number");
            let keys = midnight_native::deploy::read_verifier_keys(
                keys_dir,
                &midnight_native::deploy::HANDLE_ENTRY_POINTS,
            )
            .expect("read verifier keys");
            let (tx, address) =
                midnight_native::deploy::build_handle_deploy_tx(name, payment, &keys, network, ttl)
                    .expect("build handle deploy");
            // address first, so a caller reads it without deserializing the transaction.
            println!("{}{}", hex::encode(address), hex::encode(tx));
        }
        Some("bind") => {
            let managed = PathBuf::from(args.get(2).expect(usage));
            let state = fs::read(args.get(3).expect(usage)).expect("read contract state");
            let address = hex32(args.get(4).expect(usage), "contract address");
            let sk = hex32(args.get(5).expect(usage), "identity sk");
            let network = args.get(6).expect(usage);
            let ttl: u64 = args.get(7).expect(usage).parse().expect("ttl is a number");

            let zkir = fs::read(managed.join("zkir/bind.bzkir")).expect("read bind zkir");
            let prover = fs::read(managed.join("keys/bind.prover")).expect("read bind prover key");
            let verifier =
                fs::read(managed.join("keys/bind.verifier")).expect("read bind verifier key");
            let k = midnight_native::prove::circuit_k(&zkir).expect("read circuit k");
            let params =
                fs::read(srs_path(k)).unwrap_or_else(|e| panic!("read KZG params for K={k}: {e}"));

            let tx = midnight_native::preimage::build_bind_proven_tx(
                &state, address, sk, &zkir, &prover, &verifier, &params, network, ttl,
            )
            .expect("build bind tx");
            println!("{}", hex::encode(tx));
        }
        Some("circle-deploy") => {
            let keys_dir = args.get(2).expect(usage);
            let circle_id = hex32(args.get(3).expect(usage), "circle id");
            // Parsed strictly: `isOpen` is sealed into the state and therefore into the address, so a
            // typo silently deploying a gated circle would be a different contract, not a wrong flag.
            let open = match args.get(4).expect(usage).as_str() {
                "true" => true,
                "false" => false,
                other => panic!("open must be `true` or `false`, got `{other}`"),
            };
            let founder = hex32(args.get(5).expect(usage), "founder persona commitment");
            let founder_auth = hex32(args.get(6).expect(usage), "founder auth key");
            let founder_joined = hex32(args.get(7).expect(usage), "founder join nullifier");
            let network = args.get(8).expect(usage);
            let ttl: u64 = args.get(9).expect(usage).parse().expect("ttl is a number");
            let keys = midnight_native::deploy::read_circle_verifier_keys(keys_dir)
                .expect("read verifier keys");
            let (tx, address) = midnight_native::deploy::build_circle_deploy_tx(
                circle_id, open, founder, founder_auth, founder_joined, &keys, network, ttl,
            )
            .expect("build circle deploy");
            println!("{}{}", hex::encode(address), hex::encode(tx));
        }
        Some("join") => {
            let managed = PathBuf::from(args.get(2).expect(usage));
            let state = fs::read(args.get(3).expect(usage)).expect("read contract state");
            let address = hex32(args.get(4).expect(usage), "contract address");
            let circle_id = hex32(args.get(5).expect(usage), "circle id");
            let identity_sk = hex32(args.get(6).expect(usage), "identity sk");
            let persona_sk = hex32(args.get(7).expect(usage), "persona sk");
            let network = args.get(8).expect(usage);
            let ttl: u64 = args.get(9).expect(usage).parse().expect("ttl is a number");

            let zkir = fs::read(managed.join("zkir/join.bzkir")).expect("read join zkir");
            let prover = fs::read(managed.join("keys/join.prover")).expect("read join prover key");
            let verifier =
                fs::read(managed.join("keys/join.verifier")).expect("read join verifier key");
            let k = midnight_native::prove::circuit_k(&zkir).expect("read circuit k");
            let params =
                fs::read(srs_path(k)).unwrap_or_else(|e| panic!("read KZG params for K={k}: {e}"));

            let tx = midnight_native::preimage::build_join_proven_tx(
                &state,
                address,
                circle_id,
                // The harness only ever drives open circles; a gated join needs the invite secret.
                None,
                identity_sk,
                persona_sk,
                &zkir,
                &prover,
                &verifier,
                &params,
                network,
                ttl,
            )
            .expect("build join tx");
            println!("{}", hex::encode(tx));
        }
        Some("issue-invite") => {
            let managed = PathBuf::from(args.get(2).expect(usage));
            let state = fs::read(args.get(3).expect(usage)).expect("read contract state");
            let address = hex32(args.get(4).expect(usage), "contract address");
            let authority_sk = hex32(args.get(5).expect(usage), "invite authority sk");
            let commitment = hex32(args.get(6).expect(usage), "invite commitment");
            let active = match args.get(7).expect(usage).as_str() {
                "true" => true,
                "false" => false,
                other => panic!("active must be `true` or `false`, got `{other}`"),
            };
            let network = args.get(8).expect(usage);
            let ttl: u64 = args.get(9).expect(usage).parse().expect("ttl is a number");

            let zkir =
                fs::read(managed.join("zkir/issueInvite.bzkir")).expect("read issueInvite zkir");
            let prover = fs::read(managed.join("keys/issueInvite.prover"))
                .expect("read issueInvite prover key");
            let verifier = fs::read(managed.join("keys/issueInvite.verifier"))
                .expect("read issueInvite verifier key");
            let k = midnight_native::prove::circuit_k(&zkir).expect("read circuit k");
            let params =
                fs::read(srs_path(k)).unwrap_or_else(|e| panic!("read KZG params for K={k}: {e}"));

            // ⚠️ Refuses by name before proving when this circle delegated to nobody, or when this
            // secret is not its authority — the builder reads the `inviteAuthority` cell itself. A
            // caller that skipped that check would emit a transcript that runs and then fails as an
            // unsatisfiable constraint, several layers from "you are not the authority".
            let tx = midnight_native::preimage::build_issue_invite_proven_tx(
                &state,
                address,
                authority_sk,
                commitment,
                active,
                &zkir,
                &prover,
                &verifier,
                &params,
                network,
                ttl,
            )
            .expect("build issueInvite tx");
            println!("{}", hex::encode(tx));
        }
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    }
}
