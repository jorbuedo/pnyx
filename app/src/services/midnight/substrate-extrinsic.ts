/**
 * Wrapping a sealed Midnight transaction in the substrate extrinsic the node accepts.
 *
 * Every other transaction this app builds leaves unbound and the sponsor submits it. A **sealed**
 * transaction — one that pays its own DUST fee, and a DUST registration — is already complete, so
 * there is nothing for the sponsor to bind and its `/chain/submit` is the wrong door. The right door
 * is the chain's own `author_submitExtrinsic`, which takes a SCALE-encoded extrinsic.
 *
 * The extrinsic is **unsigned**: `midnight.send_mn_transaction` carries the transaction's own
 * signatures, so the substrate envelope adds none. That is why this needs no key and no account
 * nonce — which is also why it can be a pure function.
 *
 * ## The layout, verified against a real preprod extrinsic
 *
 * ```text
 * compact(len(body)) || body
 * body = 0x04                      // extrinsic v4, unsigned (the signed bit, 0x80, is clear)
 *      || palletIndex || callIndex // Midnight.send_mn_transaction
 *      || compact(len(tx)) || tx
 * ```
 *
 * Block `0x21c295` on preprod carries an extrinsic whose body begins `04 05 00 ed ba 6d …`, and its
 * lengths reconcile exactly: `0xbaed >> 2` = 11,963 transaction bytes, plus three prefix bytes and
 * two compact bytes = a 11,968-byte body, plus its own two-byte prefix = the 11,970 bytes the block
 * reports. The shape below is that reading, not a reading of the docs.
 *
 * ⚠️ **The throws here stay untyped, deliberately.** They are encoder *invariants* — a negative compact
 * value, an empty transaction, a runtime this build does not encode for — not runtime states a caller
 * branches on. Nothing chooses a different path because a compact value was negative; that is a bug.
 * The one boundary where a caller does need a kind is `submit-sealed`, which already wraps these in
 * `Effect.try` and reports `not-configured` or `malformed`. Giving them tagged errors as well would add
 * a vocabulary nobody reads.
 *
 * @module
 */

/**
 * The `Midnight.send_mn_transaction` call, and the runtime it was read from.
 *
 * A pallet index is a fact about a *runtime*, not about a chain, and substrate bumps
 * `transactionVersion` precisely when call encodings move. So the indices are pinned to the version
 * they were decoded from and {@link assertCallEncodingSupported} refuses anything else: submitting
 * index 5 to a runtime that has renumbered its pallets would dispatch some other pallet's call with
 * a transaction as its argument, which is a far worse outcome than a refusal.
 *
 * Read from preprod's metadata (v14) at `specVersion` 1000000: pallet `Midnight` is index 5 and its
 * call 0 is `send_mn_transaction` (call 1 is `set_tx_size_weight`).
 */
export const MIDNIGHT_CALL_ENCODING = {
  specName: 'midnight',
  transactionVersion: 3,
  palletIndex: 5,
  callIndex: 0,
} as const

/** Extrinsic format v4 with the signed bit (`0x80`) clear. */
const UNSIGNED_EXTRINSIC_V4 = 0x04

/** What `state_getRuntimeVersion` tells us that bears on the encoding above. */
export type SubstrateRuntimeVersion = {
  readonly specName: string
  readonly transactionVersion: number
}

/**
 * Throw unless `runtime` is the one {@link MIDNIGHT_CALL_ENCODING} was decoded against.
 *
 * Deliberately strict. The cost of a false refusal is a submit that fails with an actionable message;
 * the cost of a false acceptance is a signed Midnight transaction handed to whatever call now sits at
 * that index. Re-verifying after a runtime upgrade is one `state_getMetadata` decode.
 */
export const assertCallEncodingSupported = (runtime: SubstrateRuntimeVersion): void => {
  if (runtime.specName !== MIDNIGHT_CALL_ENCODING.specName) {
    throw new Error(`refusing to submit: the node runs '${runtime.specName}', not '${MIDNIGHT_CALL_ENCODING.specName}'`)
  }
  if (runtime.transactionVersion !== MIDNIGHT_CALL_ENCODING.transactionVersion) {
    throw new Error(
      `refusing to submit: this build encodes Midnight.send_mn_transaction for transactionVersion ` +
        `${MIDNIGHT_CALL_ENCODING.transactionVersion}, and the node reports ${runtime.transactionVersion}. ` +
        `Re-read the pallet and call indices from state_getMetadata before raising this.`,
    )
  }
}

/** The largest value SCALE's four-byte compact mode holds; above it the big-integer mode applies. */
const FOUR_BYTE_LIMIT = 0x4000_0000n

/**
 * SCALE compact ("parity") length encoding.
 *
 * Four modes, selected by the low two bits of the first byte: single-byte for values under 64,
 * two-byte under 2^14, four-byte under 2^30, and a big-integer mode above that which prefixes the
 * byte count. The big-integer arm is unreachable for a transaction — 2^30 bytes is a gigabyte — but
 * it is the codec, not a length helper, and a codec that is right for its inputs only by luck is the
 * kind of thing that gets reused somewhere it is wrong.
 */
export const encodeCompact = (value: number | bigint): Uint8Array => {
  const n = BigInt(value)
  if (n < 0n) throw new Error(`SCALE compact cannot encode a negative value: ${n}`)
  if (n < 0x40n) return Uint8Array.of(Number(n) << 2)
  if (n < 0x4000n) {
    const shifted = Number(n) * 4 + 0b01
    return Uint8Array.of(shifted & 0xff, (shifted >>> 8) & 0xff)
  }
  if (n < FOUR_BYTE_LIMIT) {
    const shifted = Number(n) * 4 + 0b10
    return Uint8Array.of(shifted & 0xff, (shifted >>> 8) & 0xff, (shifted >>> 16) & 0xff, (shifted >>> 24) & 0xff)
  }
  const bytes: number[] = []
  for (let rest = n; rest > 0n; rest >>= 8n) bytes.push(Number(rest & 0xffn))
  if (bytes.length > 67) throw new Error(`SCALE compact cannot encode a ${bytes.length}-byte value`)
  return Uint8Array.from([((bytes.length - 4) << 2) | 0b11, ...bytes])
}

/**
 * Wrap a sealed Midnight transaction as an unsigned `Midnight.send_mn_transaction` extrinsic.
 *
 * Takes the transaction bytes exactly as the native builder sealed them; nothing here inspects or
 * re-encodes them, because a sealed transaction's bytes are what its signatures cover.
 */
export const encodeSendMnTransaction = (transaction: Uint8Array): Uint8Array => {
  if (transaction.length === 0) {
    throw new Error('refusing to submit an empty transaction')
  }
  const argLength = encodeCompact(transaction.length)
  const body = new Uint8Array(3 + argLength.length + transaction.length)
  body[0] = UNSIGNED_EXTRINSIC_V4
  body[1] = MIDNIGHT_CALL_ENCODING.palletIndex
  body[2] = MIDNIGHT_CALL_ENCODING.callIndex
  body.set(argLength, 3)
  body.set(transaction, 3 + argLength.length)

  const bodyLength = encodeCompact(body.length)
  const extrinsic = new Uint8Array(bodyLength.length + body.length)
  extrinsic.set(bodyLength, 0)
  extrinsic.set(body, bodyLength.length)
  return extrinsic
}
