/**
 * Whether a card entry's value is plausible for its kind.
 *
 * **Decoded, not pattern-matched**, wherever the app has a decoder. `@pnyx/wallet`'s
 * `parseMidnightAddress` is the parser the send funnel uses, and `@pnyx/crypto` carries the base58 and
 * bech32 coders the Bitcoin and Solana rails encode with — so these checks fail on the same inputs the
 * rest of the app fails on rather than on a hand-written approximation of them.
 *
 * ⚠️ **Two kinds are deliberately unchecked, and saying so is the point.** A red error on a valid
 * address is worse than no error at all: it stops someone publishing an address that works. So a kind
 * this build cannot decide returns `unknown`, the caller shows nothing, and the gap is recorded rather
 * than papered over with a regex.
 *
 * | kind | check |
 * |---|---|
 * | Cardano | ⚠️ `unknown` here — the decoder is Effect-based and async; see `checkCardanoCardValue` |
 * | Midnight (unshielded / shielded) | decoded, **and the kind must match the row's** |
 * | Bitcoin | bech32/bech32m segwit decoded; ⚠️ legacy base58check is `unknown` (no checksum coder) |
 * | Solana | base58 decodes to exactly 32 bytes — that is the whole condition |
 * | EVM | `0x` + 40 hex. ⚠️ EIP-55 case checksum **not** verified: it needs keccak, and rejecting a
 *   valid all-lowercase address to enforce it would be the error this module refuses to make |
 * | Email | one `@`, something either side, a dot in the domain |
 * | DID, Website, Phone, Note, Social | `unknown` — free-form by design |
 *
 * @module
 */

import {CardKind} from '@pnyx/contract-client/card'
import {base58, bech32, bech32m} from '@pnyx/crypto'
import {parseMidnightAddress} from '@pnyx/wallet'
import {Either} from 'effect'

/** `unknown` means *not decidable here* — never "probably fine". The caller shows nothing for it. */
export type CardValueCheck = 'ok' | 'invalid' | 'unknown'

/** Bitcoin segwit human-readable parts: mainnet, testnet, regtest. */
const BTC_HRPS = new Set(['bc', 'tb', 'bcrt'])

/**
 * A bech32 prefix, or `undefined` when this coder does not accept the string.
 *
 * `Either.try` rather than a bare `catch`, matching how `@pnyx/crypto`'s own decoders are written: a
 * coder rejecting a string is a **value** here and not an error path, so there is nothing to log. A
 * swallowing `catch` would also be banned outright (`CLAUDE.md`), and rightly — the difference is that
 * this expresses the fork instead of hiding one.
 */
const bech32Prefix = (coder: typeof bech32, address: string): string | undefined => {
  // 90 is BIP-173's limit; a longer string is not a segwit address whatever else it is.
  const decoded = Either.try(() => coder.decode(address as `${string}1${string}`, 90))
  return Either.isRight(decoded) ? decoded.right.prefix : undefined
}

const checkBitcoin = (value: string): CardValueCheck => {
  const lower = value.toLowerCase()
  for (const coder of [bech32, bech32m]) {
    const prefix = bech32Prefix(coder, lower)
    if (prefix !== undefined && BTC_HRPS.has(prefix)) return 'ok'
  }
  // A string that *announces* itself as segwit and then does not decode is decidably wrong — a typo'd
  // `bc1…` is the common case, and staying silent about it would be the more useless answer.
  if ([...BTC_HRPS].some((hrp) => lower.startsWith(`${hrp}1`))) return 'invalid'
  // ⚠️ Legacy `1…` / `3…` addresses are base58**check**, and there is no checksum coder here. Decoding
  // the base58 alone would accept a typo'd address, so this says "cannot tell" instead.
  return 'unknown'
}

const checkSolana = (value: string): CardValueCheck => {
  const decoded = base58.decode(value)
  if (Either.isLeft(decoded)) return 'invalid'
  return decoded.right.length === 32 ? 'ok' : 'invalid'
}

const EVM = /^0x[0-9a-fA-F]{40}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Check `value` for `kind`, synchronously.
 *
 * Cardano is absent on purpose: its decoder runs under an Effect layer, so it has its own async
 * entry point and this one reports `unknown` for it.
 */
export const checkCardValue = (kind: number, value: string): CardValueCheck => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'unknown'
  if (kind === CardKind.Email) return EMAIL.test(trimmed) ? 'ok' : 'invalid'
  return 'unknown'
}

/**
 * Check an address against the chain it claims to be for.
 *
 * ⚠️ Keyed on the CAIP-2 **namespace**, not the whole id: `eip155:1` and `eip155:137` are the same
 * address format, and enumerating every reference would make this a list that goes stale.
 *
 * `expect` disambiguates Midnight's two address forms, which share one chain id — a shielded address
 * in the unshielded row is well-formed and in the wrong place, and a reader who paid it would send to
 * something that cannot receive.
 */
export const checkChainAddressValue = (
  chainId: string,
  value: string,
  expect?: 'night' | 'shielded',
): CardValueCheck => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'unknown'
  const namespace = chainId.slice(0, chainId.indexOf(':'))
  switch (namespace) {
    case 'midnight': {
      const parsed = parseMidnightAddress(trimmed)
      if (!parsed.ok) return 'invalid'
      return expect === undefined || parsed.kind === expect ? 'ok' : 'invalid'
    }
    case 'bip122':
      return checkBitcoin(trimmed)
    case 'solana':
      return checkSolana(trimmed)
    case 'eip155':
      return EVM.test(trimmed) ? 'ok' : 'invalid'
    // Cardano cannot be checked here — its decoder runs under an Effect layer, so it has its own
    // asynchronous entry point.
    default:
      return 'unknown'
  }
}

/**
 * The Cardano check, which cannot be synchronous: its decoder runs under an Effect layer.
 *
 * Reuses `validateCardanoAddress` — the contacts screen's own check — rather than a second copy, since
 * the two surfaces ask the same question about the same string.
 */
export const checkCardanoCardValue = async (value: string): Promise<CardValueCheck> => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'unknown'
  const {validateCardanoAddress} = await import('../../services/contacts/validation')
  const {Effect} = await import('effect')
  const result = await Effect.runPromise(validateCardanoAddress(trimmed))
  return result.ok ? 'ok' : 'invalid'
}

/**
 * Which message names an invalid value, per kind.
 *
 * Per kind rather than one "that does not look right", because the useful half of the message is what a
 * *good* one looks like — and only the kind knows that.
 */
export type CardInvalidKey = `you.card.invalid${
  | 'Midnight'
  | 'MidnightShielded'
  | 'Cardano'
  | 'Bitcoin'
  | 'Solana'
  | 'Evm'
  | 'Email'
  | 'Value'}`

/** @see CardInvalidKey */
export const invalidKey = (kind: number): CardInvalidKey => {
  if (kind === CardKind.Email) return 'you.card.invalidEmail'
  return 'you.card.invalidValue'
}

/**
 * The message for a chain address, keyed on the CAIP-2 namespace — the same axis the check uses.
 *
 * `expect` picks between Midnight's two, which share a chain id and need different advice: telling
 * somebody their shielded address is malformed when it is simply in the unshielded row would send them
 * looking for a fault in a perfectly good address.
 */
export const invalidChainKey = (chainId: string, expect?: 'night' | 'shielded'): CardInvalidKey => {
  switch (chainId.slice(0, chainId.indexOf(':'))) {
    case 'midnight':
      return expect === 'shielded' ? 'you.card.invalidMidnightShielded' : 'you.card.invalidMidnight'
    case 'cardano':
      return 'you.card.invalidCardano'
    case 'bip122':
      return 'you.card.invalidBitcoin'
    case 'solana':
      return 'you.card.invalidSolana'
    case 'eip155':
      return 'you.card.invalidEvm'
    default:
      return 'you.card.invalidValue'
  }
}
