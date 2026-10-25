/**
 * The fountain encoder: a message in, an unbounded stream of QR-sized parts out.
 *
 * Parts 1..`seqLen` are the fragments in order, so a receiver in good conditions finishes in
 * exactly `seqLen` frames. After that it keeps emitting mixes forever, which is what lets a
 * receiver that missed frames finish without the sender ever knowing which.
 *
 * @module
 */

import {crc32} from './crc32.js'
import {chooseFragments, findNominalFragmentLength, partitionMessage, xorFragments} from './fountain.js'
import {encodePart, type FountainPart} from './part.js'
import {encodeMultiPartUr, encodeSinglePartUr} from './ur.js'

export type FountainEncoder = {
  /** How many fragments the message was cut into. 1 means it fits in a single-part UR. */
  readonly seqLen: number
  readonly messageLen: number
  readonly checksum: number
  /** True when the message fits one part, so {@link nextPart} emits the single-part form. */
  readonly isSinglePart: boolean
  /** The next part in the stream. Never terminates — call it as long as the QR is on screen. */
  readonly nextPart: () => string
  /** The raw part, for callers that want the fields rather than the UR string. */
  readonly nextFountainPart: () => FountainPart
}

/** `seqNum` is a CBOR uint32 on the wire, so the stream wraps rather than overflowing. */
const SEQ_NUM_MODULUS = 2 ** 32

export const fountainEncoder = (
  message: Uint8Array,
  type: string,
  maxFragmentLength: number,
  firstSeqNum = 0,
): FountainEncoder => {
  if (message.length === 0) throw new Error('fountainEncoder: the message is empty')

  const messageLen = message.length
  const checksum = crc32(message)
  const fragmentLength = findNominalFragmentLength(messageLen, maxFragmentLength)
  const fragments = partitionMessage(message, fragmentLength)
  const seqLen = fragments.length

  let seqNum = firstSeqNum

  const nextFountainPart = (): FountainPart => {
    seqNum = (seqNum + 1) % SEQ_NUM_MODULUS
    const indexes = chooseFragments(seqNum, seqLen, checksum)
    const chosen = indexes.map((index) => {
      const fragment = fragments[index]
      if (fragment === undefined) throw new Error(`fountainEncoder: fragment ${index} is missing`)
      return fragment
    })
    return {seqNum, seqLen, messageLen, checksum, data: xorFragments(chosen, fragmentLength)}
  }

  return {
    seqLen,
    messageLen,
    checksum,
    isSinglePart: seqLen === 1,
    nextFountainPart,
    nextPart: (): string => {
      // A message that fits one fragment is emitted as a plain single-part UR — the sequence
      // header and the fountain wrapper would be pure overhead, and receivers expect the short
      // form here.
      if (seqLen === 1) return encodeSinglePartUr({type, cbor: message})
      const part = nextFountainPart()
      return encodeMultiPartUr({type, cbor: encodePart(part), seqNum: part.seqNum, seqLen})
    },
  }
}
