// The contact card's wire format — how `identity.compact`'s `card: Map<Uint<8>, CardRow>` carries
// addresses, DIDs, links and notes.
//
// The contract treats a row's bytes as opaque and enforces only that the identity's own holder wrote
// them (`contract/identity.compact`). Everything about *meaning* is therefore here, which is the same
// split the handle length floor settled: in-circuit byte inspection costs ~10,800 rows (a whole K
// step) and buys nothing, because a malformed row only produces a card the app declines to draw.
//
// No `@midnight-ntwrk/compact-runtime` import: this module runs on Hermes, and that package drags in
// the onchain-runtime WASM that Metro cannot bundle.

/** A row's on-chain value field, `Bytes<320>` in the contract. */
export const ROW_VALUE_BYTES = 320

/** Two of those bytes are the length prefix, so this is what one row can actually carry. */
export const ROW_PAYLOAD_BYTES = ROW_VALUE_BYTES - 2

/** `slot < 64` in the contract, so a full card is ~20 KB — this contract sits on the DM path. */
export const MAX_SLOTS = 64

/**
 * What a row holds. Six bits, so 1–63; **zero is reserved** because the contract reads kind zero as
 * "remove this slot", and a stored row must never encode to it.
 *
 * Values are frozen once a card exists on chain — a reader that does not know a kind must show the
 * row as unrecognised rather than guess, so numbers may be added but never reused.
 */
export const CardKind = {
  /**
   * An address on some chain, as `"<caip2> <address>"` — see {@link encodeChainAddress}.
   *
   * ⚠️ **One kind for every chain there will ever be.** The first six numbers used to be one per
   * chain (Midnight shielded, Midnight unshielded, Cardano, Bitcoin, EVM, Solana), which spends a
   * permanent, non-reusable number on each new chain and grows the reader a case at a time. The chain
   * belongs in the value, the way a DID's method does — `Did` and `SocialHandle` were already the
   * right shape and are unchanged.
   */
  ChainAddress: 1,
  Did: 2,
  Website: 3,
  Email: 4,
  Phone: 5,
  Note: 6,
  SocialHandle: 7,
  // 8 was `PnyxName`, a self-maintained list of the other names this identity holds. Removed
  // 2026-10-13: it indexed a set the product caps at one, which `identity(C).primaryName` already
  // carries, and it published that list to anyone who could read the card — a name portfolio in
  // public for a cross-device convenience the encrypted backup serves privately.
  // 9 was `CityAgent` (a Midnight City citizen id), removed 2026-10-12 with that feature.
  //
  // ⚠️ Neither number is reused. Both predate the mainnet move so no durable row carries one, but
  // with 63 available and `Extended` as an unbounded escape hatch, reuse buys nothing and costs a
  // reader that saw an old row. New kinds start at 10.
  /**
   * Reserved: the real type is declared in the value.
   *
   * Never written today, and holding the top number costs nothing. It exists so "what if 63 is not
   * enough in ten years" has an answer that needs no migration — the value is 320 bytes and already
   * self-describing, so one number buys an unbounded type space.
   */
  Extended: 63,
} as const

export type CardKind = (typeof CardKind)[keyof typeof CardKind]

const KIND_MASK = 0x3f
/** Set when the value continues in the next slot — a `did:midnight:offchain` long form needs three. */
const FLAG_CONTINUES = 0x80
/**
 * Set when the value bytes are a ciphertext rather than text.
 *
 * Nothing here encrypts: the flag exists so the shape does not have to be revisited later, since a
 * template change is a new contract address. A ciphertext row is the ordinary row with
 * XChaCha20-Poly1305's 24-byte nonce and 16-byte tag included, which is why 320 bytes was chosen —
 * a sealed `mn_shield-addr` still fits one row.
 *
 * ⚠️ It hides the value and nothing else. Row count, each row's length, its kind and every edit's
 * timestamp stay public, and a 175-byte ciphertext is legible as an address to anyone reading the
 * chain.
 */
const FLAG_ENCRYPTED = 0x40

/** One logical entry on a card. `value` may exceed one row; {@link encodeCard} spans slots. */
export type CardEntry = {
  readonly kind: CardKind
  readonly value: string
  /** True when {@link value} is base64 of a ciphertext rather than text. Nothing encrypts yet. */
  readonly encrypted?: boolean
}

/** A row as the contract stores it. `value` is always exactly {@link ROW_VALUE_BYTES} long. */
export type CardRowBytes = {
  readonly slot: number
  readonly kind: number
  readonly value: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Pack one payload chunk into a row's fixed-width value: a two-byte big-endian length, the bytes,
 * then zero padding.
 *
 * The length is explicit rather than inferred from trailing zeros, and that is load-bearing for
 * exactly one case: trailing zero bytes are legitimate inside a ciphertext, so trimming them would
 * silently corrupt an encrypted row while working fine for every text row. Paying two bytes on every
 * row is cheaper than a format that is correct only for some of them.
 */
const packValue = (chunk: Uint8Array): Uint8Array => {
  if (chunk.length > ROW_PAYLOAD_BYTES) {
    throw new Error(`card: chunk of ${chunk.length} exceeds ${ROW_PAYLOAD_BYTES} bytes`)
  }
  const out = new Uint8Array(ROW_VALUE_BYTES)
  out[0] = (chunk.length >> 8) & 0xff
  out[1] = chunk.length & 0xff
  out.set(chunk, 2)
  return out
}

/** The inverse. Returns `undefined` when the declared length cannot be true of this row. */
const unpackValue = (value: Uint8Array): Uint8Array | undefined => {
  if (value.length !== ROW_VALUE_BYTES) return undefined
  const declared = ((value[0] ?? 0) << 8) | (value[1] ?? 0)
  if (declared > ROW_PAYLOAD_BYTES) return undefined
  return value.slice(2, 2 + declared)
}

/**
 * Lay entries out across slots, chunking any value too long for one row.
 *
 * Slots are assigned densely from zero in entry order, so the card's on-chain layout is the order the
 * user sees. Rewriting a card therefore rewrites the slots it occupies — which is why
 * {@link cardWriteSet} exists, to say which slots a save must clear.
 */
/**
 * Put a form's entries in the shape the chain should hold.
 *
 * `trim().normalize('NFC')`, the same rule `canonicalizeHandle` uses, and entries left empty are
 * dropped rather than rejected. Both matter beyond tidiness:
 *
 * - **NFC decides the bytes.** The same text typed two ways encodes differently otherwise, so an entry
 *   nobody edited can look changed to {@link cardWritePlan} and cost a proof to rewrite identically.
 * - **An empty value cannot be stored at all.** Kind zero is the contract's remove sentinel, so "a row
 *   saying nothing" is not a state the card can express — {@link encodeCard} throws on one. Dropping it
 *   here is what lets a form hold a half-typed row without the save path having to care.
 *
 * ⚠️ Deliberately **not** applied to anything password-shaped; this is public contact data, where
 * trimming is what the user meant. See `CLAUDE.md`'s no-trim policy for where the opposite holds.
 */
export const normalizeCardEntries = (entries: readonly CardEntry[]): CardEntry[] =>
  entries
    .map((entry) => ({...entry, value: entry.value.trim().normalize('NFC')}))
    .filter((entry) => entry.value.length > 0)

export const encodeCard = (entries: readonly CardEntry[]): CardRowBytes[] => {
  const rows: CardRowBytes[] = []
  for (const entry of entries) {
    if (entry.kind < 1 || entry.kind > KIND_MASK) {
      throw new Error(`card: kind ${entry.kind} outside 1..${KIND_MASK}`)
    }
    const bytes = encoder.encode(entry.value)
    if (bytes.length === 0) {
      throw new Error(`card: kind ${entry.kind} has an empty value; omit the entry instead`)
    }
    const chunks: Uint8Array[] = []
    for (let at = 0; at < bytes.length; at += ROW_PAYLOAD_BYTES) {
      chunks.push(bytes.slice(at, at + ROW_PAYLOAD_BYTES))
    }
    chunks.forEach((chunk, i) => {
      const flags = (i < chunks.length - 1 ? FLAG_CONTINUES : 0) | (entry.encrypted === true ? FLAG_ENCRYPTED : 0)
      rows.push({slot: rows.length, kind: entry.kind | flags, value: packValue(chunk)})
    })
  }
  if (rows.length > MAX_SLOTS) {
    throw new Error(`card: ${rows.length} rows exceeds the ${MAX_SLOTS}-slot cap`)
  }
  return rows
}

/** A row the reader could not make sense of. Surfaced rather than dropped — see {@link decodeCard}. */
export type CardDefect = {
  readonly slot: number
  readonly reason: 'unknown-kind' | 'malformed-length' | 'dangling-continuation' | 'invalid-utf8'
  /** Detail from a thrown decode, so the caller's log says *why* and not merely "a row failed". */
  readonly detail?: string
}

export type DecodedCard = {
  readonly entries: readonly CardEntry[]
  /**
   * Rows that did not decode. **Never empty-by-omission**: a card that fails to parse and a card
   * with nothing on it are different facts, and a screen that renders the same nothing for both makes
   * the second undiagnosable. Callers log these.
   */
  readonly defects: readonly CardDefect[]
}

/**
 * Read a card back, reassembling chunked values.
 *
 * A chunk run is consecutive slots carrying the continuation flag, all of the same kind. A run that
 * ends without a terminating row is a defect and is dropped rather than shown truncated — a
 * half-rendered address is worse than an absent one, because it looks like a real destination.
 */
export const decodeCard = (rows: readonly CardRowBytes[]): DecodedCard => {
  const entries: CardEntry[] = []
  const defects: CardDefect[] = []
  const ordered = [...rows].sort((a, b) => a.slot - b.slot)

  let at = 0
  while (at < ordered.length) {
    const head = ordered[at]
    if (head === undefined) break
    const kind = head.kind & KIND_MASK
    const encrypted = (head.kind & FLAG_ENCRYPTED) !== 0
    if (kind === 0 || !Object.values(CardKind).includes(kind as CardKind)) {
      defects.push({slot: head.slot, reason: 'unknown-kind'})
      at += 1
      continue
    }

    const chunks: Uint8Array[] = []
    let cursor = at
    let complete = false
    let malformed = false
    while (cursor < ordered.length) {
      const row = ordered[cursor]
      if (row === undefined) break
      // A run must be contiguous slots of one kind; anything else means the run was truncated and
      // the next row belongs to a different entry.
      if (cursor > at && (row.slot !== (ordered[cursor - 1]?.slot ?? -2) + 1 || (row.kind & KIND_MASK) !== kind)) {
        break
      }
      const payload = unpackValue(row.value)
      if (payload === undefined) {
        defects.push({slot: row.slot, reason: 'malformed-length'})
        malformed = true
        cursor += 1
        break
      }
      chunks.push(payload)
      cursor += 1
      if ((row.kind & FLAG_CONTINUES) === 0) {
        complete = true
        break
      }
    }

    if (malformed) {
      at = cursor
      continue
    }
    if (!complete) {
      defects.push({slot: head.slot, reason: 'dangling-continuation'})
      at = cursor
      continue
    }

    const total = chunks.reduce((n, c) => n + c.length, 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    let value: string
    try {
      value = decoder.decode(joined, {stream: false})
      // A lone replacement char means the bytes were not the text they claimed to be. Encrypted rows
      // are exempt: their payload is base64 produced by the writer, not arbitrary bytes.
      if (!encrypted && value.includes('�')) {
        defects.push({slot: head.slot, reason: 'invalid-utf8'})
        at = cursor
        continue
      }
    } catch (error) {
      // Not swallowed: the detail travels with the defect and the caller logs it. A card that failed
      // to parse and a card with nothing on it are different facts.
      defects.push({slot: head.slot, reason: 'invalid-utf8', detail: String(error)})
      at = cursor
      continue
    }
    entries.push(encrypted ? {kind: kind as CardKind, value, encrypted: true} : {kind: kind as CardKind, value})
    at = cursor
  }

  return {entries, defects}
}

/**
 * The slots a save must write, including the ones it must clear.
 *
 * A card that shrinks leaves rows behind otherwise: dropping an entry moves every later row down a
 * slot, so the tail of the previous layout would survive as orphaned rows. Kind zero is the
 * contract's remove sentinel, so a cleared slot is expressed as a row of kind zero.
 */
export const cardWriteSet = (next: readonly CardEntry[], occupiedSlots: number): CardRowBytes[] => {
  const rows = encodeCard(next)
  const clears: CardRowBytes[] = []
  for (let slot = rows.length; slot < occupiedSlots; slot++) {
    clears.push({slot, kind: 0, value: new Uint8Array(ROW_VALUE_BYTES)})
  }
  return [...rows, ...clears]
}

/** The contract's `setRows` width. Fixed in the template, so a partial batch has to be padded. */
export const BATCH_WIDTH = 4

/**
 * Group a write set into `setRows` calls, each **exactly** {@link BATCH_WIDTH} wide.
 *
 * The padding is the subtle part and it belongs here rather than in each caller. A short final batch
 * has to name four slots, and the obvious filler — repeat a slot this batch already wrote — *erases
 * the row it just wrote*, because kind zero is the contract's remove sentinel. So padding targets
 * the highest slots the write set does not touch, where a clear is a guaranteed no-op.
 *
 * There is always enough room: padding needed is `(4 - n % 4) % 4` and free slots is `64 - n`, and
 * since 64 is a multiple of 4 the second is always at least the first.
 */
export const cardBatches = (writeSet: readonly CardRowBytes[]): CardRowBytes[][] => {
  const used = new Set(writeSet.map((r) => r.slot))
  const spare: number[] = []
  for (let slot = MAX_SLOTS - 1; slot >= 0; slot--) {
    if (!used.has(slot)) spare.push(slot)
  }
  const batches: CardRowBytes[][] = []
  for (let at = 0; at < writeSet.length; at += BATCH_WIDTH) {
    const batch = [...writeSet.slice(at, at + BATCH_WIDTH)]
    while (batch.length < BATCH_WIDTH) {
      const slot = spare.shift()
      if (slot === undefined) {
        throw new Error('card: no spare slot to pad a partial batch with')
      }
      batch.push({slot, kind: 0, value: new Uint8Array(ROW_VALUE_BYTES)})
    }
    batches.push(batch)
  }
  return batches
}

/** One transaction's worth of card writes: a single slot, or a full four-wide batch. */
export type CardWrite =
  | {readonly op: 'row'; readonly row: CardRowBytes}
  | {readonly op: 'rows'; readonly rows: readonly CardRowBytes[]}

const sameRow = (a: CardRowBytes | undefined, b: CardRowBytes): boolean => {
  if (a === undefined || a.kind !== b.kind || a.value.length !== b.value.length) return false
  for (let i = 0; i < a.value.length; i++) if (a.value[i] !== b.value[i]) return false
  return true
}

/**
 * The **smallest** set of transactions that turns `current` into `next`.
 *
 * Writing the whole card was correct and wasteful: every save cost a proof per four rows even when one
 * character changed. This compares the encoded target against what is on chain and writes only the
 * slots that differ, plus the clears a shrunken card needs.
 *
 * One changed slot uses `setRow` — **K13/6,999 against `setRows`' K14/12,818**, so half the proving for
 * the common edit. Two or more batch, because each transaction costs its own sponsored round trip and
 * one four-wide proof beats three single ones on wall clock even though each is cheaper.
 *
 * ⚠️ **Padding repeats one of the batch's own writes, it does not clear a spare slot.** That is the trap
 * `cardBatches` sits next to: it pads with slots the *write set* does not touch, which is safe only when
 * the write set is the whole card. For a diff, an untouched slot is very often an **occupied** one, and
 * padding it with kind zero would delete a row the user never edited. Repeating a write is idempotent —
 * the contract removes then inserts per slot — so it is always available and never destructive, which
 * also removes the "no spare slot" failure a full card could otherwise hit.
 *
 * `current` is what the chain holds, in the shape {@link decodeCard} takes. Pass `next` through
 * {@link normalizeCardEntries} first, or an unedited entry may look changed.
 */
export const cardWritePlan = (current: readonly CardRowBytes[], next: readonly CardEntry[]): CardWrite[] => {
  const target = encodeCard(next)
  const held = new Map(current.map((row) => [row.slot, row]))

  const writes: CardRowBytes[] = target.filter((row) => !sameRow(held.get(row.slot), row))
  // Slots the card no longer uses. Kind zero is the contract's remove sentinel.
  for (const row of current) {
    if (row.slot >= target.length) writes.push({slot: row.slot, kind: 0, value: new Uint8Array(ROW_VALUE_BYTES)})
  }
  writes.sort((a, b) => a.slot - b.slot)

  if (writes.length === 0) return []
  const single = writes[0]
  if (writes.length === 1 && single !== undefined) return [{op: 'row', row: single}]

  const plan: CardWrite[] = []
  for (let at = 0; at < writes.length; at += BATCH_WIDTH) {
    const batch = [...writes.slice(at, at + BATCH_WIDTH)]
    // A real write in preference to a clear, only so the padded batch reads as what it is. Either is
    // idempotent — the contract removes then inserts per slot — so correctness does not depend on it.
    const filler = batch.find((row) => row.kind !== 0) ?? batch[0]
    if (filler === undefined) break
    while (batch.length < BATCH_WIDTH) batch.push(filler)
    plan.push({op: 'rows', rows: batch})
  }
  return plan
}

/**
 * How many transactions a save will cost — one per {@link cardWritePlan} entry, and each is one
 * on-device proof.
 *
 * Takes what the chain holds rather than a slot count, because the answer depends on *which* rows
 * changed: editing one entry of four is one transaction, and adding a fifth is one more.
 */
export const cardSaveCost = (current: readonly CardRowBytes[], next: readonly CardEntry[]): number =>
  cardWritePlan(current, next).length

/**
 * Pack a chain address into a {@link CardKind.ChainAddress} value.
 *
 * `"<caip2> <address>"`, split on the **first** space. CAIP-2's grammar is
 * `[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}`, which cannot contain a space — so the first space is an
 * unambiguous delimiter no matter what the address contains, rather than a separator that happens to
 * be absent from the address formats we support today.
 */
export const encodeChainAddress = (chainId: string, address: string): string => {
  if (chainId.length === 0 || chainId.includes(' ')) {
    throw new Error(`card: a CAIP-2 chain id cannot be empty or contain a space, got "${chainId}"`)
  }
  if (address.length === 0) throw new Error('card: a chain address cannot be empty')
  return `${chainId} ${address}`
}

/** The inverse. `null` for a value with no delimiter, or an empty half — never a partial answer. */
export const decodeChainAddress = (value: string): {readonly chainId: string; readonly address: string} | null => {
  const at = value.indexOf(' ')
  if (at <= 0 || at === value.length - 1) return null
  return {chainId: value.slice(0, at), address: value.slice(at + 1)}
}
