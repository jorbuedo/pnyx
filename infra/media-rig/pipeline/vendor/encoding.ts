/**
 * Address string encodings, backed by @scure/base.
 *
 * base58 → Solana addresses; bech32/bech32m → Bitcoin segwit (and reusable for
 * other bech32 chains). Encoding is infallible for well-formed inputs; decoding
 * can throw on malformed input, so decoders return an Either.
 *
 * @module
 */

import {base58 as scureBase58, bech32 as scureBech32, bech32m as scureBech32m} from '@scure/base'
import {Either} from 'effect'
import {CodecError} from './errors.js'

/** Base58 (Bitcoin alphabet) — encode is total; decode fails typed on bad input. */
export const base58 = {
  encode: (bytes: Uint8Array): string => scureBase58.encode(bytes),
  decode: (text: string): Either.Either<Uint8Array, CodecError> =>
    Either.try({
      try: () => scureBase58.decode(text),
      catch: (e) =>
        new CodecError({message: `invalid base58: ${e instanceof Error ? e.message : String(e)}`, cause: e}),
    }),
}

/** Re-export the raw @scure/base bech32 coders for callers needing words access. */
export {scureBech32 as bech32, scureBech32m as bech32m}

/**
 * Encode a SegWit address (BIP-173 for v0 / BIP-350 bech32m for v1+). `program`
 * is the raw witness program (e.g. the 20-byte HASH160 for P2WPKH). `hrp` is the
 * network prefix (`bc` mainnet, `tb` testnet).
 */
export const encodeSegwitAddress = (hrp: string, witnessVersion: number, program: Uint8Array): string => {
  const words = [witnessVersion, ...scureBech32.toWords(program)]
  // v0 uses bech32; v1+ uses bech32m (BIP-350).
  const coder = witnessVersion === 0 ? scureBech32 : scureBech32m
  return coder.encode(hrp, words, 90)
}
