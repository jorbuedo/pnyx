/**
 * The co-funding bridge's wire format, as pure functions.
 *
 * Split from `index.ts` for the same reason as `unshielded-wire.ts`: that module pulls
 * `expo-modules-core`, which needs an Expo global no test runner has, and the packing is the layer
 * worth testing.
 *
 * ⚠️ **Co-funding here means several wallets funding ONE payment** — not several payments bundled.
 * The distinction and why it matters are in `docs/MIDNIGHT_COFUNDING_PLAN.md`; the short version is
 * that `Transaction::merge` does the other thing and must not be used for this.
 *
 * @module
 */

import {INPUT_RECORD_LEN, type UnshieldedSpend} from './unshielded-wire.js'

/**
 * `owner(32) ‖ contributes(16, u128 LE) ‖ inputCount(4, u32 LE)`, then that many input records.
 *
 * Must equal `CONTRIBUTION_HEADER_LEN` in `rust/src/cofunded.rs`, which reads them back. Unlike the
 * input array this is variable-length per record, so the native side walks it and refuses a header or
 * a run of inputs that overruns the buffer rather than reading a short one.
 */
export const CONTRIBUTION_HEADER_LEN = 52

/** `index(4, u32 LE) ‖ signature(64)`. Must equal `SHARE_RECORD_LEN` in `rust/src/cofunded.rs`. */
export const SHARE_RECORD_LEN = 68

/** What one wallet puts into a co-funded payment. */
export type CoFundContribution = {
  /**
   * The contributor's Night **verifying** key — 32 bytes, BIP-340 x-only.
   *
   * ⚠️ Not the address. `UtxoSpend.owner` is the full verifying key while an indexer reports only its
   * hash, so a contributor has to publish this; it cannot be derived from what the composer can look
   * up.
   */
  readonly owner: Uint8Array
  readonly inputs: readonly UnshieldedSpend[]
  /** How much of the payment this wallet covers. Its change is `sum(inputs) − contributes`. */
  readonly contributes: bigint
}

/** One contributor's signature, and the input it belongs to. */
export type CoFundShare = {
  /** The input's index in the **finalised, sorted** offer — never a position in the sender's own list. */
  readonly index: number
  /** 64 bytes. */
  readonly signature: Uint8Array
}

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error(`hex must have an even length, got ${hex.length}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('hex contains a character that is not a hex digit')
    out[i] = byte
  }
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
 * Pack every contribution for the composer's build step, hex-encoded.
 *
 * Order is not normalised: the native side sorts the inputs, because the ledger's well-formedness
 * check rejects unsorted ones and sorting is also what fixes each signature's index.
 */
export const packCoFundContributions = (contributions: readonly CoFundContribution[]): string => {
  if (contributions.length === 0) throw new Error('a co-funded payment needs at least one contributor')
  const size = contributions.reduce(
    (total, c) => total + CONTRIBUTION_HEADER_LEN + c.inputs.length * INPUT_RECORD_LEN,
    0,
  )
  const packed = new Uint8Array(size)
  let at = 0
  contributions.forEach((contribution, index) => {
    if (contribution.owner.length !== 32) {
      throw new Error(`contributor ${index}: owner must be 32 bytes, got ${contribution.owner.length}`)
    }
    if (contribution.inputs.length === 0) {
      throw new Error(`contributor ${index}: a contributor with no inputs cannot fund anything`)
    }
    packed.set(contribution.owner, at)
    writeUintLE(packed, at + 32, contribution.contributes, 16, `contributor ${index} pledge`)
    writeUintLE(packed, at + 48, BigInt(contribution.inputs.length), 4, `contributor ${index} input count`)
    at += CONTRIBUTION_HEADER_LEN
    contribution.inputs.forEach((input, n) => {
      if (input.tokenType.length !== 32) {
        throw new Error(`contributor ${index} input ${n}: token type must be 32 bytes`)
      }
      if (input.intentHash.length !== 32) {
        throw new Error(`contributor ${index} input ${n}: intent hash must be 32 bytes`)
      }
      writeUintLE(packed, at, input.value, 16, `contributor ${index} input ${n} value`)
      packed.set(input.tokenType, at + 16)
      packed.set(input.intentHash, at + 48)
      writeUintLE(packed, at + 80, BigInt(input.outputIndex), 4, `contributor ${index} input ${n} output index`)
      at += INPUT_RECORD_LEN
    })
  })
  return toHex(packed)
}

/**
 * Read the shares one contributor answered with.
 *
 * An empty string is a real answer — that wallet owns none of the offer's inputs — and is returned as
 * an empty list rather than as a failure, so a co-signer that was asked in error can be told so.
 */
export const unpackCoFundShares = (hex: string): readonly CoFundShare[] => {
  if (hex.length === 0) return []
  const bytes = fromHex(hex)
  if (bytes.length % SHARE_RECORD_LEN !== 0) {
    throw new Error(`shares are ${bytes.length} bytes, not a whole number of ${SHARE_RECORD_LEN}-byte records`)
  }
  const shares: CoFundShare[] = []
  for (let at = 0; at < bytes.length; at += SHARE_RECORD_LEN) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 4)
    shares.push({index: view.getUint32(0, true), signature: bytes.slice(at + 4, at + SHARE_RECORD_LEN)})
  }
  return shares
}

/**
 * Pack the gathered shares for the composer's assemble step.
 *
 * ⚠️ Deliberately does **not** sort or deduplicate. A repeated index and a missing one are both
 * mistakes the native side names precisely — quietly fixing them here would hide which contributor
 * answered twice or not at all.
 */
export const packCoFundShares = (shares: readonly CoFundShare[]): string => {
  const packed = new Uint8Array(shares.length * SHARE_RECORD_LEN)
  shares.forEach((share, n) => {
    if (share.signature.length !== SHARE_RECORD_LEN - 4) {
      throw new Error(`share ${n}: signature must be ${SHARE_RECORD_LEN - 4} bytes, got ${share.signature.length}`)
    }
    if (!Number.isInteger(share.index) || share.index < 0) {
      throw new Error(`share ${n}: index must be a non-negative integer, got ${share.index}`)
    }
    const at = n * SHARE_RECORD_LEN
    writeUintLE(packed, at, BigInt(share.index), 4, `share ${n} index`)
    packed.set(share.signature, at + 4)
  })
  return toHex(packed)
}
