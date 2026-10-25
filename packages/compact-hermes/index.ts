/**
 * `@midnight-ntwrk/onchain-runtime-v3`, without WebAssembly.
 *
 * ⚠️ **This replaces the WASM package, not `@midnight-ntwrk/compact-runtime`.** That distinction is
 * the whole design. compact-runtime's own 27 symbols — `compact-types`, `error`, `witness`, `casts`,
 * `version`, the field arithmetic — are pure JavaScript and stay upstream, unmodified and
 * unversioned by us. Only its wasm-bindgen dependency is swapped, which is the smallest patch that
 * makes the compactc-generated driver run on Hermes V0 (`typeof WebAssembly === 'undefined'`).
 * Metro does the swap; see `app/metro.config.js`.
 *
 * Everything here either forwards to `@pnyx/midnight-native`'s `compactOp` — the same Rust crates
 * the proving rail links — or is pure JS that was never WASM to begin with (see `./field`).
 *
 * ⚠️ **Synchronous throughout.** The driver calls `queryLedgerState` for a value, not a promise, so
 * every native call here is a sync JSI `Function`.
 *
 * **Deliberately unimplemented:** the `initialState` constructors (`newMap`/`newArray`/`arrayPush`/
 * `newBoundedMerkleTree`), and the elliptic-curve leaves no contract of ours calls. Each throws by
 * name rather than returning something plausible: a contract deploy is built natively by
 * `deploy.rs`, and a silently wrong state value would surface as an unprovable transcript with
 * nothing pointing back here.
 *
 * @module
 */

import {bytesToHex, fieldToHex, hexToBytes, hexToField, MAX_FIELD} from './field'

export {addField, bigIntToValue, mulField, subField, valueToBigInt} from './field'

export type Value = Uint8Array[]
export type AlignmentAtom = {tag: 'compress'} | {tag: 'field'} | {tag: 'bytes'; length: number}
export type AlignmentSegment = {tag: 'option'; value: Alignment[]} | {tag: 'atom'; value: AlignmentAtom}
export type Alignment = AlignmentSegment[]
export type AlignedValue = {value: Value; alignment: Alignment}

/**
 * JSON in, JSON out. Bytes travel as hex; a `Value` atom is one hex string.
 *
 * ⚠️ **The native module is required lazily, not imported.** Importing it at module scope would pull
 * the Expo native layer into every consumer of this file — including the pure paths a driver takes
 * before it runs anything, and the tests that cover them. Nothing loads the bridge until a leaf
 * actually needs it.
 */
const call = (op: string, args: Record<string, unknown>): Record<string, unknown> => {
  const {compactOp} = require('@pnyx/midnight-native') as {compactOp: (op: string, args: string) => string}
  return JSON.parse(compactOp(op, JSON.stringify(args))) as Record<string, unknown>
}

const encodeValue = (value: Value): string[] => value.map(bytesToHex)

/**
 * A program as JSON the bridge can read: every byte atom as hex, everything else untouched.
 *
 * ⚠️ **`JSON.stringify` turns a `Uint8Array` into `{"0":1,"1":2,…}`, not a string.** A program carries
 * byte atoms inside `push` cell values and `idx` path keys, so passing it straight through produced
 * `value atom is not a string` from the native side — and **no test caught it**, because the Rust
 * tests are fed transcripts that were already hex-encoded in Node. It took running a real circuit on
 * a device. Numbers stay numbers: `n`, `length` and the rest are read as integers natively, so
 * stringifying them would break the ops that were working.
 */
export const encodeProgram = (node: unknown): unknown => {
  if (node instanceof Uint8Array) return bytesToHex(node)
  if (Array.isArray(node)) return node.map(encodeProgram)
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, encodeProgram(v)]))
  }
  return node
}

const decodeValue = (value: unknown): Value => (value as string[]).map(hexToBytes)

const unsupported = (what: string, why: string): never => {
  throw new Error(`${what} is not available on Hermes: ${why}`)
}

// ── State values ───────────────────────────────────────────────────────────────────────────────
//
// `EncodedStateValue` is a tagged union of plain data, so a StateValue that is only ever `encode()`d
// into a program needs no native handle at all — it is the recipe, not the object. That is what
// keeps the bridge to a VM call plus a handful of hashes.

export type EncodedStateValue =
  | {tag: 'null'}
  | {tag: 'cell'; content: AlignedValue}
  | {tag: 'map'; content: Map<AlignedValue, EncodedStateValue>}
  | {tag: 'array'; content: EncodedStateValue[]}
  | {tag: 'boundedMerkleTree'; content: [number, Map<bigint, [Uint8Array, undefined]>]}

export class StateValue {
  private constructor(private readonly encoded: EncodedStateValue) {}

  static newNull(): StateValue {
    return new StateValue({tag: 'null'})
  }

  static newCell(value: AlignedValue): StateValue {
    return new StateValue({tag: 'cell', content: value})
  }

  static newMap(): StateValue {
    return unsupported('StateValue.newMap', 'building initial state is `deploy.rs`, not this bridge')
  }

  static newArray(): StateValue {
    return unsupported('StateValue.newArray', 'building initial state is `deploy.rs`, not this bridge')
  }

  static newBoundedMerkleTree(): StateValue {
    return unsupported('StateValue.newBoundedMerkleTree', 'building initial state is `deploy.rs`')
  }

  arrayPush(): StateValue {
    return unsupported('StateValue.arrayPush', 'building initial state is `deploy.rs`, not this bridge')
  }

  encode(): EncodedStateValue {
    return this.encoded
  }

  type(): 'null' | 'cell' {
    return this.encoded.tag as 'null' | 'cell'
  }
}

/** `initialState` only; a deploy is built natively. Present so an import does not fail at load. */
export class StateMap {
  constructor() {
    unsupported('StateMap', 'building initial state is `deploy.rs`, not this bridge')
  }
}

export class StateBoundedMerkleTree {
  constructor() {
    unsupported('StateBoundedMerkleTree', 'building initial state is `deploy.rs`, not this bridge')
  }
}

export class ContractOperation {
  /** The driver calls `setOperation` for every entry point; the value itself is never read here. */
  verifierKey: Uint8Array | undefined
}

// ── Contract state and the query context ───────────────────────────────────────────────────────

/**
 * A contract state, carried as the tagged bytes the indexer served.
 *
 * ⚠️ This bridge only ever *reads* a state it was given. `ContractState` upstream can also be built
 * from nothing, which is the deploy path — refused here for the same reason the constructors are.
 */
export class ContractState {
  /**
   * ⚠️ **Constructible with no state, on purpose.** Every generated driver builds a
   * `new ContractState()` at module scope for its `_emptyContext` — a dummy it type-checks against
   * and never queries. Refusing here makes the module unimportable, which is how this was found: the
   * import threw on device before a single circuit ran.
   */
  constructor(readonly serialized: Uint8Array = new Uint8Array(0)) {}

  get data(): ChargedState {
    return new ChargedState(this.serialized)
  }

  readonly balance: Map<unknown, unknown> = new Map()
}

export class ChargedState {
  constructor(readonly serialized: Uint8Array = new Uint8Array(0)) {}
}

// `CostModel.initialCostModel()` is the shape `circuit-context.js` calls on the WASM class; a plain
// function would not be a drop-in.
// biome-ignore lint/complexity/noStaticOnlyClass: it mirrors an upstream class, not our design
export class CostModel {
  static initialCostModel(): CostModel {
    return new CostModel()
  }
}

export type RunningCost = {readTime: bigint; computeTime: bigint; bytesWritten: bigint; bytesDeleted: bigint}
export type GatherResult = {tag: 'read'; content: AlignedValue}

type RawEvent = {tag: string; content: {value: unknown; alignment: Alignment}}

/**
 * Decode the VM's read events — **freshly, on every call**.
 *
 * ⚠️ **The freshness is the whole point, and a shared array silently corrupts a transcript.**
 * `circuit-context.js` reads `results.events` **twice**: once to fill each `popeq`'s result into the
 * public transcript, and once to hand the value back to the circuit. The circuit then decodes it with
 * a descriptor whose `fromValue` calls `value.shift()` — which *mutates* the array it is given. If
 * both reads return the same object, that `shift` drains the atom out of the transcript too, and the
 * call reaches the prover with a `Bytes<1>` boolean that has **zero** atoms and does not fit its own
 * alignment.
 *
 * Upstream survives this because `QueryResults.events` is a wasm-bindgen **getter** that materialises
 * a new JS array per access. Matching that is not an optimisation to undo later — it is the contract.
 *
 * Found on a device, which is the only place the real driver had ever run.
 */
const decodeEvents = (raw: RawEvent[]): GatherResult[] =>
  raw.map((e) => ({
    tag: 'read',
    content: {value: decodeValue(e.content.value), alignment: e.content.alignment},
  }))

export type QueryResult = {
  context: QueryContext
  gasCost: RunningCost
  readonly events: GatherResult[]
}

/**
 * Assemble what `query` hands back, with `events` as a **getter** for the reason above.
 *
 * Exported so the property's freshness is testable without a native module — a test that calls
 * {@link decodeEvents} twice proves the function is pure, which is not the property that matters and
 * is not the one that broke.
 */
export const queryResult = (context: QueryContext, gasCost: RunningCost, raw: RawEvent[]): QueryResult => ({
  context,
  gasCost,
  get events(): GatherResult[] {
    return decodeEvents(raw)
  },
})

/**
 * The Impact VM, over a native handle.
 *
 * ⚠️ **Gather mode, not verify.** The generated driver emits `popeq` with no result and substitutes
 * the read contents afterwards — it cannot state in advance what `preimage.rs` bakes in.
 *
 * ⚠️ **The handle must be freed.** `free()` drops the native context; a driver that throws mid-call
 * leaks one until the process ends, which is why `runCircuit` in the wallet wraps it in `finally`.
 */
export class QueryContext {
  private readonly serialized: Uint8Array
  private readonly address: string
  private handle: number | undefined
  block: {balance: Map<unknown, unknown>; ownAddress: string; secondsSinceEpoch: bigint} = {
    balance: new Map(),
    ownAddress: '',
    secondsSinceEpoch: 0n,
  }

  /**
   * ⚠️ **The native context opens lazily, on the first query.** The drivers build one at module
   * scope over an empty `ContractState` and never use it; opening a handle there would both fail and
   * leak. A context that is never queried now costs nothing.
   */
  constructor(state: ChargedState | ContractState, address: string) {
    this.serialized = state.serialized
    this.address = address
    this.block.ownAddress = address
  }

  /** The handle, opened on demand. An empty state fails here — named — rather than at import. */
  get id(): number {
    if (this.handle === undefined) {
      if (this.serialized.length === 0) {
        throw new Error('this query context has no contract state: it was built for type-checking, not to run')
      }
      this.handle = call('ctx.new', {state: bytesToHex(this.serialized), address: this.address}).id as number
    }
    return this.handle
  }

  query(program: unknown[], _costModel?: CostModel, _gasLimit?: unknown): QueryResult {
    const out = call('ctx.query', {id: this.id, program: encodeProgram(program)})
    const cost = out.gasCost as Record<string, string>
    // The native context mutates in place, so the "new" context is this one — returned rather than
    // assigned, because that is the shape `circuit-context.js` assigns from.
    return queryResult(
      this,
      {
        readTime: BigInt(cost.readTime ?? '0'),
        computeTime: BigInt(cost.computeTime ?? '0'),
        bytesWritten: BigInt(cost.bytesWritten ?? '0'),
        bytesDeleted: BigInt(cost.bytesDeleted ?? '0'),
      },
      out.events as RawEvent[],
    )
  }

  /**
   * Where a coin received in this transaction gets the Merkle index a later `qualify` spends it by.
   *
   * ⚠️ **Kept on both sides.** The native context needs it because the VM exposes the map to the
   * running program; this one needs it because `hasCoinCommitment` reads `comIndices` directly, in
   * JS, without asking the bridge. Returning `this` mirrors upstream's persistent-value shape — the
   * native context mutates in place, so the "new" context is this one.
   */
  insertCommitment(commitment: string, index: bigint): QueryContext {
    call('ctx.insertCommitment', {id: this.id, commitment, index: index.toString()})
    this.commitments.set(commitment, index)
    return this
  }

  private readonly commitments = new Map<string, bigint>()

  get comIndices(): Map<string, bigint> {
    return this.commitments
  }

  /** Idempotent: freeing a context that was never queried is a no-op, not an error. */
  free(): void {
    if (this.handle === undefined) return
    call('ctx.free', {id: this.handle})
    this.handle = undefined
  }
}

// ── Hashing ────────────────────────────────────────────────────────────────────────────────────

export const persistentHash = (alignment: Alignment, value: Value): Uint8Array[] => [
  hexToBytes(call('hash.persistent', {alignment, value: encodeValue(value)}).out as string),
]

export const persistentCommit = (alignment: Alignment, value: Value, opening: Value): Uint8Array[] => [
  hexToBytes(
    call('hash.persistentCommit', {
      alignment,
      value: encodeValue(value),
      opening: bytesToHex(opening[0] ?? new Uint8Array(32)),
    }).out as string,
  ),
]

export const transientHash = (alignment: Alignment, value: Value): Value => [
  hexToBytes(call('hash.transient', {alignment, value: encodeValue(value)}).out as string),
]

export const transientCommit = (): Value =>
  unsupported('transientCommit', 'no contract of ours calls it; add the op when one does')

export const degradeToTransient = (x: Value): Value => [
  hexToBytes(call('hash.degrade', {input: bytesToHex(padTo32(x[0] ?? new Uint8Array(0)))}).out as string),
]

export const upgradeFromTransient = (x: Value): Uint8Array[] => [
  hexToBytes(call('hash.upgrade', {input: bytesToHex(x[0] ?? new Uint8Array(0))}).out as string),
]

export const leafHash = (value: AlignedValue): Uint8Array[] => [
  hexToBytes(call('leaf.hash', {alignment: value.alignment, value: encodeValue(value.value)}).out as string),
]

/** `degradeToTransient` takes a full-width 32-byte input; a trimmed atom is padded back out. */
const padTo32 = (b: Uint8Array): Uint8Array => {
  if (b.length === 32) return b
  const out = new Uint8Array(32)
  out.set(b, 0)
  return out
}

export const maxField = (): bigint => MAX_FIELD

/**
 * ⚠️ **32 bytes, not 35.** A `ContractAddress` at this layer carries no network tag — measured
 * against the real runtime, which returns 64 zero-hex. The earlier 35 was never caught because the
 * only caller is the dummy `_emptyContext`, which is built and never queried.
 */
export const dummyContractAddress = (): string => '00'.repeat(32)

export const hashToCurve = (): never => unsupported('hashToCurve', 'no contract of ours calls it')
export const ecAdd = (): never => unsupported('ecAdd', 'no contract of ours calls it')
export const ecMul = (): never => unsupported('ecMul', 'no contract of ours calls it')
export const ecMulGenerator = (): never => unsupported('ecMulGenerator', 'no contract of ours calls it')

// ── Zswap ──────────────────────────────────────────────────────────────────────────────────────
//
// One circuit in the repo reaches this surface — `payment.buyPermitShielded`, which receives a coin
// and forwards it to the treasury in the same call, so its transcript carries a shielded receive
// *and* a shielded spend.
//
// ⚠️ **Eight of these nine are pure JS, and that was measured rather than assumed.** Every
// `CoinPublicKey` and `ContractAddress` the runtime hands out is **plain lowercase hex of exactly 32
// bytes** — no bech32m, no network tag — and a coin's two representations differ by one field name
// (`color` in Compact, `type` in the runtime). Only the commitment is a hash, and only it crosses
// the bridge.
//
// ⚠️ **Widths are checked, never padded.** Upstream refuses a short, odd or non-hex string by name
// rather than zero-extending it, and so does this: a silently widened key addresses a coin nobody
// can spend, and the loss would surface as a missing balance with nothing pointing back here.

const HEX32 = /^[0-9a-fA-F]{64}$/

const hex32 = (s: string, what: string): Uint8Array => {
  if (typeof s !== 'string' || !HEX32.test(s)) {
    throw new Error(`${what} must be 64 hex characters, got ${JSON.stringify(s)}`)
  }
  return hexToBytes(s.toLowerCase())
}

const unhex32 = (b: Uint8Array, what: string): string => {
  if (!(b instanceof Uint8Array) || b.length !== 32) {
    throw new Error(`${what} must be 32 bytes, got ${b instanceof Uint8Array ? b.length : typeof b}`)
  }
  return bytesToHex(b)
}

/** A coin as the **runtime** names it: hex strings, and `type` where Compact says `color`. */
export type ShieldedCoinInfo = {type: string; nonce: string; value: bigint}
export type QualifiedShieldedCoinInfo = ShieldedCoinInfo & {mt_index: bigint}

/** The same coin as **Compact** names it: raw bytes, and `color` where the runtime says `type`. */
export type CompactShieldedCoinInfo = {color: Uint8Array; nonce: Uint8Array; value: bigint}
export type CompactQualifiedShieldedCoinInfo = CompactShieldedCoinInfo & {mt_index: bigint}

const U128 = 2n ** 128n
const U64 = 2n ** 64n

const inRange = (x: bigint, limit: bigint, what: string): bigint => {
  if (typeof x !== 'bigint' || x < 0n || x >= limit) throw new Error(`${what} is out of range: ${x}`)
  return x
}

export const encodeCoinPublicKey = (pk: string): Uint8Array => hex32(pk, 'a coin public key')
export const decodeCoinPublicKey = (pk: Uint8Array): string => unhex32(pk, 'a coin public key')

export const encodeContractAddress = (addr: string): Uint8Array => hex32(addr, 'a contract address')
export const decodeContractAddress = (addr: Uint8Array): string => unhex32(addr, 'a contract address')

export const encodeShieldedCoinInfo = (coin: ShieldedCoinInfo): CompactShieldedCoinInfo => ({
  color: hex32(coin.type, "a coin's type"),
  nonce: hex32(coin.nonce, "a coin's nonce"),
  value: inRange(coin.value, U128, "a coin's value"),
})

export const decodeShieldedCoinInfo = (coin: CompactShieldedCoinInfo): ShieldedCoinInfo => ({
  type: unhex32(coin.color, "a coin's color"),
  nonce: unhex32(coin.nonce, "a coin's nonce"),
  value: inRange(coin.value, U128, "a coin's value"),
})

export const encodeQualifiedShieldedCoinInfo = (coin: QualifiedShieldedCoinInfo): CompactQualifiedShieldedCoinInfo => ({
  ...encodeShieldedCoinInfo(coin),
  mt_index: inRange(coin.mt_index, U64, "a coin's Merkle index"),
})

export const decodeQualifiedShieldedCoinInfo = (coin: CompactQualifiedShieldedCoinInfo): QualifiedShieldedCoinInfo => ({
  ...decodeShieldedCoinInfo(coin),
  mt_index: inRange(coin.mt_index, U64, "a coin's Merkle index"),
})

/**
 * The one zswap leaf that is a hash rather than a rename.
 *
 * ⚠️ The recipient's arms are the **opposite way round** from the unshielded `Either` the same
 * contract carries: left is a `ZswapCoinPublicKey`, right is a `ContractAddress`. Reading the wrong
 * one produces a commitment that matches no coin, which is a coin nobody can ever spend — so the
 * arm is chosen natively, from the tag, rather than guessed on either side.
 */
export const runtimeCoinCommitment = (coin: AlignedValue, recipient: AlignedValue): AlignedValue => ({
  value: [
    hexToBytes(
      call('zswap.coinCommitment', {
        coin: {alignment: coin.alignment, value: encodeValue(coin.value)},
        recipient: {alignment: recipient.alignment, value: encodeValue(recipient.value)},
      }).out as string,
    ),
  ],
  alignment: [{tag: 'atom', value: {tag: 'bytes', length: 32}}],
})

export {fieldToHex, hexToField}
