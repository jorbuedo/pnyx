// The sponsor seed, in either of the two formats a human can legitimately hand this host.
//
// The wallet SDK consumes a **hex master seed** (`WalletSeeds.fromMasterSeed`), which is what every
// caller passed until now. It is also a format the *app* can never open: the enclave vault stores a
// BIP-39 phrase and every Midnight key comes from `mnemonicToSeed`, which is PBKDF2 and one-way. So a
// wallet minted as `randomBytes(32)` can hold funds and deploy contracts while being impossible to
// inspect from the product it sponsors. Accepting a **phrase** is what lets one wallet be both, and it
// is the format the file on the box holds from 2026-08-20 on.
//
// The conversion is the SDK's own — pbkdf2 over the NFKD phrase, then hex, exactly what
// `WalletSeeds.fromMnemonic` does — and `master-seed.test.ts` pins it against that function rather
// than trusting this file to reimplement BIP-39 correctly.
//
// **It fails closed, because `mnemonicToSeedSync` validates nothing.** A phrase with one mistyped word
// derives a different, perfectly valid, empty wallet; on a fee-paying host that reads as "the chain is
// broken", not "the seed is wrong". So the checksum is verified before deriving, and an input that is
// neither a phrase nor a seed is refused rather than guessed at.
import {bytesToHex} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync, validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'

/** Which format the input turned out to be. Worth logging: it is the difference between two wallets. */
export type MasterSeedFormat = 'hex' | 'mnemonic'

export type MasterSeedResult =
  | {
      readonly ok: true
      /** Hex, ready for `WalletSeeds.fromMasterSeed`. */
      readonly masterSeed: string
      readonly format: MasterSeedFormat
      /** Non-secret description of what was read, safe to log (`24-word mnemonic`, `32-byte hex seed`). */
      readonly summary: string
    }
  | {readonly ok: false; readonly reason: string}

/** 32-byte legacy seeds and the 64-byte seed a BIP-39 phrase derives to. */
const HEX_SEED_LENGTHS = new Set([64, 128])

/**
 * Read a sponsor seed from text, as either a BIP-39 mnemonic or a hex master seed.
 *
 * Surrounding and repeated whitespace is collapsed before deriving, which is load-bearing rather than
 * hygiene: a file ends in a newline, and BIP-39 hashes the phrase *as given*, so `phrase\n` and the
 * single-space phrase the app derives from would otherwise be two different wallets.
 *
 * Neither the phrase nor the seed appears in `reason` — a refusal gets logged, and a log is the one
 * place this secret must never reach.
 */
export const masterSeedFrom = (input: string): MasterSeedResult => {
  const text = input.trim()
  if (text === '') return {ok: false, reason: 'the seed is empty'}

  if (!/\s/.test(text) && /^[0-9a-fA-F]+$/.test(text)) {
    if (!HEX_SEED_LENGTHS.has(text.length)) {
      return {
        ok: false,
        reason: `a hex seed of ${text.length} characters is neither 64 (32 bytes) nor 128 (a BIP-39 seed)`,
      }
    }
    return {ok: true, masterSeed: text.toLowerCase(), format: 'hex', summary: `${text.length / 2}-byte hex seed`}
  }

  const words = text.split(/\s+/)
  const phrase = words.join(' ')
  if (!validateMnemonic(phrase, wordlist)) {
    return {
      ok: false,
      reason: `${words.length} words that are not a valid BIP-39 mnemonic, and not a hex seed either`,
    }
  }
  return {
    ok: true,
    masterSeed: bytesToHex(mnemonicToSeedSync(phrase)),
    format: 'mnemonic',
    summary: `${words.length}-word mnemonic`,
  }
}
