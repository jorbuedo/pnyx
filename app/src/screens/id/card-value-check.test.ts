import {CardKind} from '@pnyx/contract-client/card'
import {encodeShieldedAddress} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {checkCardValue, checkChainAddressValue, invalidChainKey, invalidKey} from './card-value-check'

/** A real preprod unshielded address, from the abandon test wallet. */
const NIGHT = 'mn_addr_preprod1g84s5k7cxzw5fvxq3hgx4tjnse8nnp8s5wctep275catzsunah8q9e3aqx'
/**
 * A shielded address, built with the wallet's **own encoder** rather than pasted.
 *
 * ⚠️ A literal copied from `card.test.ts` looked like one and does not parse — that fixture exists there
 * only as a 132-byte *length* sample and is never decoded. Generating it here means the test cannot be
 * wrong about the format.
 */
const SHIELDED = encodeShieldedAddress(new Uint8Array(32).fill(7), new Uint8Array(32).fill(9), 'preprod')

describe('checkCardValue', () => {
  it('says nothing about an empty value', () => {
    expect(checkChainAddressValue('eip155:1', '   ')).toBe('unknown')
  })

  describe('Midnight', () => {
    it('accepts an unshielded address in the unshielded row', () => {
      expect(checkChainAddressValue('midnight:preprod', NIGHT, 'night')).toBe('ok')
    })

    it('accepts a shielded address in the shielded row', () => {
      expect(checkChainAddressValue('midnight:preprod', SHIELDED, 'shielded')).toBe('ok')
    })

    // ⚠️ Well formed, wrong place. A reader paying it would send to something that cannot receive.
    it('rejects a shielded address in the unshielded row, and the reverse', () => {
      expect(checkChainAddressValue('midnight:preprod', SHIELDED, 'night')).toBe('invalid')
      expect(checkChainAddressValue('midnight:preprod', NIGHT, 'shielded')).toBe('invalid')
    })

    it('rejects a corrupted address', () => {
      expect(checkChainAddressValue('midnight:preprod', `${NIGHT}xx`, 'night')).toBe('invalid')
    })
  })

  describe('Solana', () => {
    // base58 of 32 bytes is the whole condition for a Solana address.
    it('accepts a 32-byte base58 key', () => {
      expect(
        checkChainAddressValue('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '11111111111111111111111111111111'),
      ).toBe('ok')
    })

    it('rejects base58 of the wrong length', () => {
      expect(checkChainAddressValue('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '1111')).toBe('invalid')
    })

    it('rejects a non-base58 string', () => {
      // `0`, `O`, `I` and `l` are outside the Bitcoin alphabet.
      expect(
        checkChainAddressValue('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'),
      ).toBe('invalid')
    })
  })

  describe('Bitcoin', () => {
    it('accepts a mainnet segwit v0 address', () => {
      expect(
        checkChainAddressValue('bip122:000000000019d6689c085ae165831e93', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
      ).toBe('ok')
    })

    it('accepts a taproot address', () => {
      expect(
        checkChainAddressValue(
          'bip122:000000000019d6689c085ae165831e93',
          'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
        ),
      ).toBe('ok')
    })

    it('accepts a testnet address', () => {
      expect(
        checkChainAddressValue('bip122:000000000019d6689c085ae165831e93', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'),
      ).toBe('ok')
    })

    // A string announcing itself as segwit and then failing to decode is decidably wrong, and a typo'd
    // `bc1…` is the common case.
    it('rejects a corrupted segwit address', () => {
      expect(
        checkChainAddressValue('bip122:000000000019d6689c085ae165831e93', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'),
      ).toBe('invalid')
    })

    // ⚠️ Not "invalid": legacy addresses are base58check and there is no checksum coder here, so a
    // wrong answer would block a working address. "Cannot tell" is the honest verdict.
    it('cannot decide a legacy base58check address', () => {
      expect(
        checkChainAddressValue('bip122:000000000019d6689c085ae165831e93', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
      ).toBe('unknown')
    })

    it('cannot decide a bech32 address from another chain', () => {
      // A valid bech32 string whose prefix is not a Bitcoin one falls through to the legacy branch.
      expect(checkChainAddressValue('bip122:000000000019d6689c085ae165831e93', NIGHT)).toBe('unknown')
    })
  })

  describe('EVM', () => {
    it('accepts 0x and forty hex digits', () => {
      expect(checkChainAddressValue('eip155:1', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe('ok')
      expect(checkChainAddressValue('eip155:1', '0x52908400098527886e0f7030069857d2e4169ee7')).toBe('ok')
    })

    it('rejects the wrong length or a missing prefix', () => {
      expect(checkChainAddressValue('eip155:1', '0x52908400098527886E0F7030069857D2E4169EE')).toBe('invalid')
      expect(checkChainAddressValue('eip155:1', '52908400098527886E0F7030069857D2E4169EE7')).toBe('invalid')
    })
  })

  describe('Email', () => {
    it('accepts an ordinary address', () => {
      expect(checkCardValue(CardKind.Email, 'a.b+c@example.co.uk')).toBe('ok')
    })

    it('rejects one with no domain dot, no local part, or a space', () => {
      expect(checkCardValue(CardKind.Email, 'a@b')).toBe('invalid')
      expect(checkCardValue(CardKind.Email, '@b.test')).toBe('invalid')
      expect(checkCardValue(CardKind.Email, 'a b@c.test')).toBe('invalid')
    })
  })

  // Free-form kinds must never be flagged: there is no shape to be wrong about.
  it.each([
    CardKind.Note,
    CardKind.Website,
    CardKind.Phone,
    CardKind.SocialHandle,
    CardKind.Did,
  ])('says nothing about kind %i', (kind) => {
    expect(checkCardValue(kind, 'anything at all')).toBe('unknown')
  })

  // Cardano has an Effect-based decoder, so this entry point cannot answer for it.
  it('does not answer for Cardano', () => {
    expect(checkChainAddressValue('cardano:preprod', 'addr1xyz')).toBe('unknown')
  })
})

describe('invalidKey', () => {
  // Every kind this module can actually call invalid gets its own message; the generic one is the
  // fallback for kinds that cannot be judged and so never reach it.
  it('names a specific message for the one kind it can judge', () => {
    expect(invalidKey(CardKind.Email)).not.toBe('you.card.invalidValue')
  })

  // Every address shares one kind now, so the specific message comes from the chain instead.
  it.each([
    ['midnight:preprod', 'night'],
    ['midnight:preprod', 'shielded'],
    ['cardano:preprod', undefined],
    ['bip122:000000000019d6689c085ae165831e93', undefined],
    ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', undefined],
    ['eip155:1', undefined],
  ] as const)('names a specific message for %s', (chainId, expect_) => {
    expect(invalidChainKey(chainId, expect_)).not.toBe('you.card.invalidValue')
  })

  // ⚠️ Midnight's two forms must not share a message: "that is not a shielded address" sends someone
  // hunting for a fault in an address that is simply in the wrong row.
  it('tells Midnight’s two forms apart', () => {
    expect(invalidChainKey('midnight:preprod', 'night')).not.toBe(invalidChainKey('midnight:preprod', 'shielded'))
  })

  it('falls back for a chain it does not know', () => {
    expect(invalidChainKey('cosmos:hub-4')).toBe('you.card.invalidValue')
  })

  it('falls back for a kind it cannot judge', () => {
    expect(invalidKey(CardKind.Note)).toBe('you.card.invalidValue')
  })

  // The two must agree: a kind with a specific message must be one the checks can decide, or the message
  // is unreachable — and a kind the checks reject with only the generic message is a worse error than
  // none. Anything checkable must be named.
  it('names a message for every kind the checks can reject', () => {
    // Each with an input that kind can actually judge. ⚠️ Bitcoin needs a `bc1…` prefix to be judged at
    // all — free text falls to the legacy branch and is `unknown` by design — so the pairing is stated
    // per kind rather than with one shared string that would quietly skip the interesting case.
    const chains: readonly [string, string, ('night' | 'shielded')?][] = [
      ['midnight:preprod', 'not an address', 'night'],
      ['midnight:preprod', 'not an address', 'shielded'],
      ['bip122:000000000019d6689c085ae165831e93', 'bc1qnotarealaddressatall'],
      ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'not-base58-0OIl'],
      ['eip155:1', '0xnope'],
    ]
    for (const [chainId, bad, expect_] of chains) {
      expect(checkChainAddressValue(chainId, bad, expect_), chainId).toBe('invalid')
    }
    // A chain's message is keyed on its namespace, the same axis the check uses.
    for (const [chainId, , expect_] of chains) {
      expect(invalidChainKey(chainId, expect_), chainId).not.toBe('you.card.invalidValue')
    }
    expect(checkCardValue(CardKind.Email, 'nope')).toBe('invalid')
    expect(invalidKey(CardKind.Email)).not.toBe('you.card.invalidValue')
  })
})
