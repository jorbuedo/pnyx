# @pnyx/ur

Uniform Resources — the QR envelope used by Keystone-compatible wallets and dApps. Built for
Phase 11 item 29 (Pnyx as the air-gapped signer); item 28 reuses the same codec in the other
direction.

**In-repo rather than a dependency**, decided 2026-08-06: `@keystonehq/bc-ur-registry-cardano` was
last published Dec 2024 and sits on `@ngraveio/bc-ur`, still `2.0.0-beta`, class-based, with
`buffer` and `@bacons/text-decoder` polyfills — against the no-classes, Effect-native,
cross-platform and dependency-approval rules at once. Full reasoning:
`docs/mobile-shell-plan.md` Phase 11.

## What is here

| Layer | Spec | State |
|---|---|---|
| CRC-32 | BCR-2020-005 | ✅ verified against the standard check value and BCR's `"Wolf"` vector |
| Bytewords | BCR-2020-012 | ✅ all three styles, verified against the spec's worked example |
| Xoshiro256\*\* | BCR-2024-001 | ✅ verified against the reference `"Wolf"` sequence |
| Alias sampler + fountain selection | BCR-2024-001 | ✅ verified against all 30 published index sets and the encoder's fragment bytes |
| UR string format (single + multi-part) | BCR-2020-005 | ✅ single-part reproduces the reference vector; uppercase input accepted |
| Fountain encoder / decoder | BCR-2024-001 | ✅ round-trips under heavy frame loss and from mixed parts alone |
| `cardano-sign-request` / `-signature` / `-utxo` / `-cert-key` | Keystone 2201–2204 | ✅ encode + decode, keys read off the published sources |
| `crypto-hdkey` / `crypto-coin-info` / `crypto-multi-accounts` | BCR-2020-007, Keystone 1103 | ✅ **encode only** — item 29 publishes accounts, it never reads them |
| `qr-hardware-call` (1301/1302) | Keystone | ✅ **decode only** — a companion asking which keys to export; pinned to a real Eternl call |
| `cardano-sign-tx-hash-request` | Keystone 2212 | ⛔ refused by design — a bare hash has nothing to review |
| Everything else in 2205–2211 (sign-data, CIP-8, Catalyst) | Keystone | ⬜ not started, not needed for item 29 |

**Verified against a real counterparty, both directions** — the Eternl browser extension, which
speaks Keystone for Cardano. It read our `crypto-multi-accounts` export and displayed both account
keys byte-for-byte as we derive them, and it accepted a `cardano-signature` we produced: a preprod
transaction from the `abandon … about` wallet, signed by Pnyx and submitted by Eternl. No Keystone
hardware has read any of it — a Keystone-compatible wallet has.

That settles two of the three original guesses. `keyData` as a 32-byte ed25519 key with the chain
code in `chainCode` is right, and so is the `hash160(rootPublicKey)[0..4]` master fingerprint —
neither could have produced matching account keys otherwise.

⚠️ **One guess is still open: the direction of `use_info` (305).** It carries SLIP-44 type 1815 plus
the network, and is the only place an export says which network its xpubs are for. BCR-2020-007
numbers `mainnet = 0`, the **inverse** of Cardano's own network id; a wallet reading it the other way
round would offer testnet addresses for mainnet funds. Both sessions ran on preprod, so a
consistently-inverted reading would have looked identical to a correct one. A mainnet export is what
settles it.

**Consumers.** The app screens are under `app/src/screens/cardano/airgap/`, with the
decision and shaping logic in `app/src/services/keystone/`. Scanning has no surface of its
own: `app/scan.tsx` recognises a UR frame with `isUrFrame`, accumulates the sequence, and routes the
reassembled message by type — a sign request to the request screen, a `qr-hardware-call` to the
export screen. That routing is the export screen's only entry point; there is no way to publish
keys the scanner was not asked for.

**Presenting a UR is three decisions, and `AnimatedQRCode` owns all three.** A camera locks onto a
QR by module, so every one of them is really about how many screen pixels one module gets.

1. **Frames are uppercased.** A UR is case-insensitive by design and QR alphanumeric mode has no
   lowercase, so the canonical spelling is encoded at 8 bits a character where the uppercase form
   costs 5.5. Measured on a real 1.2 KB export: version 17 (85 modules) against version 13 (69).
   `decodeUr` lowercases on the way in, so this is symmetric with what other devices emit.
2. **The fragment budget is 150 bytes**, which keeps a typical account export and witness set
   inside version 11 (61 modules). Frames are cheap — the fountain means a missed one costs
   nothing — and a smaller symbol scans faster than a larger one does.
3. **The code fills the width it is given** (`QRCard`'s `fill`), rather than any fixed size, and
   the card's padding is the quiet zone the spec requires. Drawn straight onto a themed surface a
   symbol has none, and scanners can fail to lock on. The symbol itself is square — a corner radius
   on it clips the finder patterns a scanner locates the code by; the card is what gets rounded.

**The handshake is the only way to export.** Eternl shows a `qr-hardware-call` naming the paths it
wants (`m/1854'/1815'/0'` *and* `m/1852'/1815'/0'`) before it will scan an export;
`hardware-call.test.ts` pins a real one. It *will* also read an unsolicited export — and that is
exactly the problem, see below — so the app no longer offers one.

⚠️ **And it assigns the keys we send back by position, ignoring the `origin` path each one carries.**
Two runs on 2026-08-07, same mnemonic, same keys:

| Export | Order sent | Result |
| --- | --- | --- |
| Unsolicited, from Wallet settings | 1852, 1854 | chains **swapped** — multisig receive address under the ordinary account |
| Answering its `qr-hardware-call` | 1854, 1852 | correct |

Every key carried a correct `origin` in both. **The call is therefore the ordering**, and
`cardanoMultiAccounts` imposes none of its own: the caller's list is the wire order, and the scanned
path answers in the order the call named. Do not "tidy" that into ascending purpose order — that is
the arrangement that shipped broken.

Which is why **the unsolicited export was deleted 2026-08-07** rather than reordered. Publishing a
guess means guessing an order too, no fixed one can be right for two positional readers with
opposite conventions, and the failure is silent: the companion connects, shows an account, and it is
the wrong chain. Answering a call is the only form of this that is correct by construction.

## Conventions worth knowing before extending it

**Decoding returns a typed failure; encoding throws.** This parses camera input, so malformed is
an expected outcome rather than an exception. A caller handing the encoder something unencodable
is a bug in the caller.

**The word table is one string, not an array literal.** A dropped entry changes the length and
trips the import-time invariant, instead of silently shifting every later byte by one. Three
properties are asserted at import: 256 words, all four letters, and unique first+last pairs (the
last is what makes the `minimal` style decodable).

**Encode and decode are exact inverses**, including for an empty payload — which encodes to a
bare 4-byte checksum. Some reference implementations require at least one payload byte; that is a
UR-level rule (a UR always carries CBOR) and is enforced there, not here.

## The fountain path is consensus-critical — treat it as protocol, not code

Two devices that never speak must derive the same fragment subsets, so several things that look
like implementation detail are wire format. Changing any of them breaks interop *silently*: parts
1..`seqLen` are pure, so they keep decoding, and only mixed parts resolve to the wrong fragments.

- The RNG is seeded from **SHA-256 of** `seqNum || checksum`, both big-endian `uint32`, read into
  the state **big-endian** (digest bytes 0–7 → s0, and so on).
- `nextInt(low, high)` is **inclusive of both ends**.
- The alias sampler fills its worklists **backwards** (index n-1 first) and pops from the end.
- `randomSampler.next` draws **two** doubles even when the second is unused, and `chooseDegree`
  runs **before** the shuffle. The generator is shared, so consuming a different number of draws
  shifts every subsequent index.

⚠️ **A trap in the published vectors**: the reference's `test_rng_1` is `next() % 100`, *not*
`nextInt(0, 99)`. Reading it as the latter makes a correct generator look broken. That vector pins
the state machine only; `nextInt` and `nextDouble` are pinned by the fragment-selection vectors,
which route through the shuffle.

## CBOR comes from `@evolution-sdk/evolution` — do not add a second one

Settled 2026-08-06. A part is a 5-element array `[seqNum, seqLen, messageLen, checksum, data]`, a
single-part UR carries a CBOR byte string, and the registry items need tags, maps and nesting.

`Cbor` from `@evolution-sdk/evolution/CBORBuilder` covers all of it: unsigned and negative integers, byte and text
strings, arrays, maps, tags, specials and raw spans, with indefinite-length handling and a depth
guard. **Nothing about it is Cardano-specific** — it is a general RFC 8949 codec that happens to
live in that package, and it was re-exported precisely so this package could use it instead of
growing a parallel implementation.

⚠️ **Re-sourced 2026-10-12.** The rule was settled 2026-08-06 against `@pnyx/cardano-effect`, which
is retired and has no import sites left. The rule is unchanged, only the source: this package
depends on `@evolution-sdk/evolution` and imports `* as Cbor from '@evolution-sdk/evolution/CBORBuilder'`
(see `src/part.ts`, `src/registry/hardware-call.ts`, `src/registry/cardano-cip8.ts`).

This matches both references, which is the check that decided it: bc-ur vendors `cbor-lite.hpp`, a
complete general CBOR library, and `@ngraveio/bc-ur` depends on `cbor2`. Neither writes a
UR-specific CBOR subset, and neither should we.
