# @pnyx/midnight-native

Native Midnight key-derivation (curve math) **and circuit proving** for React Native —
wraps Midnight's own published Rust crates instead of the `@midnight-ntwrk/ledger-v8` WASM,
which does not run on React Native/Hermes. Node and Web keep the WASM path for derivation
(it works there); this module is the React-Native-only backend for the same operations.

## Key derivation

Given the three secp256k1 role secret keys (derived host-side in JS via
`@midnight-ntwrk/wallet-sdk-hd` at `m/44'/2400'/account'/{role}/index`), it returns the raw
address payloads. bech32m/SCALE encoding stays in JS
(`packages/wallet/account/derivation/midnight-address-encoding.ts`).

C ABI — three ops, mapping 1:1 to the JS `MidnightCurveBackend` (full contract in
`include/midnight_native.h`):

```c
int32_t midnight_night_payload(const uint8_t *night_role_key, uint8_t *out);       // role 0 -> 32B
int32_t midnight_dust_public_key(const uint8_t *dust_role_key, uint8_t *out);      // role 2 -> 32B (LE scalar)
int32_t midnight_shielded_public_keys(const uint8_t *zswap_role_key, uint8_t *out); // role 3 -> 64B (coin‖enc)
```

Correctness is pinned to the wallet's golden vectors in `rust/src/lib.rs` (`cargo test`).

## Circuit proving (phase 5, on-device proving)

`rust/src/prove.rs` proves a compactc-compiled circuit in-process — the same crate path
the Midnight proof server takes (`midnight-transient-crypto` + `midnight-zkir` 2.1.0,
ledger 8.1 era). Inputs are the compile artifacts (`managed/zkir/<circuit>.bzkir`,
`managed/keys/<circuit>.{prover,verifier}`), the KZG SRS for the circuit's K
(`bls_midnight_2p<K>`), and the serialized proof preimage the compact runtime produced
for the call; the output proof is verified against the verifier key before returning.

- Rust: `prove::prove_circuit(zkir, prover_key, verifier_key, params, preimage) -> ProveOutput`,
  plus `verify_proof` and `circuit_k` (which SRS file a circuit needs).
- JS: `proveCircuit(paths, preimage)` — static artifacts travel as device file paths;
  only the preimage and proof cross the bridge. Async (CPU-bound seconds), fail-soft
  like the rest of the module.
- Host E2E: `rust/tests/prove_join_open_circle.rs` proves the pnyx `joinOpenCircle`
  circuit (K=14) from the committed fixture (`rust/fixtures/join_open_circle.preimage`;
  regenerate via `node --import tsx packages/midnight-native/scripts/dump-join-preimage.mts`).
  Needs `contract/managed` (`bun run compile:contract`) and the SRS cache
  (`~/.cache/midnight/zk-params` or `$MIDNIGHT_PP`) — it skips loudly if `managed/` is
  absent. Measured: ~0.9 s prove+verify release, ~234 MiB peak RSS.

Design + phase B (app↔service protocol): `docs/on-device-proving.md`.

## Status

**Android — done + verified in-app.** Rust core, C ABI + JNI bridge, `cargo test` golden vectors,
`.so` cross-compile, the local Expo module (Kotlin + autolinked via `searchPaths`), and the
`midnight-curve-backend.native.ts` wiring. `expo run:android` on an emulator logged
`[MidnightNativeCheck] PASS` — the wallet's JS reached the Rust `.so` through Expo/JSI→JNI and
returned the correct golden-vector addresses, no WASM on device.

**iOS — remaining (Mac-gated only).** `scripts/build-ios.sh` (xcframework) + a podspec; the JS
backend + JNI-equivalent C-ABI already exist. Node/Web keep the WASM backend via the same seam.

## Building

- **Rust unit test** (host): `cd rust && cargo test`
- **Android** jniLibs: `bash scripts/build-android.sh` (needs the Android NDK; auto-detects
  under `$ANDROID_HOME/ndk`, or set `ANDROID_NDK_HOME`). Produces
  `android/src/main/jniLibs/<abi>/libmidnight_native.so` for arm64-v8a + x86_64 by default.
- **iOS** `.xcframework`: must be built on macOS (cannot link iOS from Linux) —
  `bash scripts/build-ios.sh`.

Built binaries are gitignored; regenerate from the scripts.

## Toolchain notes

The Midnight crate tree has a high MSRV (needs rustc ≥ 1.89). `rustup update stable`.
The dependency tree is large (~750 crates, incl. a network stack pulled by
`midnight-base-crypto`), but LTO + strip dead-code-eliminate the unused paths: the shipped
`.so` is ~700 KB. blst (the one C dep) builds for ARM cleanly; enable its `portable` feature
if x86-asm illegal-instruction crashes appear on a device.

## Cargo features — the `proving` split

`default = ["proving"]`, so device and host builds are unchanged. Building **without** it leaves
only contract-state decoding (`state_read`, `identity`, `midns`) and drops the ledger, zkir, zswap,
coin-structure and transient-crypto dependency trees from the build entirely — not merely from the
linked output.

That exists so the same verified decoder can run in a Cloudflare Worker, where `/auth/identity`
needs to read an identity row and the chain mirror is unavailable. One decoder, two hosts, rather
than a second implementation in JS against the ledger WASM.

Measured on this crate (`wasm32-unknown-unknown`, contract state 19.9 kB):

| build | raw | gzipped |
|---|---|---|
| `--profile release` (everything) | 6.71 MB | 1.60 MB |
| `--profile wasm-min` (everything) | 4.31 MB | 1.05 MB |
| `--profile wasm-min --no-default-features --features worker` | **1.06 MB** | **0.247 MB** |

⚠️ Measure with `--features worker`. `--no-default-features` alone reports 0.53 MB / 0.125 MB, but
that module exports no `pnyx_*` function, so the linker drops the decoder entirely — the figure is
for a build containing none of the code you wanted to size.

`wasm-min` is a separate profile on purpose: it sets `opt-level = "z"`, which is right for a decode
(~0.4 ms/call natively) and wrong for the device rail, where a proof costs 0.8–2.7 s.

```bash
cargo build --no-default-features --features worker --target wasm32-unknown-unknown --profile wasm-min
# or, to place it where the Worker imports it:
bash services/content/scripts/build-wasm.sh
```

⚠️ `midnight-onchain-runtime`'s `vendored` feature is declared explicitly. It used to arrive
transitively from `midnight-ledger`; without it the build script shells out to Chez Scheme
(`scheme --script generate-rust-macros.ss`) and fails on any machine without it.
