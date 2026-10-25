//! The Compact host bridge — what lets the **compactc-generated JS driver** run on Hermes.
//!
//! `contract/managed/<c>/contract/index.js` is plain JavaScript that Hermes executes today. What it
//! cannot execute is its runtime: `@midnight-ntwrk/compact-runtime` bottoms out in
//! `@midnight-ntwrk/onchain-runtime-v3`, a **wasm-bindgen package**, and this app is on legacy
//! Hermes V0 where `typeof WebAssembly === 'undefined'`. This module serves those leaves from the
//! same Rust crates the proving rail already links, so the driver runs unmodified and
//! `preimage.rs`'s hand-ports stop being the only way to build a transcript.
//!
//! **Why this is smaller than it looks.** Measured against the five generated drivers, a *circuit
//! call* needs only `StateValue.newCell` / `newNull` from the state API — and both are pure data
//! (`EncodedStateValue` is a tagged union, not a handle), so they stay in JS. `asCell`/`asMap`/
//! `asArray` appear only in `_equal_1` (the `ledger()` reader) and `newMap`/`newArray`/`arrayPush`
//! only in `initialState` (the constructor). Neither is on the path this module serves.
//! `addField`/`subField`/`mulField` are pure BigInt arithmetic, and `bigIntToValue`/`valueToBigInt`
//! are little-endian bytes with trailing zeros trimmed — all four stay in JS too.
//!
//! ⚠️ **The VM runs in GATHER mode here, not verify.** The generated driver emits `popeq` with
//! `result: undefined` and then *substitutes* the read contents into its own public transcript
//! afterwards (`circuit-context.js`). `preimage.rs` builds the verify-mode transcript directly
//! because it knows every answer in advance; a driver does not. Running verify here would demand
//! results the caller has not got yet.
//!
//! One dispatcher rather than eleven bridge functions — the same grouping-by-return-shape that cost
//! `signData` and `txIdentifiers` nothing (see the native-proving skill's note on the 7-file tax).
//!
//! @module

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use midnight_base_crypto::fab::{
    Alignment, AlignmentAtom, AlignmentSegment, AlignedValue, Value, ValueAtom,
};
use midnight_base_crypto::hash::{persistent_commit, persistent_hash, HashOutput};
use midnight_coin_structure::coin::{
    Commitment as CoinCommitment, Info as CoinInfo, Nonce, PublicKey as CoinPublicKey,
    ShieldedTokenType,
};
use midnight_coin_structure::contract::ContractAddress;
use midnight_coin_structure::transfer::Recipient;
use midnight_ledger::construct::ContractCallPrototype;
use midnight_onchain_runtime::context::QueryContext;
use midnight_onchain_runtime::cost_model::INITIAL_COST_MODEL;
use midnight_onchain_runtime::ops::{Key, Op};
use midnight_onchain_runtime::result_mode::{GatherEvent, ResultModeGather, ResultModeVerify};
use midnight_onchain_runtime::state::{ContractState, StateValue};
use midnight_serialize::tagged_deserialize;
use midnight_storage::arena::Sp;
use midnight_storage::DefaultDB;
use midnight_transient_crypto::curve::Fr;
use midnight_transient_crypto::fab::ValueReprAlignedValue;
use midnight_transient_crypto::repr::FieldRepr;
use midnight_transient_crypto::hash::{degrade_to_transient, transient_hash, upgrade_from_transient};
use midnight_transient_crypto::merkle_tree::leaf_hash;
use serde_json::{json, Value as J};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

type DB = DefaultDB;
type GatherOp = Op<ResultModeGather, DB>;

/// Live query contexts, keyed by the handle the JS side holds.
///
/// A handle rather than round-tripping the state: a circuit issues several `queryLedgerState` calls
/// against one evolving context, and live contract state runs to tens of kilobytes — serializing it
/// per call would make the bridge, not the VM, the cost.
static CONTEXTS: Mutex<Option<HashMap<u32, QueryContext<DB>>>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn with_contexts<R>(f: impl FnOnce(&mut HashMap<u32, QueryContext<DB>>) -> R) -> Result<R, String> {
    let mut guard = CONTEXTS.lock().map_err(|e| format!("context registry poisoned: {e}"))?;
    Ok(f(guard.get_or_insert_with(HashMap::new)))
}

// ── JSON codecs ────────────────────────────────────────────────────────────────────────────────
//
// The shapes are `@midnight-ntwrk/onchain-runtime-v3`'s published types, not ours: `Value` is
// `Uint8Array[]`, `Alignment` is a list of tagged segments, and `EncodedStateValue` is a tagged
// union. Bytes travel as hex because that is what the bridge carries.

fn as_str<'a>(v: &'a J, what: &str) -> Result<&'a str, String> {
    v.as_str().ok_or_else(|| format!("{what} is not a string"))
}

fn hex_bytes(v: &J, what: &str) -> Result<Vec<u8>, String> {
    let s = as_str(v, what)?;
    if s.len() % 2 != 0 {
        return Err(format!("{what} is not whole-byte hex"));
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| format!("{what}: {e}")))
        .collect()
}

fn bytes32(v: &J, what: &str) -> Result<[u8; 32], String> {
    let b = hex_bytes(v, what)?;
    <[u8; 32]>::try_from(b.as_slice()).map_err(|_| format!("{what} is not 32 bytes"))
}

fn parse_alignment_atom(v: &J) -> Result<AlignmentAtom, String> {
    match as_str(&v["tag"], "alignment atom tag")? {
        "compress" => Ok(AlignmentAtom::Compress),
        "field" => Ok(AlignmentAtom::Field),
        "bytes" => {
            let length = v["length"]
                .as_u64()
                .ok_or_else(|| "a bytes alignment atom needs a length".to_string())?;
            Ok(AlignmentAtom::Bytes {
                length: length as u32,
            })
        }
        other => Err(format!("unknown alignment atom `{other}`")),
    }
}

fn parse_alignment(v: &J) -> Result<Alignment, String> {
    let arr = v
        .as_array()
        .ok_or_else(|| "alignment is not an array".to_string())?;
    let mut segments = Vec::with_capacity(arr.len());
    for seg in arr {
        match as_str(&seg["tag"], "alignment segment tag")? {
            "atom" => segments.push(AlignmentSegment::Atom(parse_alignment_atom(&seg["value"])?)),
            "option" => {
                let inner = seg["value"]
                    .as_array()
                    .ok_or_else(|| "an option alignment needs an array".to_string())?;
                let mut alts = Vec::with_capacity(inner.len());
                for a in inner {
                    alts.push(parse_alignment(a)?);
                }
                segments.push(AlignmentSegment::Option(alts));
            }
            other => return Err(format!("unknown alignment segment `{other}`")),
        }
    }
    Ok(Alignment(segments))
}

fn parse_value(v: &J) -> Result<Value, String> {
    let arr = v
        .as_array()
        .ok_or_else(|| "value is not an array".to_string())?;
    let mut atoms = Vec::with_capacity(arr.len());
    for a in arr {
        atoms.push(ValueAtom(hex_bytes(a, "value atom")?));
    }
    Ok(Value(atoms))
}

fn parse_aligned(v: &J) -> Result<AlignedValue, String> {
    parse_aligned_named(v, "a value")
}

/// ⚠️ **Name what failed.** "value does not fit its alignment" with no field is a message that sends
/// the reader to the wrong half of a transcript; on a device it cost a rebuild cycle to narrow. The
/// atom widths are included because that is the comparison the caller has to make.
fn parse_aligned_named(v: &J, what: &str) -> Result<AlignedValue, String> {
    let value = parse_value(&v["value"])?;
    let alignment = parse_alignment(&v["alignment"])?;
    let widths: Vec<String> = value.0.iter().map(|a| a.0.len().to_string()).collect();
    AlignedValue::new(value, alignment).ok_or_else(|| {
        format!(
            "{what} does not fit its alignment: {} atoms of [{}] bytes against {}",
            widths.len(),
            widths.join(", "),
            v["alignment"]
        )
    })
}

fn dump_alignment_atom(a: &AlignmentAtom) -> J {
    match a {
        AlignmentAtom::Compress => json!({"tag": "compress"}),
        AlignmentAtom::Field => json!({"tag": "field"}),
        AlignmentAtom::Bytes { length } => json!({"tag": "bytes", "length": length}),
    }
}

fn dump_alignment(a: &Alignment) -> J {
    J::Array(
        a.0.iter()
            .map(|seg| match seg {
                AlignmentSegment::Atom(atom) => {
                    json!({"tag": "atom", "value": dump_alignment_atom(atom)})
                }
                AlignmentSegment::Option(alts) => {
                    json!({"tag": "option", "value": alts.iter().map(dump_alignment).collect::<Vec<_>>()})
                }
            })
            .collect(),
    )
}

fn dump_aligned(v: &AlignedValue) -> J {
    json!({
        "value": v.value.0.iter().map(|a| hex(&a.0)).collect::<Vec<_>>(),
        "alignment": dump_alignment(&v.alignment),
    })
}

/// `EncodedStateValue` → `StateValue`. Only `null` and `cell` are reachable from a circuit call;
/// `map` / `array` / `boundedMerkleTree` belong to `initialState`, which this bridge does not serve
/// — refused by name rather than half-implemented.
fn parse_state_value(v: &J) -> Result<StateValue<DB>, String> {
    match as_str(&v["tag"], "state value tag")? {
        "null" => Ok(StateValue::Null),
        "cell" => Ok(StateValue::Cell(Sp::new(parse_aligned(&v["content"])?))),
        other @ ("map" | "array" | "boundedMerkleTree") => Err(format!(
            "a `{other}` state value is only built by `initialState`, which this bridge does not serve"
        )),
        other => Err(format!("unknown state value tag `{other}`")),
    }
}

fn parse_key(v: &J) -> Result<Key, String> {
    match as_str(&v["tag"], "key tag")? {
        "stack" => Ok(Key::Stack),
        "value" => Ok(Key::Value(parse_aligned(&v["value"])?)),
        other => Err(format!("unknown key tag `{other}`")),
    }
}

fn u8_field(v: &J, key: &str) -> Result<u8, String> {
    v[key]
        .as_u64()
        .and_then(|n| u8::try_from(n).ok())
        .ok_or_else(|| format!("`{key}` is not a byte"))
}

fn u32_field(v: &J, key: &str) -> Result<u32, String> {
    v[key]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| format!("`{key}` is not a u32"))
}

fn bool_field(v: &J, key: &str) -> Result<bool, String> {
    v[key]
        .as_bool()
        .ok_or_else(|| format!("`{key}` is not a boolean"))
}

/// One `Op<ResultModeGather>`, in the shape the compiler emits: a bare string for the nullary ops,
/// a single-key object otherwise.
fn parse_op(v: &J) -> Result<GatherOp, String> {
    if let Some(name) = v.as_str() {
        return match name {
            "lt" => Ok(Op::Lt),
            "eq" => Ok(Op::Eq),
            "type" => Ok(Op::Type),
            "size" => Ok(Op::Size),
            "new" => Ok(Op::New),
            "and" => Ok(Op::And),
            "or" => Ok(Op::Or),
            "neg" => Ok(Op::Neg),
            "log" => Ok(Op::Log),
            "root" => Ok(Op::Root),
            "pop" => Ok(Op::Pop),
            "add" => Ok(Op::Add),
            "sub" => Ok(Op::Sub),
            "member" => Ok(Op::Member),
            "ckpt" => Ok(Op::Ckpt),
            other => Err(format!("unknown op `{other}`")),
        };
    }
    let obj = v
        .as_object()
        .ok_or_else(|| "an op is a string or an object".to_string())?;
    let (name, body) = obj
        .iter()
        .next()
        .ok_or_else(|| "an op object has one key".to_string())?;
    match name.as_str() {
        "noop" => Ok(Op::Noop {
            n: u32_field(body, "n")?,
        }),
        // ⚠️ Gather mode carries no result — the driver substitutes the read contents afterwards.
        "popeq" => Ok(Op::Popeq {
            cached: bool_field(body, "cached")?,
            result: (),
        }),
        "addi" => Ok(Op::Addi {
            immediate: u32_field(body, "immediate")?,
        }),
        "subi" => Ok(Op::Subi {
            immediate: u32_field(body, "immediate")?,
        }),
        "push" => Ok(Op::Push {
            storage: bool_field(body, "storage")?,
            value: parse_state_value(&body["value"])?,
        }),
        "branch" => Ok(Op::Branch {
            skip: u32_field(body, "skip")?,
        }),
        "jmp" => Ok(Op::Jmp {
            skip: u32_field(body, "skip")?,
        }),
        "concat" => Ok(Op::Concat {
            cached: bool_field(body, "cached")?,
            n: u32_field(body, "n")?,
        }),
        "rem" => Ok(Op::Rem {
            cached: bool_field(body, "cached")?,
        }),
        "dup" => Ok(Op::Dup {
            n: u8_field(body, "n")?,
        }),
        "swap" => Ok(Op::Swap {
            n: u8_field(body, "n")?,
        }),
        "idx" => {
            let path = body["path"]
                .as_array()
                .ok_or_else(|| "an idx op needs a path array".to_string())?
                .iter()
                .map(parse_key)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Op::Idx {
                cached: bool_field(body, "cached")?,
                push_path: bool_field(body, "pushPath")?,
                path: path.into(),
            })
        }
        "ins" => Ok(Op::Ins {
            cached: bool_field(body, "cached")?,
            n: u8_field(body, "n")?,
        }),
        other => Err(format!("unknown op `{other}`")),
    }
}

fn parse_program(v: &J) -> Result<Vec<GatherOp>, String> {
    v.as_array()
        .ok_or_else(|| "program is not an array".to_string())?
        .iter()
        .map(parse_op)
        .collect()
}

/// A field element as the JS side reads it: little-endian bytes with trailing zeros trimmed, which
/// is exactly `bigIntToValue`'s encoding — so JS turns this into a `bigint` with no native help.
fn dump_field(x: Fr) -> String {
    let mut bytes = x.as_le_bytes();
    while bytes.last() == Some(&0) {
        bytes.pop();
    }
    hex(&bytes)
}

fn parse_field(v: &J, what: &str) -> Result<Fr, String> {
    let mut le = hex_bytes(v, what)?;
    if le.len() > 32 {
        return Err(format!("{what} is wider than a field element"));
    }
    le.resize(32, 0);
    let arr = <[u8; 32]>::try_from(le.as_slice()).expect("resized to 32");
    // ⚠️ Refused, never reduced. A non-canonical field element silently wrapped would prove a
    // statement nobody asked for — the same rule `prove_circuit_binding` already holds to.
    Fr::from_le_bytes(&arr).ok_or_else(|| format!("{what} is not a canonical field element"))
}

/// `(alignment, value)` as every hashing built-in passes it: the JS side has already run
/// `rtType.alignment()` and `rtType.toValue(value)`, both pure JS.
fn aligned_arg(args: &J) -> Result<AlignedValue, String> {
    AlignedValue::new(parse_value(&args["value"])?, parse_alignment(&args["alignment"])?)
        .ok_or_else(|| "value does not fit its alignment".to_string())
}

/// The bytes `persistentHash` / `persistentCommit` digest: every atom **padded to the width its
/// alignment declares**, concatenated.
///
/// ⚠️ Measured against the real WASM rather than inferred — `persistentHash` of a
/// `Vector<2, Bytes<32>>` is byte-identical to `SHA256(tag ‖ sk)`, which is the shape
/// `persona_commitment` has always hand-computed in `preimage.rs`. The padding is what makes the two
/// agree: an atom is stored with its trailing zeros trimmed and hashed at full width.
fn padded_bytes(v: &AlignedValue) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut atoms = v.value.0.iter();
    for segment in v.alignment.0.iter() {
        let AlignmentSegment::Atom(atom) = segment else {
            // An option alignment is a sum type; nothing we hash uses one, and padding it by guess
            // would produce a digest that matches nothing.
            return Err("an option alignment cannot be hashed by this bridge".to_string());
        };
        let width = match atom {
            AlignmentAtom::Bytes { length } => *length as usize,
            AlignmentAtom::Field | AlignmentAtom::Compress => 32,
        };
        let bytes = atoms.next().map(|a| a.0.as_slice()).unwrap_or(&[]);
        if bytes.len() > width {
            return Err(format!("an atom is {} bytes for a {width}-byte alignment", bytes.len()));
        }
        out.extend_from_slice(bytes);
        out.resize(out.len() + width - bytes.len(), 0);
    }
    Ok(out)
}

// ── Zswap coins ────────────────────────────────────────────────────────────────────────────────
//
// `runtimeCoinCommitment` is the one zswap leaf `compact-runtime` cannot compute for itself, and
// the only one a circuit of ours reaches (`payment.buyPermitShielded`, via `receiveShielded` and
// `sendImmediateShielded`). Everything else on that surface — the eight coin/key encoders — is
// plain hex and stays in JS.
//
// The two parsers below read an aligned value through [`padded_bytes`] instead of atom by atom, so
// the declared alignment does the checking: a coin value wider than the eight bytes it declares is
// refused here exactly as the WASM refuses it, rather than silently truncated into a commitment
// that names a different coin.

/// `ShieldedCoinInfo` as its descriptor lays it out: nonce `Bytes<32>`, color `Bytes<32>`, value
/// `Uint<64>` — 72 bytes once every atom is padded back to its declared width.
fn parse_coin_info(v: &J, what: &str) -> Result<CoinInfo, String> {
    let bytes = padded_bytes(&aligned_arg(v)?)?;
    let Ok(fixed) = <[u8; 72]>::try_from(bytes.as_slice()) else {
        return Err(format!("{what} is not a ShieldedCoinInfo: {} bytes, expected 72", bytes.len()))
    };
    let mut nonce = [0u8; 32];
    nonce.copy_from_slice(&fixed[..32]);
    let mut color = [0u8; 32];
    color.copy_from_slice(&fixed[32..64]);
    let mut value = [0u8; 8];
    value.copy_from_slice(&fixed[64..]);
    Ok(CoinInfo {
        nonce: Nonce(HashOutput(nonce)),
        type_: ShieldedTokenType(HashOutput(color)),
        value: u64::from_le_bytes(value) as u128,
    })
}

/// `Either<ZswapCoinPublicKey, ContractAddress>` — 65 bytes: the tag, then both arms at full width.
///
/// ⚠️ **Left is the user, right is the contract**, which is the opposite way round from the
/// *unshielded* `Either<ContractAddress, UserAddress>` the same contract also carries. Reading the
/// wrong arm produces a commitment that verifies against nothing and names no cause.
fn parse_recipient(v: &J, what: &str) -> Result<Recipient, String> {
    let bytes = padded_bytes(&aligned_arg(v)?)?;
    let Ok(fixed) = <[u8; 65]>::try_from(bytes.as_slice()) else {
        return Err(format!("{what} is not a coin recipient: {} bytes, expected 65", bytes.len()))
    };
    let mut arm = [0u8; 32];
    if fixed[0] == 1 {
        arm.copy_from_slice(&fixed[1..33]);
        Ok(Recipient::User(CoinPublicKey(HashOutput(arm))))
    } else if fixed[0] == 0 {
        arm.copy_from_slice(&fixed[33..]);
        Ok(Recipient::Contract(ContractAddress(HashOutput(arm))))
    } else {
        Err(format!("{what} has a tag of {}, which is neither arm", fixed[0]))
    }
}

type VerifyOp = Op<ResultModeVerify, DB>;

/// The same op shape, in **verify** mode — `popeq` now carries the result the driver substituted
/// after its gather pass. Written as a conversion rather than a second parser so the two can only
/// disagree about `popeq`, which is the only place they differ.
fn to_verify(op: GatherOp, result: Option<AlignedValue>) -> Result<VerifyOp, String> {
    Ok(match op {
        Op::Popeq { cached, .. } => Op::Popeq {
            cached,
            result: result.ok_or_else(|| "a popeq in a verify transcript needs its result".to_string())?,
        },
        Op::Noop { n } => Op::Noop { n },
        Op::Lt => Op::Lt,
        Op::Eq => Op::Eq,
        Op::Type => Op::Type,
        Op::Size => Op::Size,
        Op::New => Op::New,
        Op::And => Op::And,
        Op::Or => Op::Or,
        Op::Neg => Op::Neg,
        Op::Log => Op::Log,
        Op::Root => Op::Root,
        Op::Pop => Op::Pop,
        Op::Add => Op::Add,
        Op::Sub => Op::Sub,
        Op::Member => Op::Member,
        Op::Ckpt => Op::Ckpt,
        Op::Addi { immediate } => Op::Addi { immediate },
        Op::Subi { immediate } => Op::Subi { immediate },
        Op::Push { storage, value } => Op::Push { storage, value },
        Op::Branch { skip } => Op::Branch { skip },
        Op::Jmp { skip } => Op::Jmp { skip },
        Op::Concat { cached, n } => Op::Concat { cached, n },
        Op::Rem { cached } => Op::Rem { cached },
        Op::Dup { n } => Op::Dup { n },
        Op::Swap { n } => Op::Swap { n },
        Op::Idx { cached, push_path, path } => Op::Idx { cached, push_path, path },
        Op::Ins { cached, n } => Op::Ins { cached, n },
        other => return Err(format!("op {other:?} has no verify-mode form")),
    })
}

/// One entry of a verify-mode program: the op, plus the `popeq` result when it has one.
fn parse_verify_op(v: &J) -> Result<VerifyOp, String> {
    let result = v
        .get("popeq")
        .and_then(|p| p.get("result"))
        .filter(|r| !r.is_null())
        .map(|r| parse_aligned_named(r, "a popeq result"))
        .transpose()?;
    to_verify(parse_op(v)?, result)
}


// ── A shielded call's Zswap half ───────────────────────────────────────────────────────────────
//
// The driver's `ZswapLocalState`, as JSON. Its shapes are the runtime's own — a coin is
// `{nonce, color, value}` (plus `mt_index` when spent) and a recipient is the structured `Either`
// the circuit took, not an aligned value — so these parse the *encoded* form rather than reusing
// `parse_recipient`, which reads the alignment-framed one.

fn u128_field(v: &J, what: &str) -> Result<u128, String> {
    as_str(v, what)?
        .parse()
        .map_err(|e| format!("{what}: {e}"))
}

fn parse_circuit_coin(v: &J, what: &str) -> Result<crate::shielded_call::CircuitCoin, String> {
    Ok(crate::shielded_call::CircuitCoin {
        nonce: bytes32(&v["nonce"], &format!("{what} nonce"))?,
        color: bytes32(&v["color"], &format!("{what} colour"))?,
        value: u128_field(&v["value"], &format!("{what} value"))?,
        // Absent on an output, which has no index until it is on chain.
        mt_index: v["mt_index"].as_str().map_or(Ok(0), |s| {
            s.parse::<u64>().map_err(|e| format!("{what} Merkle index: {e}"))
        })?,
    })
}

/// `Either<ZswapCoinPublicKey, ContractAddress>` in its encoded form. ⚠️ **Left is the user** — the
/// opposite way round from the unshielded `Either<ContractAddress, UserAddress>` the same contract
/// also carries.
fn parse_circuit_recipient(v: &J) -> Result<crate::shielded_call::CircuitRecipient, String> {
    let is_left = v["is_left"]
        .as_bool()
        .ok_or_else(|| "a recipient's `is_left` is not a boolean".to_string())?;
    if is_left {
        Ok(crate::shielded_call::CircuitRecipient::User {
            coin_public_key: bytes32(&v["left"]["bytes"], "recipient coin public key")?,
            // ⚠️ Never in the circuit's own value — a `ZswapCoinPublicKey` is half an address, and
            // the encryption half is what lets a recipient find the coin by scanning. A caller that
            // knows the full shielded address supplies it here; one that does not leaves the
            // recipient dependent on being told the coin's three fields.
            encryption_public_key: match v["encryptionPublicKey"].as_str() {
                None => None,
                Some(_) => Some(bytes32(&v["encryptionPublicKey"], "recipient encryption key")?),
            },
        })
    } else {
        Ok(crate::shielded_call::CircuitRecipient::Contract(bytes32(
            &v["right"]["bytes"],
            "recipient contract address",
        )?))
    }
}

/// A file the host already fetched and hash-checked. Read here rather than carried as hex, for the
/// reason `tx.buildShielded` states.
fn read_artifact(v: &J, what: &str) -> Result<Vec<u8>, String> {
    let path = as_str(v, &format!("{what} path"))?;
    std::fs::read(path).map_err(|e| format!("read {what} from `{path}`: {e}"))
}

fn parse_circuit_outputs(v: &J) -> Result<Vec<crate::shielded_call::CircuitOutput>, String> {
    v.as_array()
        .ok_or_else(|| "zswap outputs is not an array".to_string())?
        .iter()
        .map(|o| {
            Ok(crate::shielded_call::CircuitOutput {
                coin: parse_circuit_coin(&o["coinInfo"], "an output coin")?,
                recipient: parse_circuit_recipient(&o["recipient"])?,
            })
        })
        .collect()
}

// ── The dispatcher ─────────────────────────────────────────────────────────────────────────────

/// Serve one Compact-runtime leaf. `args` and the result are JSON; errors are returned, never
/// panicked, because the caller is a JS driver mid-circuit and its own error path is the right one.
pub fn compact_op(op: &str, args_json: &str) -> Result<String, String> {
    let args: J =
        serde_json::from_str(args_json).map_err(|e| format!("arguments are not JSON: {e}"))?;
    let out: J = match op {
        "ctx.new" => {
            let state_bytes = hex_bytes(&args["state"], "contract state")?;
            let state: ContractState<DB> = tagged_deserialize(&mut &state_bytes[..])
                .map_err(|e| format!("deserialize contract state: {e}"))?;
            let address = ContractAddress(HashOutput(bytes32(&args["address"], "contract address")?));
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            with_contexts(|m| m.insert(id, QueryContext::new(state.data, address)))?;
            json!({ "id": id })
        }
        "ctx.query" => {
            let id = u32_field(&args, "id")?;
            let program = parse_program(&args["program"])?;
            let results = with_contexts(|m| {
                let ctx = m
                    .get(&id)
                    .ok_or_else(|| format!("no query context {id}"))?
                    .clone();
                let results = ctx
                    .query::<ResultModeGather>(&program, None, &INITIAL_COST_MODEL)
                    .map_err(|e| format!("transcript rejected by runtime: {e:?}"))?;
                m.insert(id, results.context.clone());
                Ok::<_, String>(results)
            })??;
            // Only `read` events matter to a driver; a `log` carries a whole state value and no
            // circuit of ours emits one, so it is named rather than silently dropped.
            let mut events = Vec::with_capacity(results.events.len());
            for event in results.events.iter() {
                match event {
                    GatherEvent::Read(value) => {
                        events.push(json!({"tag": "read", "content": dump_aligned(value)}));
                    }
                    other => return Err(format!("unsupported VM event: {other:?}")),
                }
            }
            json!({
                "events": events,
                "gasCost": {
                    "readTime": results.gas_cost.read_time.into_picoseconds().to_string(),
                    "computeTime": results.gas_cost.compute_time.into_picoseconds().to_string(),
                    "bytesWritten": results.gas_cost.bytes_written.to_string(),
                    "bytesDeleted": results.gas_cost.bytes_deleted.to_string(),
                },
            })
        }
        "ctx.free" => {
            let id = u32_field(&args, "id")?;
            with_contexts(|m| m.remove(&id))?;
            json!({})
        }
        "hash.persistent" => {
            let v = aligned_arg(&args)?;
            json!({"out": hex(&persistent_hash(&padded_bytes(&v)?).0)})
        }
        "hash.persistentCommit" => {
            let v = aligned_arg(&args)?;
            let opening = bytes32(&args["opening"], "commitment opening")?;
            json!({
                "out": hex(&persistent_commit(padded_bytes(&v)?.as_slice(), HashOutput(opening)).0)
            })
        }
        "hash.transient" => {
            let v = aligned_arg(&args)?;
            json!({"out": dump_field(transient_hash(&ValueReprAlignedValue(v).field_vec()))})
        }
        "hash.degrade" => {
            let input = bytes32(&args["input"], "degradeToTransient input")?;
            json!({"out": dump_field(degrade_to_transient(HashOutput(input)))})
        }
        "hash.upgrade" => {
            let x = parse_field(&args["input"], "upgradeFromTransient input")?;
            json!({"out": hex(&upgrade_from_transient(x).0)})
        }
        "leaf.hash" => {
            let v = aligned_arg(&args)?;
            json!({"out": hex(&leaf_hash(&ValueReprAlignedValue(v)).0)})
        }
        "zswap.coinCommitment" => {
            // The crate's own `Info::commitment`, so the domain tag and the binary layout stay
            // upstream's rather than becoming a second spelling of them here.
            let coin = parse_coin_info(&args["coin"], "the coin")?;
            let recipient = parse_recipient(&args["recipient"], "the recipient")?;
            json!({"out": hex(&coin.commitment(&recipient).0 .0)})
        }
        "ctx.insertCommitment" => {
            // Where a coin received in this transaction gets its Merkle index, so a later circuit
            // can `qualify` it into something spendable. `buyPermitShielded` spends its coin in the
            // same circuit and never reads this back — but `createZswapOutput` writes it on every
            // shielded send, and a bridge that refused would break the receive it rides on.
            let id = u32_field(&args, "id")?;
            let commitment =
                CoinCommitment(HashOutput(bytes32(&args["commitment"], "coin commitment")?));
            let index: u64 = as_str(&args["index"], "commitment index")?
                .parse()
                .map_err(|e| format!("commitment index: {e}"))?;
            with_contexts(|m| {
                let ctx = m.get_mut(&id).ok_or_else(|| format!("no query context {id}"))?;
                ctx.call_context.com_indices =
                    ctx.call_context.com_indices.insert(commitment, index);
                Ok::<_, String>(())
            })??;
            json!({})
        }
        "preimage.build" => {
            // The driver has run its circuit and holds a finished transcript; this is
            // `build_prototype`'s tail with the program supplied instead of hand-written. Running
            // it against the real state again is not redundant — it is the check that the JS
            // transcript actually executes, before anything spends a proof on it.
            let prototype = build_from_transcript(&args)?;
            json!({"preimage": hex(&crate::preimage::prototype_to_preimage(prototype)?)})
        }
        "tx.build" => {
            // ⚠️ **A standalone preimage cannot be transplanted into a transaction.**
            // `Transaction::prove` overwrites each call's `binding_input` with the intent's Pedersen
            // binding commitment, so proving the circuit alone and wrapping it afterwards produces a
            // proof for a statement the transaction does not make. Tx-level proving is the only
            // route to something submittable — the same reason `build_*_proven_tx` exists.
            let prototype = build_from_transcript(&args)?;
            let tx = crate::tx::assemble_proven_tx(
                prototype,
                &hex_bytes(&args["zkir"], "zkir")?,
                &hex_bytes(&args["proverKey"], "prover key")?,
                &hex_bytes(&args["verifierKey"], "verifier key")?,
                &hex_bytes(&args["params"], "params")?,
                as_str(&args["networkId"], "network id")?,
                args["ttlSecs"].as_u64().ok_or_else(|| "ttlSecs is not a number".to_string())?,
            )?;
            json!({"tx": hex(&tx)})
        }
        "tx.buildShielded" => {
            // A call that moves shielded value. Same transcript arguments as `tx.build`, plus the
            // driver's `ZswapLocalState` and the wallet that funds it — see `shielded_call.rs` for
            // why a transcript alone is rejected on chain.
            let prototype = build_from_transcript(&args)?;
            let (tx, wallet_state) =
                crate::shielded_call::build_shielded_call_tx(crate::shielded_call::ShieldedCallRequest {
                    prototype,
                    circuit_inputs: &args["zswap"]["inputs"]
                        .as_array()
                        .ok_or_else(|| "zswap inputs is not an array".to_string())?
                        .iter()
                        .map(|c| parse_circuit_coin(c, "an input coin"))
                        .collect::<Result<Vec<_>, _>>()?,
                    circuit_outputs: &parse_circuit_outputs(&args["zswap"]["outputs"])?,
                    // ⚠️ `walletState`, not `state`: `state` is already the *contract* state this
                    // transcript ran against, and conflating the two would fund from a contract.
                    state: &hex_bytes(&args["walletState"], "wallet state")?,
                    zswap_role_key: &bytes32(&args["zswapRoleKey"], "zswap role key")?,
                    // ⚠️ **Paths, not hex.** `buyPermitShielded`'s prover key is 19.5 MB; hex-encoding
                    // it would put ~39 MB of string across the JSI boundary per call, which is the
                    // cost that turned a 3.6 s dApp proof into a 46 s one before it was measured.
                    // Every large static artifact travels as a path on this rail.
                    zkir: &read_artifact(&args["zkirPath"], "zkir")?,
                    prover_key: &read_artifact(&args["proverKeyPath"], "prover key")?,
                    verifier_key: &read_artifact(&args["verifierKeyPath"], "verifier key")?,
                    zswap_artifact_dir: as_str(&args["zswapArtifactDir"], "zswap artifact dir")?,
                    params_dir: as_str(&args["paramsDir"], "params dir")?,
                    network_id: as_str(&args["networkId"], "network id")?,
                    ttl_secs: args["ttlSecs"]
                        .as_u64()
                        .ok_or_else(|| "ttlSecs is not a number".to_string())?,
                    segment: args["segment"]
                        .as_u64()
                        .map_or(Ok(crate::tx::CALL_SEGMENT), |n| {
                            u16::try_from(n).map_err(|_| "segment is not a u16".to_string())
                        })?,
                })?;
            json!({"tx": hex(&tx), "walletState": hex(&wallet_state)})
        }
        other => return Err(format!("unknown compact op `{other}`")),
    };
    Ok(out.to_string())
}

/// The shared middle of `preimage.build` and `tx.build`: a driver's finished transcript, run against
/// the state it was produced from, as a `ContractCallPrototype`.
///
/// Running it again is not redundant — it is the check that the JS transcript actually executes,
/// before anything spends a proof on it.
fn build_from_transcript(args: &J) -> Result<ContractCallPrototype<DB>, String> {
    let state_bytes = hex_bytes(&args["state"], "contract state")?;
    let state: ContractState<DB> = tagged_deserialize(&mut &state_bytes[..])
        .map_err(|e| format!("deserialize contract state: {e}"))?;
    let address = ContractAddress(HashOutput(bytes32(&args["address"], "contract address")?));
    let entry_point = as_str(&args["entryPoint"], "entry point")?.to_string();
    let program = args["program"]
        .as_array()
        .ok_or_else(|| "program is not an array".to_string())?
        .iter()
        .map(parse_verify_op)
        .collect::<Result<Vec<_>, _>>()?;
    let private = args["privateTranscriptOutputs"]
        .as_array()
        .ok_or_else(|| "privateTranscriptOutputs is not an array".to_string())?
        .iter()
        .enumerate()
        .map(|(i, v)| parse_aligned_named(v, &format!("private transcript output {i}")))
        .collect::<Result<Vec<_>, _>>()?;
    crate::preimage::build_prototype(
        state.data,
        address,
        entry_point.as_bytes(),
        // `KeyLocation` is `Cow<'static, str>`, so the circuit name has to outlive the call.
        Box::leak(entry_point.clone().into_boxed_str()),
        program,
        private,
        parse_aligned_named(&args["input"], "the circuit's input")?,
        parse_aligned_named(&args["output"], "the circuit's output")?,
    )
}

/// The contract state a context now holds, tagged-serialized — what `tx`/proving consumes next.
pub fn compact_context_state(id: u32) -> Result<Vec<u8>, String> {
    with_contexts(|m| {
        let ctx = m.get(&id).ok_or_else(|| format!("no query context {id}"))?;
        let mut out = Vec::new();
        midnight_serialize::tagged_serialize(&ctx.state, &mut out)
            .map_err(|e| format!("serialize context state: {e}"))?;
        Ok::<_, String>(out)
    })?
}
