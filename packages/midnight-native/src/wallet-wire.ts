/**
 * The wallet bridge's wire format, as pure functions.
 *
 * Split from `index.ts` because importing that pulls `expo-modules-core`, which needs an Expo global
 * no test runner has — and this is exactly the layer worth testing: a `u128` crossing as text, and a
 * coin crossing as a fixed 80-byte record where a wrong length must fail rather than zero-pad.
 *
 * @module
 */

import {packUnshieldedInputBytes, type UnshieldedSpend} from './unshielded-wire'

/** A shielded coin: the three values that identify one. `value` is a `Uint<128>`. */
export type ShieldedCoin = {
  readonly nonce: Uint8Array
  readonly color: Uint8Array
  readonly value: bigint
}

/** One unspent coin, with the Merkle index a spend proof needs. */
export type ShieldedCoinAt = ShieldedCoin & {readonly mtIndex: number}

export type WalletSummary = {
  /** Next free index in the local commitment tree — the sync cursor. */
  readonly firstFree: number
  /**
   * Coins spent by a transfer that has not confirmed yet.
   *
   * They are excluded from `coins` and `balances`: upstream keeps such a coin tracked until the chain
   * shows its nullifier, so counting it would show a balance that cannot be sent and invite a second
   * transfer to spend the same note.
   */
  readonly pending: number
  /** Totals per token colour. A colour absent here is one this wallet holds none of. */
  readonly balances: ReadonlyArray<{readonly color: Uint8Array; readonly value: bigint}>
  readonly coins: ReadonlyArray<ShieldedCoinAt>
}

/** `nonce(32) ‖ color(32) ‖ value(16, little-endian)` — must match `wallet.rs`'s `COIN_WIRE_LEN`. */
export const COIN_WIRE_LEN = 80

export const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Encode a coin for the bridge.
 *
 * Every bound is checked here rather than trusted: the native side takes a fixed-width record, so a
 * short nonce would land as a *different, valid-looking* coin rather than an error, and a value past
 * 128 bits would silently truncate to one the ledger will not recognise.
 */
export const coinToWire = (coin: ShieldedCoin): string => {
  if (coin.nonce.length !== 32) throw new Error(`coin nonce must be 32 bytes, got ${coin.nonce.length}`)
  if (coin.color.length !== 32) throw new Error(`coin color must be 32 bytes, got ${coin.color.length}`)
  if (coin.value < 0n) throw new Error('coin value cannot be negative')
  const wire = new Uint8Array(COIN_WIRE_LEN)
  wire.set(coin.nonce, 0)
  wire.set(coin.color, 32)
  let v = coin.value
  for (let i = 0; i < 16; i++) {
    wire[64 + i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('coin value exceeds 128 bits')
  return toHex(wire)
}

/**
 * A `Uint<128>` as 16 little-endian bytes, hex-encoded.
 *
 * Shares its bounds with {@link coinToWire} for the same reason: past 128 bits the value would wrap into
 * a different, valid-looking amount, and this one is what somebody is being sent.
 */
export const valueToLeHex = (value: bigint): string => {
  if (value < 0n) throw new Error('value cannot be negative')
  const bytes = new Uint8Array(16)
  let v = value
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('value exceeds 128 bits')
  return toHex(bytes)
}

/**
 * Parse the native summary.
 *
 * Values arrive as decimal **strings** and become `bigint`s here. They cannot be JSON numbers: a coin
 * is a `Uint<128>`, and `JSON.parse` would round anything past 2^53 into a balance that is quietly
 * wrong — the one number in the app that must never be approximate.
 */
export const parseWalletSummary = (json: string): WalletSummary => {
  const parsed = JSON.parse(json) as {
    firstFree: number
    pending: number
    balances: ReadonlyArray<{color: string; value: string}>
    coins: ReadonlyArray<{nonce: string; color: string; value: string; mtIndex: number}>
  }
  return {
    firstFree: parsed.firstFree,
    pending: parsed.pending,
    balances: parsed.balances.map((b) => ({color: fromHex(b.color), value: BigInt(b.value)})),
    coins: parsed.coins.map((c) => ({
      nonce: fromHex(c.nonce),
      color: fromHex(c.color),
      value: BigInt(c.value),
      mtIndex: c.mtIndex,
    })),
  }
}

/**
 * Parse a `tryDecrypt` result.
 *
 * `undefined` means the output belongs to someone else — the common answer on a public chain, and not
 * an error. The native side reserves failure for a ciphertext it could not parse, so a corrupt stream
 * cannot masquerade as a chain with nothing of ours on it.
 */
export const parseDecryptedCoin = (json: string): ShieldedCoin | undefined => {
  const parsed = JSON.parse(json) as null | {nonce: string; color: string; value: string}
  if (parsed === null) return undefined
  return {nonce: fromHex(parsed.nonce), color: fromHex(parsed.color), value: BigInt(parsed.value)}
}

/** A BIP-340 Schnorr signature and the key it verifies under, both hex. */
export type NightSignature = {
  /** 64 bytes: `r ‖ s`, each big-endian padded to 32. */
  readonly signature: string
  /** 32 bytes, BIP-340 x-only. */
  readonly verifyingKey: string
}

/**
 * Parse a `signData` result.
 *
 * Widths are checked because a dApp verifies against them: the connector API states 64 bytes for the
 * signature and 32 for a `schnorr_bip340` key, so anything else would be handed on as a signature that
 * cannot verify — a failure the wallet would look responsible for.
 */
export const parseNightSignature = (json: string): NightSignature => {
  const parsed = JSON.parse(json) as {signature?: unknown; verifyingKey?: unknown}
  const read = (value: unknown, what: string, bytes: number): string => {
    if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value)) {
      throw new Error(`${what} must be ${bytes} bytes of hex, got ${String(value).slice(0, 24)}`)
    }
    return value
  }
  return {
    signature: read(parsed.signature, 'a signature', 64),
    verifyingKey: read(parsed.verifyingKey, 'a verifying key', 32),
  }
}

/**
 * The identifier list a proven transaction reports, as lowercase hex.
 *
 * An empty list is rejected rather than returned: every transaction this rail builds carries at least
 * one intent, so its binding commitment is always an identifier. An empty answer therefore means the
 * read failed to see the transaction, and returning `[]` would turn that into "this transaction can
 * never be matched" — a send that silently becomes untrackable.
 */
export const parseIdentifiers = (json: string): readonly string[] => {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
    throw new Error(`identifiers: expected an array of hex strings, got ${json.slice(0, 80)}`)
  }
  if (parsed.length === 0) {
    throw new Error('identifiers: a proven transaction always carries at least one, so none means the read failed')
  }
  return parsed as readonly string[]
}

/**
 * A `u64` little-endian, as the DUST ops take a time or a tree index.
 *
 * Its own encoder rather than reusing {@link valueToLeHex}: that writes 16 bytes and the native side
 * length-checks these at 8, so a mismatch would be an error at the bridge rather than a wrong number —
 * but only if the widths are kept apart deliberately.
 */
export const u64ToLeHex = (value: bigint): string => {
  if (value < 0n) throw new Error('a u64 cannot be negative')
  const bytes = new Uint8Array(8)
  let v = value
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('value exceeds 64 bits')
  return toHex(bytes)
}

/** `start ‖ end`, each a `u64` LE — an inclusive tree-index range to collapse. */
export const collapseRangeHex = (start: bigint, end: bigint): string => {
  if (end < start) throw new Error(`a collapse range must not end before it starts: ${start}..${end}`)
  return u64ToLeHex(start) + u64ToLeHex(end)
}

/**
 * What this wallet can spend as DUST, at one instant.
 *
 * ⚠️ **`balance` is a function of time.** DUST accrues from registered NIGHT towards a cap, so a figure
 * without the instant it was computed at means nothing — which is why the native read takes the time
 * rather than consulting a clock. `syncTime` is how far the state has been synced, and is a *different*
 * thing: a balance can be correct for a state that is far behind the chain.
 */
export type DustBalance = {
  readonly balance: bigint
  /** Unix seconds the state is synced to. `0` for a state that has never been synced. */
  readonly syncTime: number
  readonly utxos: number
}

export const parseDustBalance = (json: string): DustBalance => {
  const parsed = JSON.parse(json) as {balance?: unknown; syncTime?: unknown; utxos?: unknown}
  if (typeof parsed.balance !== 'string' || !/^\d+$/.test(parsed.balance)) {
    throw new Error(`dust balance: expected a decimal string, got ${String(parsed.balance)}`)
  }
  if (typeof parsed.syncTime !== 'number' || typeof parsed.utxos !== 'number') {
    throw new Error(`dust balance: malformed syncTime/utxos in ${json.slice(0, 80)}`)
  }
  return {balance: BigInt(parsed.balance), syncTime: parsed.syncTime, utxos: parsed.utxos}
}

/** One DUST output this wallet holds. `initialValue` is DUST *at creation*, never the spendable amount. */
export type DustUtxo = {
  readonly initialValue: bigint
  readonly seq: number
  /** Unix seconds the output was created. */
  readonly ctime: number
  readonly mtIndex: number
  /** 64-hex initial nonce of the NIGHT output backing this one. */
  readonly backingNight: string
}

export const parseDustUtxos = (json: string): readonly DustUtxo[] => {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error(`dust utxos: expected an array, got ${json.slice(0, 80)}`)
  return parsed.map((raw) => {
    const row = raw as Record<string, unknown>
    if (typeof row.initialValue !== 'string' || !/^\d+$/.test(row.initialValue)) {
      throw new Error(`dust utxo: initialValue must be a decimal string, got ${String(row.initialValue)}`)
    }
    for (const field of ['seq', 'ctime', 'mtIndex']) {
      if (typeof row[field] !== 'number') throw new Error(`dust utxo: ${field} must be a number`)
    }
    if (typeof row.backingNight !== 'string') throw new Error('dust utxo: backingNight must be hex')
    return {
      initialValue: BigInt(row.initialValue),
      seq: row.seq as number,
      ctime: row.ctime as number,
      mtIndex: row.mtIndex as number,
      backingNight: row.backingNight,
    }
  })
}

/**
 * One of this wallet's DUST generation entries, as `dustGenerations` reports it.
 *
 * ⚠️ `dtime` is `null` for a live registration — the ledger's own sentinel is `Timestamp::MAX`, and a
 * dtime update replaces it with the instant the backing NIGHT went away, after which the entry stops
 * generating. `0` would mean the epoch, which would silently kill every live entry.
 */
export type DustGenerationEntry = {
  readonly generationIndex: number
  readonly commitmentIndex: number
  /** Backing NIGHT, in STAR. */
  readonly value: bigint
  /** DUST at creation, in SPECK. Never the spendable amount. */
  readonly initialValue: bigint
  /** Unix seconds the output was created. */
  readonly ctime: number
  readonly seq: number
  /** 64-hex initial nonce of the backing NIGHT output. */
  readonly backingNight: string
  /** Unix seconds the entry stopped generating, or `null` for "still live". */
  readonly dtime: number | null
}

/**
 * Encode a `dust:register` argument.
 *
 * `dustRoleKey(32) ‖ register(1) ‖ ttlSecs(u64 LE) ‖ ctimeSecs(u64 LE) ‖ feeMargin(1) ‖
 * inputCount(u16 LE) ‖ inputs(count × 84) ‖ networkId(UTF-8)`
 *
 * ⚠️ The **Night** role key does not travel here — it goes in the bridge's key slot, because it is the
 * key that signs the registration. Only the dust key, which is being registered *to*, is in the arg.
 *
 * ⚠️ **`nightInputs` are not optional in practice.** The ledger backs `allowFeePayment` only with NIGHT
 * the registration itself spends, so an empty list builds a transaction every node refuses. Empty is
 * still allowed here because a *deregistration* wants exactly that shape — see `rust/src/dust.rs`.
 */
export const registerArg = (params: {
  readonly dustRoleKey: Uint8Array
  readonly register: boolean
  readonly ttlSecs: number
  readonly ctimeSecs: number
  readonly feeMargin: number
  /** NIGHT this wallet owns, spent back to itself so it can back the fee allowance. */
  readonly nightInputs: readonly UnshieldedSpend[]
  readonly networkId: string
}): string => {
  if (params.dustRoleKey.length !== 32) {
    throw new Error(`a dust role key is 32 bytes, got ${params.dustRoleKey.length}`)
  }
  if (params.networkId === '') throw new Error("a registration needs a network id ('undeployed' for offline)")
  if (!Number.isInteger(params.feeMargin) || params.feeMargin < 0 || params.feeMargin > 255) {
    throw new Error(`a fee margin must fit a byte, got ${params.feeMargin}`)
  }
  if (params.nightInputs.length > 0xffff) {
    throw new Error(`a registration takes at most 65535 inputs, got ${params.nightInputs.length}`)
  }
  const network = new TextEncoder().encode(params.networkId)
  const packed = packUnshieldedInputBytes(params.nightInputs)
  const out = new Uint8Array(32 + 1 + 8 + 8 + 1 + 2 + packed.length + network.length)
  const view = new DataView(out.buffer)
  out.set(params.dustRoleKey, 0)
  out[32] = params.register ? 1 : 0
  view.setBigUint64(33, BigInt(params.ttlSecs), true)
  view.setBigUint64(41, BigInt(params.ctimeSecs), true)
  out[49] = params.feeMargin
  view.setUint16(50, params.nightInputs.length, true)
  out.set(packed, 52)
  out.set(network, 52 + packed.length)
  return toHex(out)
}

/** A built registration: the sealed transaction, and the DUST it authorised for its own fee. */
export type DustRegistrationTx = {
  readonly transaction: Uint8Array
  /** SPECK this registration authorises to be spent on fees — it must cover its own. */
  readonly allowFeePayment: bigint
}

export const parseDustRegistration = (json: string): DustRegistrationTx => {
  const parsed = JSON.parse(json) as {tx?: unknown; allowFeePayment?: unknown}
  if (typeof parsed.tx !== 'string' || typeof parsed.allowFeePayment !== 'string') {
    throw new Error(`a registration must return tx and allowFeePayment as strings: ${json.slice(0, 120)}`)
  }
  if (!/^\d+$/.test(parsed.allowFeePayment)) {
    throw new Error(`allowFeePayment must be a decimal string, got ${parsed.allowFeePayment}`)
  }
  return {transaction: fromHex(parsed.tx), allowFeePayment: BigInt(parsed.allowFeePayment)}
}

/**
 * Must equal `GENERATION_RECORD_LEN` in `dust.rs`:
 * `genIndex(8) ‖ comIndex(8) ‖ value(16) ‖ initialValue(16) ‖ ctime(8) ‖ seq(4) ‖ backingNight(32) ‖ dtime(8)`.
 *
 * ⚠️ This was briefly 92 — the backing-night field was counted but its 32 bytes were not carried
 * through to the dtime offset. The native side refused it by width, which is the good outcome, but a
 * test that measured the encoder against *this* constant passed the whole time. Offsets are asserted
 * individually now, against the field layout rather than against each other.
 */
export const GENERATION_RECORD_LEN = 100

/** Byte offset of each field in a generation record — the layout `dust.rs` reads. */
export const GENERATION_OFFSETS = {
  generationIndex: 0,
  commitmentIndex: 8,
  value: 16,
  initialValue: 32,
  ctime: 48,
  seq: 56,
  backingNight: 60,
  dtime: 92,
} as const

/**
 * Encode a generation entry for the bridge: fixed-width little-endian, in `dust.rs`'s field order.
 *
 * Bounds are checked here rather than trusted, for the reason `coinToWire` states: the native side
 * reads a fixed-width record, so a short field would land as a *different, valid-looking* entry.
 */
export const generationToWire = (entry: DustGenerationEntry): string => {
  const wire = new Uint8Array(GENERATION_RECORD_LEN)
  const view = new DataView(wire.buffer)
  const u64 = (at: number, value: bigint, what: string) => {
    if (value < 0n || value >= 2n ** 64n) throw new Error(`${what} must fit a u64, got ${value}`)
    view.setBigUint64(at, value, true)
  }
  const u128 = (at: number, value: bigint, what: string) => {
    if (value < 0n || value >= 2n ** 128n) throw new Error(`${what} must fit a u128, got ${value}`)
    view.setBigUint64(at, value & 0xffffffffffffffffn, true)
    view.setBigUint64(at + 8, value >> 64n, true)
  }
  u64(GENERATION_OFFSETS.generationIndex, BigInt(entry.generationIndex), 'a generation index')
  u64(GENERATION_OFFSETS.commitmentIndex, BigInt(entry.commitmentIndex), 'a commitment index')
  u128(GENERATION_OFFSETS.value, entry.value, 'a backing NIGHT value')
  u128(GENERATION_OFFSETS.initialValue, entry.initialValue, 'an initial DUST value')
  u64(GENERATION_OFFSETS.ctime, BigInt(entry.ctime), 'a ctime')
  if (!Number.isInteger(entry.seq) || entry.seq < 0 || entry.seq > 0xffffffff) {
    throw new Error(`a seq must fit a u32, got ${entry.seq}`)
  }
  view.setUint32(GENERATION_OFFSETS.seq, entry.seq, true)
  const backing = fromHex(entry.backingNight)
  if (backing.length !== 32) throw new Error(`a backing night is 32 bytes, got ${backing.length}`)
  wire.set(backing, GENERATION_OFFSETS.backingNight)
  // 0 is the "never" sentinel the native side maps to Timestamp::MAX.
  u64(GENERATION_OFFSETS.dtime, BigInt(entry.dtime ?? 0), 'a dtime')
  return toHex(wire)
}

/**
 * One entry of the ledger's own balance map for a transaction.
 *
 * `delta` keeps the ledger's sign, and the sign is the whole meaning: **negative is owed**, positive is
 * a surplus a transaction is allowed to leave behind (`balancing_check` rejects negatives only). A
 * caller that took the magnitude would fund a surplus.
 */
export type TxBalanceEntry = {
  readonly kind: 'unshielded' | 'shielded' | 'dust'
  /** 64-hex token type, `null` for DUST, which has no type bytes. */
  readonly tokenType: string | null
  readonly segment: number
  readonly delta: bigint
}

const BALANCE_KINDS = ['unshielded', 'shielded', 'dust'] as const

/**
 * Parse the `txBalance` read.
 *
 * `delta` crosses as a decimal **string** because it is an `i128` and JSON has no such number — the
 * same reason balances leave as strings. Parsed rather than trusted: a `Number` here would round a
 * large token's deficit and fund the wrong amount.
 */
export const parseTxBalance = (json: string): readonly TxBalanceEntry[] => {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`txBalance: expected an array, got ${json.slice(0, 80)}`)
  }
  return parsed.map((raw) => {
    const row = raw as {kind?: unknown; tokenType?: unknown; segment?: unknown; delta?: unknown}
    if (!BALANCE_KINDS.includes(row.kind as (typeof BALANCE_KINDS)[number])) {
      throw new Error(`txBalance: unknown token kind '${String(row.kind)}'`)
    }
    if (row.tokenType !== null && typeof row.tokenType !== 'string') {
      throw new Error(`txBalance: token type must be hex or null, got ${String(row.tokenType)}`)
    }
    if (typeof row.segment !== 'number' || !Number.isInteger(row.segment)) {
      throw new Error(`txBalance: segment must be an integer, got ${String(row.segment)}`)
    }
    if (typeof row.delta !== 'string' || !/^-?\d+$/.test(row.delta)) {
      throw new Error(`txBalance: delta must be a decimal string, got ${String(row.delta)}`)
    }
    return {
      kind: row.kind as (typeof BALANCE_KINDS)[number],
      tokenType: row.tokenType,
      segment: row.segment,
      delta: BigInt(row.delta),
    }
  })
}

/** What a transaction owes: one row per (segment, token) the ledger reports as negative. */
export type TxDeficit = {
  readonly kind: 'unshielded' | 'shielded' | 'dust'
  readonly tokenType: string | null
  readonly segment: number
  /** Magnitude, always positive. */
  readonly owed: bigint
}

/**
 * The deficits of a transaction, largest first.
 *
 * Pure, so the screen that names an amount and the code that selects UTxOs read the same figure from
 * the same place. It does **not** decide what is fundable — the native side owns those refusals, since
 * it is the only side that can see whether an intent already carries inputs.
 */
export const deficitsOf = (entries: readonly TxBalanceEntry[]): readonly TxDeficit[] =>
  entries
    .filter((e) => e.delta < 0n)
    .map((e) => ({kind: e.kind, tokenType: e.tokenType, segment: e.segment, owed: -e.delta}))
    .sort((a, b) => (a.owed === b.owed ? a.segment - b.segment : a.owed > b.owed ? -1 : 1))

/**
 * Wire form for `applyTransaction`: `count(u16 LE) ‖ segments(u16 LE each) ‖ transaction`.
 *
 * A count of `0xffff` is the sentinel for "every section", which is what a fully successful
 * transaction means — so `0xffff` is not a usable segment id, and a caller passing it explicitly is
 * rejected rather than silently promoted to "apply everything".
 */
export const applyTransactionArg = (transaction: Uint8Array, succeededSegments: readonly number[] | 'all'): string => {
  if (succeededSegments === 'all') {
    const all = new Uint8Array(2 + transaction.length)
    all[0] = 0xff
    all[1] = 0xff
    all.set(transaction, 2)
    return toHex(all)
  }
  const arg = new Uint8Array(2 + succeededSegments.length * 2 + transaction.length)
  const view = new DataView(arg.buffer)
  if (succeededSegments.length >= 0xffff) {
    throw new Error(`too many segments to encode: ${succeededSegments.length}`)
  }
  view.setUint16(0, succeededSegments.length, true)
  succeededSegments.forEach((segment, i) => {
    if (!Number.isInteger(segment) || segment < 0 || segment >= 0xffff) {
      throw new Error(`segment id must be a u16 below 0xffff, got ${segment}`)
    }
    view.setUint16(2 + i * 2, segment, true)
  })
  arg.set(transaction, 2 + succeededSegments.length * 2)
  return toHex(arg)
}
