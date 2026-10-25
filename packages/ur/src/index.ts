/**
 * `@pnyx/ur` — Uniform Resources (BCR-2020-005), the QR envelope Keystone-compatible
 * wallets and dApps speak.
 *
 * Written in-repo rather than taken from npm: the Keystone registry packages are class-based,
 * stale, and sit on a permanently-beta codec with Node polyfills. Reasoning and the evidence:
 * `docs/mobile-shell-plan.md` Phase 11.
 *
 * @module
 */

export {
  BYTEWORDS,
  type BytewordsError,
  type BytewordsResult,
  type BytewordsStyle,
  bytewordsFromBytes,
  bytewordsToBytes,
  decodeBytewords,
  encodeBytewords,
} from './bytewords.js'
export {type CborReader, cborReader, expectTag, readMapEntries} from './cbor-read.js'
export {crc32, crc32Bytes} from './crc32.js'
export {
  chooseDegree,
  chooseFragments,
  findNominalFragmentLength,
  MIN_FRAGMENT_LENGTH,
  partitionMessage,
  shuffled,
  xorFragments,
  xorInto,
} from './fountain.js'
export {type DecoderProgress, type FountainDecoder, fountainDecoder, type ReceiveResult} from './fountain-decoder.js'
export {type FountainEncoder, fountainEncoder} from './fountain-encoder.js'
export {decodePart, encodePart, type FountainPart, type PartResult} from './part.js'
export {type RandomSampler, randomSampler} from './random-sampler.js'
export * from './registry.js'
export {
  decodeUr,
  encodeMultiPartUr,
  encodeSinglePartUr,
  isMultiPart,
  isUrFrame,
  isValidUrType,
  type MultiPartUr,
  type Ur,
  type UrError,
  type UrResult,
} from './ur.js'
export {type Xoshiro256, xoshiro256, xoshiro256FromString} from './xoshiro256.js'
