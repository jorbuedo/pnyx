// Decode an identity row from serialized contract state, using the same Rust decoder the app runs
// on device (`packages/midnight-native/rust/src/identity.rs`) compiled to wasm32.
//
// One decoder, two hosts. The alternative was a second implementation in JS against the ledger
// WASM: 4.4 MB gzipped (over the free Worker limit) and a second encoding to keep in step with the
// circuit that writes the row. This module is ~0.125 MB gzipped and shares the Rust tests that run
// against real preprod bytes.
//
// The `WebAssembly.Module` is injected rather than imported here so this file runs unchanged under
// vitest (which reads the file) and workerd (which supplies the module via a `.wasm` import).

/** A row exactly as the ledger holds it: three 32-byte fields. */
export type IdentityRowBytes = {
  readonly anchor: Uint8Array;
  readonly authPub: Uint8Array;
  readonly name: Uint8Array;
};

export type RowDecoder = (state: Uint8Array, identity: Uint8Array) => IdentityRowBytes | undefined;

/**
 * The two things a host needs from one contract state: the row, and whether the contract is built from
 * a template it trusts.
 *
 * Both, from one instantiation. Separate decoders would mean instantiating the module twice per isolate
 * to answer two questions about the same bytes.
 */
export type StateReader = {
  readonly row: RowDecoder;
  /** `sha256(name ‖ hex(sha256(verifierKey)))` over the sorted entry points — the artifacts manifest's `codeDigest`. */
  readonly codeDigest: (state: Uint8Array) => string;
};

type Exports = {
  readonly memory: WebAssembly.Memory;
  readonly pnyx_alloc: (len: number) => number;
  readonly pnyx_dealloc: (ptr: number, len: number) => void;
  readonly pnyx_identity_row: (state: number, stateLen: number, identity: number, outLen: number) => number;
  readonly pnyx_contract_code_digest: (state: number, stateLen: number, outLen: number) => number;
};

/**
 * Stubs for wasm-bindgen's import placeholders.
 *
 * `midnight-curves` and `midnight-proofs` hard-code `getrandom = { features = ["js"] }` for
 * `wasm32-unknown-unknown` with no opt-out, so 33 `__wbindgen_*` imports exist in a module whose
 * only job is to decode bytes. They are never reached: decoding draws no randomness, the Rust side
 * registers a handler that refuses it, and instantiation itself does not call them (verified — the
 * decode succeeds against real chain state with these stubs in place).
 *
 * They throw rather than no-op so that if some future path *does* reach one, it fails loudly
 * instead of quietly receiving zeros from something that looks like a CSPRNG.
 */
const bindgenStubs = (moduleName: string): WebAssembly.ModuleImports =>
  new Proxy({} as WebAssembly.ModuleImports, {
    get: (_target, name) => () => {
      throw new Error(`wasm-bindgen shim ${moduleName}.${String(name)} was called; this build has no JS glue`);
    },
    has: () => true,
  });

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Bind a decoder to an instantiated module.
 *
 * Instantiated once per isolate by the caller. Views over `memory.buffer` are taken fresh on every
 * call because a growing wasm memory detaches any previously created view — a cached view would
 * start reading a dead buffer after the first allocation that grows the heap.
 */
export const createStateReader = (module: WebAssembly.Module): StateReader => {
  const instance = new WebAssembly.Instance(module, {
    __wbindgen_placeholder__: bindgenStubs('__wbindgen_placeholder__'),
    __wbindgen_externref_xform__: bindgenStubs('__wbindgen_externref_xform__'),
  });
  const wasm = instance.exports as unknown as Exports;

  /** Read one `status ‖ body` result out of wasm memory, freeing it either way. */
  const takeResult = (call: (statePtr: number, lenPtr: number) => number, state: Uint8Array, what: string): string => {
    const statePtr = wasm.pnyx_alloc(state.length);
    const lenPtr = wasm.pnyx_alloc(4);
    let resultPtr = 0;
    let resultLen = 0;
    try {
      new Uint8Array(wasm.memory.buffer, statePtr, state.length).set(state);
      resultPtr = call(statePtr, lenPtr);
      resultLen = new DataView(wasm.memory.buffer).getUint32(lenPtr, true);
      const result = new Uint8Array(wasm.memory.buffer, resultPtr, resultLen);
      const status = result[0];
      const body = new TextDecoder().decode(result.slice(1));
      if (status !== 0) {
        throw new Error(`${what} failed: ${body}`);
      }
      return body;
    } finally {
      if (resultPtr !== 0) wasm.pnyx_dealloc(resultPtr, resultLen);
      wasm.pnyx_dealloc(lenPtr, 4);
      wasm.pnyx_dealloc(statePtr, state.length);
    }
  };

  const codeDigest = (state: Uint8Array): string =>
    takeResult((statePtr, lenPtr) => wasm.pnyx_contract_code_digest(statePtr, state.length, lenPtr), state, 'code digest');

  const row: RowDecoder = (state, identity) => {
    if (identity.length !== 32) {
      throw new Error(`identity must be 32 bytes, got ${identity.length}`);
    }
    const statePtr = wasm.pnyx_alloc(state.length);
    const identityPtr = wasm.pnyx_alloc(32);
    const lenPtr = wasm.pnyx_alloc(4);
    let resultPtr = 0;
    let resultLen = 0;
    try {
      new Uint8Array(wasm.memory.buffer, statePtr, state.length).set(state);
      new Uint8Array(wasm.memory.buffer, identityPtr, 32).set(identity);
      resultPtr = wasm.pnyx_identity_row(statePtr, state.length, identityPtr, lenPtr);
      resultLen = new DataView(wasm.memory.buffer).getUint32(lenPtr, true);

      const result = new Uint8Array(wasm.memory.buffer, resultPtr, resultLen);
      const status = result[0];
      const body = new TextDecoder().decode(result.slice(1));
      if (status !== 0) {
        throw new Error(`identity row decode failed: ${body}`);
      }
      // `null` is a definite "nobody published this identity" and must not read as a failure.
      if (body === 'null') return undefined;
      const parsed = JSON.parse(body) as { anchor: string; authPub: string; name: string };
      return { anchor: fromHex(parsed.anchor), authPub: fromHex(parsed.authPub), name: fromHex(parsed.name) };
    } finally {
      if (resultPtr !== 0) wasm.pnyx_dealloc(resultPtr, resultLen);
      wasm.pnyx_dealloc(lenPtr, 4);
      wasm.pnyx_dealloc(identityPtr, 32);
      wasm.pnyx_dealloc(statePtr, state.length);
    }
  };

  return {row, codeDigest};
};

/** The row half alone, for callers that do not check the template. */
export const createRowDecoder = (module: WebAssembly.Module): RowDecoder => createStateReader(module).row;
