// Exercises the REAL wasm module against REAL contract state — no mocks anywhere in this file.
//
// Node has WebAssembly, so the only difference from the Worker is where the module comes from
// (readFileSync here, a `.wasm` import there), which is exactly why `createRowDecoder` takes the
// module as an argument. What this covers that the Rust tests cannot: the JS/wasm boundary — the
// allocator, the status byte, the length out-param, and the `null` case surviving as `undefined`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRowDecoder, createStateReader, type RowDecoder } from './row-decoder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, '../wasm/identity-row.wasm');
const fixture = path.resolve(here, '../../../packages/midnight-native/rust/fixtures/identity_row_published.contract_state');
// A deployed shell with nothing published — the constructor zeroes `anchor`, so this is the state the
// decoder must report as `undefined` rather than as a failure.
const unpublishedFixture = path.resolve(here, '../../../packages/midnight-native/rust/fixtures/identity_constructed.contract_state');

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

// The identity the fixture generator publishes, and the row it wrote. Regenerate both together with
// `node --import tsx packages/midnight-native/scripts/dump-identity-fixtures.mts`: the fixture and this
// constant come from the same run, so a fixture refreshed on its own leaves this pointing at a row the
// new state does not contain.
//
// ⚠️ The wasm must be rebuilt with the fixtures whenever the contract's ledger shape changes:
// `cargo build --manifest-path packages/midnight-native/rust/Cargo.toml --target wasm32-unknown-unknown
// --no-default-features --features worker --release`, then copy `midnight_native.wasm` over
// `wasm/identity-row.wasm`. A stale module decodes the previous contract and fails loudly here, which
// is the point.
const C = fromHex('93cff1449e8338a87c278099daf8bd6b78ea8f6700770129cbc0058b81c0549c');

let decode: RowDecoder;
let state: Uint8Array;
let unpublished: Uint8Array;

beforeAll(() => {
  // Skips nothing and mocks nothing: if the artifact is missing the suite fails loudly, because a
  // silently-skipped test here would mean the Worker ships an unverified decoder.
  decode = createRowDecoder(new WebAssembly.Module(readFileSync(wasmPath)));
  state = Uint8Array.from(readFileSync(fixture));
  unpublished = Uint8Array.from(readFileSync(unpublishedFixture));
});

describe('createRowDecoder', () => {
  it('decodes a published row', () => {
    const row = decode(state, C);
    expect(row).toBeDefined();
    expect(hex(row!.anchor)).toBe('70'.repeat(32));
    expect(hex(row!.authPub)).toBe('71'.repeat(32));
    expect(hex(row!.name)).toBe('00'.repeat(32));
  });

  it('reports a deployed-but-unpublished identity as undefined, not an error', () => {
    // The distinction login depends on: this becomes "identity has not been registered" (401),
    // whereas a thrown error becomes "registry unavailable" (a different, retryable answer). Under one
    // contract per identity this is an ordinary state — the shell exists, `anchor` is still zero.
    expect(decode(unpublished, C)).toBeUndefined();
  });

  it('throws for a contract sealed to a different identity, rather than reporting absence', () => {
    // `C` is no longer a lookup key, it is checked against the sealed `id`. A mismatch means the caller
    // fetched the wrong address — its own bug — so it must not read as "this person has not registered".
    expect(() => decode(state, new Uint8Array(32).fill(0xab))).toThrow(/decode failed/);
  });

  it('throws on unreadable state rather than claiming the row is absent', () => {
    expect(() => decode(new Uint8Array(8), C)).toThrow(/decode failed/);
  });

  it('rejects a wrong-length identity before touching wasm memory', () => {
    expect(() => decode(state, new Uint8Array(31))).toThrow(/32 bytes/);
  });

  // Each call allocates and frees; a leak or a stale memory view would show up as a wrong answer
  // on a later call once the heap grows and detaches earlier views.
  it('stays correct across repeated calls', () => {
    for (let i = 0; i < 25; i++) {
      expect(hex(decode(state, C)!.anchor)).toBe('70'.repeat(32));
      expect(decode(unpublished, C)).toBeUndefined();
    }
  });
});

describe('the code digest, over the same bytes', () => {
  // ⚠️ These fixtures come from the compact **simulator**, which builds a contract state without
  // deploying — so its `operations` carry entry-point names and no verifier keys. A digest cannot be
  // computed from that, and saying so is the whole value: it is the difference between "this contract is
  // not our template" and "this state never carried keys at all".
  it('refuses a state whose operations carry no verifier keys, rather than inventing a digest', () => {
    const reader = createStateReader(new WebAssembly.Module(readFileSync(wasmPath)));
    expect(() => reader.codeDigest(state)).toThrow(/no verifier key/);
  });

  it('refuses bytes that are not a contract state at all', () => {
    const reader = createStateReader(new WebAssembly.Module(readFileSync(wasmPath)));
    expect(() => reader.codeDigest(new Uint8Array([1, 2, 3]))).toThrow(/code digest failed/);
  });

  // The row and the digest come from one instantiation, and reading one must not disturb the other:
  // both write into the same wasm heap, and a growing allocation detaches any cached view.
  it('reads a row after a digest attempt on the same instance', () => {
    const reader = createStateReader(new WebAssembly.Module(readFileSync(wasmPath)));
    expect(() => reader.codeDigest(state)).toThrow();
    expect(reader.row(state, C)).toBeDefined();
  });
});
