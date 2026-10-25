//! Spend a coin the native wallet holds — the step after sync, proven end to end on the host.
//!
//! What this pins down is the piece the coin core could not: a `local::State` coin can be turned into
//! a **proven** Zswap input. That needs the ledger's own protocol circuits (`midnight/zswap/spend`),
//! whose artifacts are not ours and are not in our manifest yet, so this is the test that says whether
//! the remaining work is "host the artifacts" or something harder.
//!
//! Env-gated (SKIPs unless `ZSWAP_PROVE=1`) and offline: it reads the protocol circuits from
//! `~/.cache/midnight/zk-params`, which a one-time fetch primes. ~20 MB, so not something a plain
//! `cargo test` should pull. The crate pins every file's SHA-256 (`ZSWAP_EXPECTED_FILES`) and the
//! provider checks it on read, so a corrupt or substituted download fails here rather than producing
//! an invalid proof.
//!
//! ```sh
//! B=https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com  # or $MIDNIGHT_PARAM_SOURCE
//! D=~/.cache/midnight/zk-params/zswap/9                                     # 9 = midnight-ledger-static
//! mkdir -p $D && for c in spend output sign; do for k in bzkir prover verifier; do
//!   curl -sS -o $D/$c.$k $B/zswap/9/$c.$k; done; done
//! ZSWAP_PROVE=1 cargo test --test spend_shielded_coin -- --nocapture
//! ```

use futures::executor::block_on;
use midnight_base_crypto::data_provider::{self, MidnightDataProvider};
use midnight_base_crypto::hash::HashOutput;
use midnight_coin_structure::coin::{Info as CoinInfo, Nonce, ShieldedTokenType};
use midnight_native::wallet::{state_insert_coin, state_new, WalletState};
use midnight_serialize::tagged_deserialize;
use midnight_zkir::LocalProvingProvider;
use midnight_zswap::keys::{SecretKeys, Seed};
use midnight_zswap::prove::ZswapResolver;
use midnight_zswap::{INPUT_PROOF_SIZE, ZSWAP_EXPECTED_FILES};
use rand::rngs::StdRng;
use rand::SeedableRng;

/// Fixed so a failure is reproducible; any 32 bytes identify a wallet.
const ZSWAP_ROLE_KEY: [u8; 32] = [0x11; 32];

#[test]
fn a_coin_the_wallet_holds_can_be_spent_with_a_real_proof() {
    if std::env::var("ZSWAP_PROVE").ok().as_deref() != Some("1") {
        eprintln!("SKIP: set ZSWAP_PROVE=1 (first run downloads the zswap protocol circuits)");
        return;
    }

    let keys = SecretKeys::from(Seed::from(ZSWAP_ROLE_KEY));
    let coin = CoinInfo {
        nonce: Nonce(HashOutput([0x22; 32])),
        type_: ShieldedTokenType(HashOutput([0x33; 32])),
        value: 1_000,
    };

    // The wallet's own view: a coin at index 0, with the local tree the spend proves against.
    let state_bytes = state_insert_coin(&state_new().expect("new state"), &ZSWAP_ROLE_KEY, &{
        midnight_native::wallet::Coin {
            nonce: coin.nonce.0 .0,
            color: coin.type_.0 .0,
            value: coin.value,
        }
    })
    .expect("insert coin");
    let state: WalletState = tagged_deserialize(&mut &state_bytes[..]).expect("decode state");

    let qualified = state
        .coins
        .iter()
        .next()
        .map(|(_, c)| c)
        .expect("the inserted coin is tracked");
    assert_eq!(qualified.value, coin.value);
    assert_eq!(qualified.mt_index, 0);

    let mut rng = StdRng::seed_from_u64(0x5eed);
    let (_next, input) = state
        .spend(&mut rng, &keys, &qualified, Some(1))
        .expect("build the input");

    // Artifacts are fetched (and hash-verified) on first use, then cached.
    let resolver = ZswapResolver(
        MidnightDataProvider::new(
            // Synchronous, i.e. read only what is already cached. `OnDemand` would fetch, but its
            // HTTP client needs a Tokio reactor this crate does not carry — and an offline test is
            // the better shape anyway. Prime the cache once with the curl loop in the doc comment.
            data_provider::FetchMode::Synchronous,
            data_provider::OutputMode::Log,
            ZSWAP_EXPECTED_FILES.to_owned(),
        )
        .expect("data provider"),
    );
    let provider = LocalProvingProvider {
        rng: rng.clone(),
        params: &resolver,
        resolver: &resolver,
    };

    let proven = block_on(input.prove(provider)).expect("prove the spend");
    assert_eq!(
        proven.proof.0.len(),
        INPUT_PROOF_SIZE,
        "a real spend proof, not a mock"
    );
    eprintln!(
        "spend proof: {} bytes, nullifier {:?}",
        proven.proof.0.len(),
        proven.nullifier
    );
}
