/**
 * Which translation key names a card entry, and which entries this build offers to add.
 *
 * Its own pure module so the mapping is exhaustive and testable. The kind numbers are **frozen once a
 * card exists on chain** (`@pnyx/contract-client/card`), so that table only ever grows — and a kind
 * this build does not know must render as *unrecognised* rather than as a guess, because a wrong label
 * on an address is worse than no label.
 *
 * ⚠️ **A chain is not a kind.** Every address is `CardKind.ChainAddress` with a CAIP-2 id inside the
 * value, so adding a chain costs an entry in this list rather than one of the 63 permanent, never
 * reusable kind numbers. The *labels* still name chains, because that is what a user picks — only the
 * storage changed.
 *
 * @module
 */

import {type CardEntry, CardKind, decodeChainAddress, encodeChainAddress} from '@pnyx/contract-client/card'

export type CardKindKey = `you.card.kind.${
  | 'midnightShielded'
  | 'midnightUnshielded'
  | 'cardano'
  | 'bitcoin'
  | 'evm'
  | 'solana'
  | 'did'
  | 'website'
  | 'email'
  | 'phone'
  | 'note'
  | 'social'
  | 'unknown'}`

/** Bitcoin mainnet, as CAIP-2 names it. Matches `@pnyx/config`'s own constant. */
const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const ETHEREUM_MAINNET = 'eip155:1'

/** One row a user can add. `chainId` is present exactly when `kind` is {@link CardKind.ChainAddress}. */
export type CardOption = {
  /** Stable key for the picker — a kind alone no longer identifies a row. */
  readonly id: string
  readonly labelKey: CardKindKey
  readonly kind: CardKind
  readonly chainId?: string
  /**
   * Which Midnight address form this row expects.
   *
   * ⚠️ Shielded and unshielded are two address forms of **one chain**, so the CAIP-2 id cannot tell
   * them apart — a shielded address in the unshielded row is well-formed and in the wrong place, and a
   * reader who paid it would send to something that cannot receive.
   */
  readonly expect?: 'night' | 'shielded'
}

/**
 * What this build offers when adding an entry, in the order shown.
 *
 * `network` names the Midnight and Cardano chain the identity is on, so a card records the chain its
 * address is actually for. The derive-only chains are offered at mainnet: there is no testnet story
 * for a contact card, and a wrong-network address is worse than no address.
 */
export const offeredOptions = (network: string): readonly CardOption[] => [
  {id: 'cardano', labelKey: 'you.card.kind.cardano', kind: CardKind.ChainAddress, chainId: `cardano:${network}`},
  {
    id: 'midnight-unshielded',
    labelKey: 'you.card.kind.midnightUnshielded',
    kind: CardKind.ChainAddress,
    chainId: `midnight:${network}`,
    expect: 'night',
  },
  {
    id: 'midnight-shielded',
    labelKey: 'you.card.kind.midnightShielded',
    kind: CardKind.ChainAddress,
    chainId: `midnight:${network}`,
    expect: 'shielded',
  },
  {id: 'bitcoin', labelKey: 'you.card.kind.bitcoin', kind: CardKind.ChainAddress, chainId: BITCOIN_MAINNET},
  {id: 'evm', labelKey: 'you.card.kind.evm', kind: CardKind.ChainAddress, chainId: ETHEREUM_MAINNET},
  {id: 'solana', labelKey: 'you.card.kind.solana', kind: CardKind.ChainAddress, chainId: SOLANA_MAINNET},
  {id: 'did', labelKey: 'you.card.kind.did', kind: CardKind.Did},
  {id: 'website', labelKey: 'you.card.kind.website', kind: CardKind.Website},
  {id: 'email', labelKey: 'you.card.kind.email', kind: CardKind.Email},
  {id: 'social', labelKey: 'you.card.kind.social', kind: CardKind.SocialHandle},
  {id: 'note', labelKey: 'you.card.kind.note', kind: CardKind.Note},
]

const BY_KIND: Readonly<Record<number, CardKindKey>> = {
  [CardKind.Did]: 'you.card.kind.did',
  [CardKind.Website]: 'you.card.kind.website',
  [CardKind.Email]: 'you.card.kind.email',
  [CardKind.Phone]: 'you.card.kind.phone',
  [CardKind.Note]: 'you.card.kind.note',
  [CardKind.SocialHandle]: 'you.card.kind.social',
}

/** The chain-address label for a CAIP-2 namespace. The reference is not read: `eip155:137` is EVM. */
const BY_NAMESPACE: Readonly<Record<string, CardKindKey>> = {
  cardano: 'you.card.kind.cardano',
  bip122: 'you.card.kind.bitcoin',
  eip155: 'you.card.kind.evm',
  solana: 'you.card.kind.solana',
}

/**
 * The key naming a stored entry. Never throws: a card read off chain decides the input.
 *
 * A chain address needs its value, not just its kind — the chain lives there now. An unparseable one,
 * or a namespace this build does not know, is `unknown` rather than a guess.
 */
export const cardEntryKey = (kind: number, value: string): CardKindKey => {
  if (kind !== CardKind.ChainAddress) return BY_KIND[kind] ?? 'you.card.kind.unknown'
  const decoded = decodeChainAddress(value)
  if (decoded === null) return 'you.card.kind.unknown'
  const namespace = decoded.chainId.slice(0, decoded.chainId.indexOf(':'))
  if (namespace !== 'midnight') return BY_NAMESPACE[namespace] ?? 'you.card.kind.unknown'
  // Midnight's two forms share a chain id, so the address itself is what tells them apart.
  return decoded.address.startsWith('mn_shield-addr')
    ? 'you.card.kind.midnightShielded'
    : 'you.card.kind.midnightUnshielded'
}

/**
 * The option a stored entry corresponds to, so the editor can show its chain and edit a bare address.
 *
 * Built from the entry rather than matched against {@link offeredOptions}: a card may hold a chain this
 * build does not offer — another client wrote it, or the offer list has moved — and dropping the row
 * would silently delete somebody's address on the next save.
 */
export const optionForEntry = (entry: CardEntry): CardOption => {
  const labelKey = cardEntryKey(entry.kind, entry.value)
  if (entry.kind !== CardKind.ChainAddress) return {id: `kind-${entry.kind}`, labelKey, kind: entry.kind}
  const decoded = decodeChainAddress(entry.value)
  if (decoded === null) return {id: `kind-${entry.kind}`, labelKey, kind: entry.kind}
  return {
    id: decoded.chainId,
    labelKey,
    kind: CardKind.ChainAddress,
    chainId: decoded.chainId,
    ...(labelKey === 'you.card.kind.midnightShielded'
      ? {expect: 'shielded' as const}
      : labelKey === 'you.card.kind.midnightUnshielded'
        ? {expect: 'night' as const}
        : {}),
  }
}

/** The bare value a user edits — the address alone for a chain row, the whole value otherwise. */
export const valueForEntry = (entry: CardEntry): string =>
  entry.kind === CardKind.ChainAddress ? (decodeChainAddress(entry.value)?.address ?? '') : entry.value

/**
 * The entry to store for an option and the value typed against it.
 *
 * An empty chain address encodes to the empty string rather than throwing: a half-filled row is an
 * ordinary editing state, and `normalizeCardEntries` drops it before anything reaches the chain.
 */
export const entryForOption = (option: CardOption, value: string): CardEntry =>
  option.chainId === undefined || value.trim().length === 0
    ? {kind: option.kind, value}
    : {kind: option.kind, value: encodeChainAddress(option.chainId, value.trim())}
