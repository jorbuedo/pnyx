import {CardKind, encodeChainAddress} from '@pnyx/contract-client/card'
import {describe, expect, it} from 'vitest'
import {cardEntryKey, entryForOption, offeredOptions, optionForEntry, valueForEntry} from './card-kind-label'

const OPTIONS = offeredOptions('preprod')

describe('cardEntryKey', () => {
  // Every kind the codec defines must have a label, or a card read off chain renders "Unrecognised"
  // for something this build actually understands. `ChainAddress` is checked through its own cases
  // below, because its label comes from the value.
  it('names every kind the codec defines', () => {
    for (const [name, kind] of Object.entries(CardKind)) {
      if (typeof kind !== 'number' || kind === CardKind.ChainAddress || kind === CardKind.Extended) continue
      expect(cardEntryKey(kind, 'x'), `kind ${name} (${kind})`).not.toBe('you.card.kind.unknown')
    }
  })

  // ⚠️ A kind added on chain after this build shipped. It must read as unrecognised, not as a guess: a
  // wrong label on an address is worse than no label.
  it('reports a kind it does not know as unrecognised', () => {
    expect(cardEntryKey(62, 'x')).toBe('you.card.kind.unknown')
  })

  // Zero is the contract's remove sentinel and can never be a stored row.
  it('does not claim to know kind zero', () => {
    expect(cardEntryKey(0, 'x')).toBe('you.card.kind.unknown')
  })

  it('names a chain address from its CAIP-2 namespace', () => {
    expect(cardEntryKey(CardKind.ChainAddress, encodeChainAddress('cardano:preprod', 'addr1x'))).toBe(
      'you.card.kind.cardano',
    )
    expect(cardEntryKey(CardKind.ChainAddress, encodeChainAddress('eip155:137', '0xabc'))).toBe('you.card.kind.evm')
    expect(
      cardEntryKey(CardKind.ChainAddress, encodeChainAddress('bip122:000000000019d6689c085ae165831e93', 'bc1q')),
    ).toBe('you.card.kind.bitcoin')
  })

  // Midnight's two forms share one chain id, so only the address distinguishes them.
  it('tells Midnight’s two address forms apart by the address', () => {
    expect(cardEntryKey(CardKind.ChainAddress, encodeChainAddress('midnight:preprod', 'mn_shield-addr1abc'))).toBe(
      'you.card.kind.midnightShielded',
    )
    expect(cardEntryKey(CardKind.ChainAddress, encodeChainAddress('midnight:preprod', 'mn_addr_preprod1abc'))).toBe(
      'you.card.kind.midnightUnshielded',
    )
  })

  it('reports an unparseable or unknown chain as unrecognised', () => {
    expect(cardEntryKey(CardKind.ChainAddress, 'nodelimiter')).toBe('you.card.kind.unknown')
    expect(cardEntryKey(CardKind.ChainAddress, encodeChainAddress('cosmos:hub-4', 'cosmos1x'))).toBe(
      'you.card.kind.unknown',
    )
  })
})

describe('offeredOptions', () => {
  it('offers only entries it can label', () => {
    for (const option of OPTIONS) expect(option.labelKey).not.toBe('you.card.kind.unknown')
  })

  it('offers each option once', () => {
    expect(new Set(OPTIONS.map((o) => o.id)).size).toBe(OPTIONS.length)
  })

  // ⚠️ The whole point of the restructure: a chain costs a list entry, not one of the 63 permanent
  // kind numbers. A new per-chain kind appearing here is the regression.
  it('spends one kind on every chain', () => {
    const chains = OPTIONS.filter((o) => o.chainId !== undefined)
    expect(chains.length).toBeGreaterThan(1)
    expect(new Set(chains.map((o) => o.kind))).toEqual(new Set([CardKind.ChainAddress]))
  })

  it('records the identity’s own network for Cardano and Midnight', () => {
    expect(offeredOptions('preprod').find((o) => o.id === 'cardano')?.chainId).toBe('cardano:preprod')
    expect(offeredOptions('mainnet').find((o) => o.id === 'cardano')?.chainId).toBe('cardano:mainnet')
    expect(offeredOptions('preprod').find((o) => o.id === 'midnight-shielded')?.chainId).toBe('midnight:preprod')
  })
})

describe('entry and option round trip', () => {
  it('puts the chain back in front of the address on save', () => {
    const option = OPTIONS.find((o) => o.id === 'cardano')
    if (option === undefined) throw new Error('no cardano option')
    const entry = entryForOption(option, '  addr1x  ')
    expect(entry.value).toBe('cardano:preprod addr1x')
    expect(valueForEntry(entry)).toBe('addr1x')
    expect(optionForEntry(entry).chainId).toBe('cardano:preprod')
  })

  // A half-filled row is an ordinary editing state, not an error — and it must not encode to a chain
  // id with nothing after it, which would decode as unrecognised.
  it('leaves an empty chain row empty rather than encoding a bare chain id', () => {
    const option = OPTIONS.find((o) => o.id === 'cardano')
    if (option === undefined) throw new Error('no cardano option')
    expect(entryForOption(option, '   ').value).toBe('   ')
  })

  it('keeps a non-chain value whole', () => {
    const option = OPTIONS.find((o) => o.id === 'website')
    if (option === undefined) throw new Error('no website option')
    const entry = entryForOption(option, 'https://example.com')
    expect(entry.value).toBe('https://example.com')
    expect(valueForEntry(entry)).toBe('https://example.com')
  })

  // ⚠️ A card may hold a chain this build does not offer. Rebuilding the option from the entry rather
  // than matching the offer list is what stops the next save deleting somebody's address.
  it('keeps a chain it does not offer', () => {
    const entry = {kind: CardKind.ChainAddress, value: encodeChainAddress('cosmos:hub-4', 'cosmos1x')}
    expect(optionForEntry(entry).chainId).toBe('cosmos:hub-4')
    expect(valueForEntry(entry)).toBe('cosmos1x')
  })
})
