//! On-device smoke test: derives the golden-vector payloads via the same code path the C ABI
//! uses, and prints PASS/FAIL. Cross-compiled for an Android target and run via `adb shell` to
//! prove the native crate executes correctly on the Android runtime (not just on the host).

use bip32::{DerivationPath, XPrv};
use bip39::Mnemonic;
use midnight_native::{dust_public_key_le, night_payload, shielded_public_keys};

const MNEMONIC: &str = "test test test test test test test test test test test junk";
const NIGHT: &str = "fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41";
const DUST_LE: &str = "6cde37b99ede2ca54f1b113ee361d8c0429a5299c0f1caf19680a98f208c8866";
const COIN: &str = "978a97379c30c21bb7cc8a7e0e247a87e00e623fe8a86c31ec9a92b54435b699";
const ENC: &str = "365e2c24716918bfc917051311df6ca8c39990abe9668db9674c144987503dbd";

fn role_key(seed: &[u8], role: u32) -> [u8; 32] {
    let path: DerivationPath = format!("m/44'/2400'/0'/{role}/0").parse().unwrap();
    XPrv::derive_from_path(seed, &path)
        .unwrap()
        .private_key()
        .to_bytes()
        .into()
}

fn check(name: &str, got: String, want: &str) -> bool {
    let ok = got == want;
    println!("{name:8} {} {got}", if ok { "PASS" } else { "FAIL" });
    ok
}

fn main() {
    let seed = Mnemonic::parse(MNEMONIC).unwrap().to_seed("");
    let shielded = shielded_public_keys(&role_key(&seed, 3)).unwrap();
    let all = check(
        "night",
        hex::encode(night_payload(&role_key(&seed, 0)).unwrap()),
        NIGHT,
    ) & check(
        "dust",
        hex::encode(dust_public_key_le(&role_key(&seed, 2))),
        DUST_LE,
    ) & check("coin", hex::encode(&shielded[0..32]), COIN)
        & check("enc", hex::encode(&shielded[32..64]), ENC);
    println!("{}", if all { "ALL PASS" } else { "FAILED" });
    std::process::exit(if all { 0 } else { 1 });
}
