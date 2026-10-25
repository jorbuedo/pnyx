/**
 * The unshielded transfer bridge's wire format, as pure functions.
 *
 * Split from `index.ts` for the same reason as `wallet-wire.ts`: that module pulls
 * `expo-modules-core`, which needs an Expo global no test runner has, and the packing is the layer
 * worth testing. A UTxO crosses as a fixed 84-byte record, and the native side rejects anything that
 * is not a whole number of them — so a wrong length here has to fail loudly rather than pad.
 *
 * @module
 */

/**
 * One unspent output to spend, in the shape the indexer reports it (see the wallet app's
 * `unshielded-utxo-set`).
 *
 * No owner: the native side derives it from the same role key it signs with. Passing one would only
 * create a way for the two to disagree.
 */
export type UnshieldedSpend = {
  /** Atomic units. `bigint` because NIGHT has 6 decimals and a spend must not round. */
  readonly value: bigint
  /** 32 bytes. */
  readonly tokenType: Uint8Array
  /** 32 bytes — the intent that created this output, not the transaction hash. */
  readonly intentHash: Uint8Array
  /** This output's position within that intent. */
  readonly outputIndex: number
}

/**
 * value(16) ‖ tokenType(32) ‖ intentHash(32) ‖ outputIndex(4).
 *
 * Must equal `INPUT_RECORD_LEN` in `rust/src/unshielded.rs`, which reads the records back. That side
 * rejects a length that is not a whole multiple, so most drift fails loudly — but a change that keeps
 * the total commensurate (adding 84 bytes of fields) would be read as extra records instead. Change
 * both sides together.
 */
export const INPUT_RECORD_LEN = 84

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const writeUintLE = (into: Uint8Array, at: number, value: bigint, width: number, what: string): void => {
  if (value < 0n) throw new Error(`${what} cannot be negative`)
  let v = value
  for (let i = 0; i < width; i++) {
    into[at + i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error(`${what} exceeds ${width * 8} bits`)
}

/**
 * Pack the UTxOs to spend into the bridge's fixed-width record array, hex-encoded.
 *
 * Order is not normalised here: the native builder sorts, because the ledger's own well-formedness
 * check rejects unsorted inputs and only the side that builds the `UtxoSpend` can sort by the field
 * order that check uses.
 */
export const packUnshieldedInputs = (inputs: readonly UnshieldedSpend[]): string => {
  // A transfer with no inputs spends nothing and can only fail later; a *registration* legitimately
  // has none (see `packUnshieldedInputBytes`), which is why the guard sits here and not below.
  if (inputs.length === 0) throw new Error('no inputs to spend')
  return toHex(packUnshieldedInputBytes(inputs))
}

/**
 * The same records as raw bytes, and without the non-empty guard.
 *
 * Split out for `registerArg`, which embeds the records inside a larger argument rather than sending
 * them as the whole of one — and which accepts an empty list, because a deregistration spends nothing.
 */
export const packUnshieldedInputBytes = (inputs: readonly UnshieldedSpend[]): Uint8Array => {
  const packed = new Uint8Array(inputs.length * INPUT_RECORD_LEN)
  inputs.forEach((input, index) => {
    if (input.tokenType.length !== 32) {
      throw new Error(`input ${index}: token type must be 32 bytes, got ${input.tokenType.length}`)
    }
    if (input.intentHash.length !== 32) {
      throw new Error(`input ${index}: intent hash must be 32 bytes, got ${input.intentHash.length}`)
    }
    if (!Number.isInteger(input.outputIndex) || input.outputIndex < 0) {
      throw new Error(`input ${index}: output index must be a non-negative integer, got ${input.outputIndex}`)
    }
    const at = index * INPUT_RECORD_LEN
    writeUintLE(packed, at, input.value, 16, `input ${index} value`)
    packed.set(input.tokenType, at + 16)
    packed.set(input.intentHash, at + 48)
    writeUintLE(packed, at + 80, BigInt(input.outputIndex), 4, `input ${index} output index`)
  })
  return packed
}
