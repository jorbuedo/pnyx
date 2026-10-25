/**
 * The fountain decoder: parts in, the original message out once enough have arrived.
 *
 * The reduction is Gaussian elimination over GF(2). A part carries the XOR of a known set of
 * fragment indexes; XORing two parts whose index sets nest cancels the shared fragments. So every
 * arriving part is reduced by what is already known, and whenever that leaves a single index the
 * fragment is recovered — which in turn may reduce parts already held. That cascade is why a
 * newly-solved fragment has to be pushed back through the mixed set rather than just stored.
 *
 * @module
 */

import {crc32} from './crc32.js'
import {chooseFragments, xorInto} from './fountain.js'
import {decodePart, type FountainPart} from './part.js'

type IndexedPart = {
  /** Ascending, unique. A single index means the fragment itself. */
  readonly indexes: readonly number[]
  readonly data: Uint8Array
}

export type DecoderProgress = {
  /** Distinct fragments recovered so far. */
  readonly received: number
  /** Total fragments in the message, once known. */
  readonly expected: number | undefined
  /** `received / expected`, or 0 before the first part. */
  readonly fraction: number
}

export type ReceiveResult =
  /** Accepted and merged. */
  | {readonly kind: 'accepted'}
  /** Valid but told us nothing new — a duplicate or an already-solved mix. */
  | {readonly kind: 'redundant'}
  /** The message is complete; `message` is the original bytes. */
  | {readonly kind: 'complete'; readonly message: Uint8Array}
  /**
   * Rejected. `fatal` means the part belongs to a *different* message than the one in progress,
   * so a caller showing a scanner should surface it rather than silently ignoring frames.
   */
  | {readonly kind: 'rejected'; readonly reason: string; readonly fatal: boolean}

export type FountainDecoder = {
  readonly receivePart: (cbor: Uint8Array) => ReceiveResult
  readonly progress: () => DecoderProgress
  /** The assembled message, once complete. */
  readonly message: () => Uint8Array | undefined
  readonly isComplete: () => boolean
  /** Forget everything, e.g. when the user restarts a scan. */
  readonly reset: () => void
}

const sameIndexes = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i])

/** True when every index of `subset` appears in `superset`. Both are ascending. */
const isSubset = (subset: readonly number[], superset: readonly number[]): boolean => {
  const haystack = new Set(superset)
  return subset.every((index) => haystack.has(index))
}

/** `a` reduced by `b`, when `b`'s indexes nest inside `a`'s. Otherwise `a` unchanged. */
const reduce = (a: IndexedPart, b: IndexedPart): IndexedPart => {
  if (a.indexes.length <= b.indexes.length || !isSubset(b.indexes, a.indexes)) return a
  const remaining = new Set(b.indexes)
  const data = Uint8Array.from(a.data)
  xorInto(data, b.data)
  return {indexes: a.indexes.filter((index) => !remaining.has(index)), data}
}

export const fountainDecoder = (): FountainDecoder => {
  let seqLen: number | undefined
  let messageLen: number | undefined
  let checksum: number | undefined
  let fragmentLen: number | undefined
  let assembled: Uint8Array | undefined

  /** Solved fragments, by index. */
  let simple = new Map<number, Uint8Array>()
  /** Parts still carrying more than one fragment. */
  let mixed: IndexedPart[] = []

  const reset = (): void => {
    seqLen = undefined
    messageLen = undefined
    checksum = undefined
    fragmentLen = undefined
    assembled = undefined
    simple = new Map()
    mixed = []
  }

  /** Join the solved fragments and strip the padding the encoder added. */
  const assemble = (): Uint8Array | undefined => {
    if (seqLen === undefined || messageLen === undefined || fragmentLen === undefined) return undefined
    const out = new Uint8Array(seqLen * fragmentLen)
    for (let index = 0; index < seqLen; index++) {
      const fragment = simple.get(index)
      if (fragment === undefined) return undefined
      out.set(fragment, index * fragmentLen)
    }
    return out.subarray(0, messageLen)
  }

  /**
   * Record a solved fragment and cascade: it may reduce parts already held, each of which may
   * solve another fragment. Iterative rather than recursive so a long chain cannot blow the stack.
   */
  const absorb = (first: IndexedPart): void => {
    const queue: IndexedPart[] = [first]
    while (queue.length > 0) {
      const part = queue.shift()
      if (part === undefined) break
      const index = part.indexes[0]
      if (index === undefined || simple.has(index)) continue
      simple.set(index, part.data)

      const stillMixed: IndexedPart[] = []
      for (const candidate of mixed) {
        const reduced = reduce(candidate, part)
        if (reduced.indexes.length === 1) queue.push(reduced)
        else if (reduced.indexes.length > 1) stillMixed.push(reduced)
        // Zero indexes means it reduced to nothing — it carried no new information.
      }
      mixed = stillMixed
    }
  }

  const receivePart = (cbor: Uint8Array): ReceiveResult => {
    if (assembled !== undefined) return {kind: 'complete', message: assembled}

    const parsed = decodePart(cbor)
    if (!parsed.ok) return {kind: 'rejected', reason: parsed.error, fatal: false}
    const part: FountainPart = parsed.part

    if (seqLen === undefined) {
      seqLen = part.seqLen
      messageLen = part.messageLen
      checksum = part.checksum
      fragmentLen = part.data.length
    } else if (part.seqLen !== seqLen || part.messageLen !== messageLen || part.checksum !== checksum) {
      // A different message. Surfaced as fatal so a scanner can say so instead of appearing to
      // stall while the user films the wrong device.
      return {kind: 'rejected', reason: 'this part belongs to a different message', fatal: true}
    } else if (part.data.length !== fragmentLen) {
      return {kind: 'rejected', reason: 'inconsistent fragment length', fatal: true}
    }

    const indexes = chooseFragments(part.seqNum, seqLen, part.checksum)
    let candidate: IndexedPart = {indexes: [...indexes], data: Uint8Array.from(part.data)}

    // Reduce by everything already known, solved fragments first.
    for (const [index, data] of simple) {
      candidate = reduce(candidate, {indexes: [index], data})
    }
    for (const held of mixed) {
      candidate = reduce(candidate, held)
    }

    if (candidate.indexes.length === 0) return {kind: 'redundant'}

    if (candidate.indexes.length === 1) {
      const index = candidate.indexes[0]
      if (index !== undefined && simple.has(index)) return {kind: 'redundant'}
      absorb(candidate)
    } else {
      if (mixed.some((held) => sameIndexes(held.indexes, candidate.indexes))) return {kind: 'redundant'}
      mixed.push(candidate)
    }

    if (simple.size === seqLen) {
      const message = assemble()
      if (message === undefined) return {kind: 'accepted'}
      // The checksum is the only end-to-end guard: fragments arrive individually CRC-checked by
      // the Bytewords layer, but nothing else proves they belong to one message.
      if (checksum !== undefined && crc32(message) !== checksum) {
        reset()
        return {kind: 'rejected', reason: 'the assembled message failed its checksum', fatal: true}
      }
      assembled = Uint8Array.from(message)
      return {kind: 'complete', message: assembled}
    }

    return {kind: 'accepted'}
  }

  return {
    receivePart,
    progress: (): DecoderProgress => ({
      received: simple.size,
      expected: seqLen,
      fraction: seqLen === undefined || seqLen === 0 ? 0 : simple.size / seqLen,
    }),
    message: () => assembled,
    isComplete: () => assembled !== undefined,
    reset,
  }
}
