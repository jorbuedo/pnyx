import {describe, expect, it} from 'vitest'
import {
  BATCH_WIDTH,
  type CardEntry,
  CardKind,
  type CardRowBytes,
  cardBatches,
  cardSaveCost,
  cardWritePlan,
  cardWriteSet,
  decodeCard,
  decodeChainAddress,
  encodeCard,
  encodeChainAddress,
  MAX_SLOTS,
  normalizeCardEntries,
  ROW_PAYLOAD_BYTES,
  ROW_VALUE_BYTES,
} from './card.js'

/** A real preprod shielded address — 132 bytes, the longest single-row value the card must carry. */
const MIDNIGHT_ADDR =
  'mn_shield-addr_preprod1j79fwduuxrpphd7v3flqufr6slsquc3laz5xcv0vn2ft23p4k6vnvh3vy3ckjx9leyts2yc3mak23suejz47je5dh9n5c9zfsagrm0gtahmdd'

/** A real Cardano base address — 103 bytes. */
const CARDANO_ADDR =
  'addr1q8g3dv6ptkgsafh7k5muggrvfde2szzmc2m8w4dt6zqnfa2rnfxqm3xzu9nsw0y5xrcvpmvj0hnzrqqz7hkxrqx6kkzs4pnxvz'

/** A ledger-backed Midnight DID — 88 bytes. */
const DID_SHORT = 'did:midnight:undeployed:c569622e7f33d2d020ba1cae242e6077268941327846d62d8cbf0cc923ae41f6'

/** The offchain long form at its schema maximum — 951 bytes, so it spans three rows. */
const DID_LONG = `did:midnight:offchain:${'a'.repeat(64)}:${'Q'.repeat(864)}`

const roundTrip = (entries: readonly CardEntry[]) => decodeCard(encodeCard(entries))

describe('encodeCard / decodeCard', () => {
  it('round-trips every row type a card is built for', () => {
    const entries: CardEntry[] = [
      {kind: CardKind.ChainAddress, value: encodeChainAddress('midnight:preprod', MIDNIGHT_ADDR)},
      {kind: CardKind.ChainAddress, value: encodeChainAddress('cardano:preprod', CARDANO_ADDR)},
      {kind: CardKind.Did, value: DID_SHORT},
      {kind: CardKind.Website, value: 'https://pnyx.app/jordi'},
      {kind: CardKind.Email, value: 'jordi@example.com'},
      {kind: CardKind.Note, value: 'Governance, privacy, Midnight.'},
    ]
    const {entries: back, defects} = roundTrip(entries)
    expect(defects).toEqual([])
    expect(back).toEqual(entries)
  })

  it('fits each of those in a single row', () => {
    for (const value of [MIDNIGHT_ADDR, CARDANO_ADDR, DID_SHORT]) {
      expect(encodeCard([{kind: CardKind.Did, value}])).toHaveLength(1)
    }
  })

  it('spans slots for an offchain long-form DID, and rejoins it exactly', () => {
    expect(DID_LONG.length).toBe(951)
    const rows = encodeCard([{kind: CardKind.Did, value: DID_LONG}])
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.slot)).toEqual([0, 1, 2])
    const {entries, defects} = decodeCard(rows)
    expect(defects).toEqual([])
    expect(entries).toEqual([{kind: CardKind.Did, value: DID_LONG}])
  })

  it('never emits kind zero, which the contract reads as "remove this slot"', () => {
    const rows = encodeCard([
      {kind: CardKind.Did, value: DID_LONG},
      {kind: CardKind.Website, value: 'https://pnyx.app'},
    ])
    for (const row of rows) expect(row.kind).not.toBe(0)
  })

  it('pads every value to the contract width', () => {
    for (const row of encodeCard([{kind: CardKind.Email, value: 'a@b.co'}])) {
      expect(row.value).toHaveLength(ROW_VALUE_BYTES)
    }
  })

  it('carries a value that exactly fills one row without spilling', () => {
    const value = 'x'.repeat(ROW_PAYLOAD_BYTES)
    const rows = encodeCard([{kind: CardKind.Note, value}])
    expect(rows).toHaveLength(1)
    expect(decodeCard(rows).entries[0]?.value).toBe(value)
  })

  it('spills at exactly one byte over', () => {
    const rows = encodeCard([{kind: CardKind.Note, value: 'x'.repeat(ROW_PAYLOAD_BYTES + 1)}])
    expect(rows).toHaveLength(2)
    expect(decodeCard(rows).entries[0]?.value).toHaveLength(ROW_PAYLOAD_BYTES + 1)
  })

  it('preserves multi-byte characters split across a chunk boundary', () => {
    // 4-byte emoji straddling the boundary: a byte-level split must still rejoin to the same string.
    const value = `${'a'.repeat(ROW_PAYLOAD_BYTES - 2)}😀tail`
    const rows = encodeCard([{kind: CardKind.Note, value}])
    expect(rows.length).toBeGreaterThan(1)
    const {entries, defects} = decodeCard(rows)
    expect(defects).toEqual([])
    expect(entries[0]?.value).toBe(value)
  })

  it('keeps trailing zero bytes in an encrypted payload, which trailing-zero trimming would eat', () => {
    // The reason the format carries an explicit length: base64 of a ciphertext can legitimately end
    // in characters a trim-to-first-zero reader would keep, but the *bytes* can also be zero once
    // decoded. Length-prefixing is what makes both survive.
    const value = `${'AAAA'.repeat(20)}A===`
    const {entries, defects} = roundTrip([{kind: CardKind.Note, value, encrypted: true}])
    expect(defects).toEqual([])
    expect(entries).toEqual([{kind: CardKind.Note, value, encrypted: true}])
  })

  it('keeps the encrypted flag distinct from the kind', () => {
    const plain = encodeCard([{kind: CardKind.ChainAddress, value: CARDANO_ADDR}])[0]
    const sealed = encodeCard([{kind: CardKind.ChainAddress, value: CARDANO_ADDR, encrypted: true}])[0]
    expect(plain?.kind).not.toBe(sealed?.kind)
    expect(decodeCard([sealed as CardRowBytes]).entries[0]?.encrypted).toBe(true)
    expect(decodeCard([plain as CardRowBytes]).entries[0]?.encrypted).toBeUndefined()
  })

  it('refuses an empty value rather than storing a row that means nothing', () => {
    expect(() => encodeCard([{kind: CardKind.Website, value: ''}])).toThrow(/empty value/)
  })

  it('refuses a kind outside the six bits the format has', () => {
    expect(() => encodeCard([{kind: 0 as CardKind, value: 'x'}])).toThrow(/outside/)
    expect(() => encodeCard([{kind: 64 as CardKind, value: 'x'}])).toThrow(/outside/)
  })

  it('refuses a card past the slot cap instead of silently truncating it', () => {
    const entries = Array.from({length: MAX_SLOTS + 1}, () => ({kind: CardKind.Note, value: 'x'}))
    expect(() => encodeCard(entries)).toThrow(/slot cap/)
  })
})

describe('decodeCard defects', () => {
  const row = (slot: number, kind: number, payload: string): CardRowBytes => {
    const bytes = new TextEncoder().encode(payload)
    const value = new Uint8Array(ROW_VALUE_BYTES)
    value[0] = (bytes.length >> 8) & 0xff
    value[1] = bytes.length & 0xff
    value.set(bytes, 2)
    return {slot, kind, value}
  }

  it('reports an unknown kind rather than guessing what it meant', () => {
    const {entries, defects} = decodeCard([row(0, 62, 'from a newer client')])
    expect(entries).toEqual([])
    expect(defects).toEqual([{slot: 0, reason: 'unknown-kind'}])
  })

  it('drops a truncated chunk run instead of showing half an address', () => {
    // Continuation set on the last row present: the tail never arrived.
    const {entries, defects} = decodeCard([row(0, CardKind.ChainAddress | 0x80, 'addr1q8g3dv6')])
    expect(entries).toEqual([])
    expect(defects).toEqual([{slot: 0, reason: 'dangling-continuation'}])
  })

  it('reports a length that cannot be true of the row', () => {
    const bad = new Uint8Array(ROW_VALUE_BYTES)
    bad[0] = 0xff
    bad[1] = 0xff
    const {entries, defects} = decodeCard([{slot: 0, kind: CardKind.Note, value: bad}])
    expect(entries).toEqual([])
    expect(defects).toEqual([{slot: 0, reason: 'malformed-length'}])
  })

  it('reports a wrong-width value rather than reading past it', () => {
    const {entries, defects} = decodeCard([{slot: 0, kind: CardKind.Note, value: new Uint8Array(16)}])
    expect(entries).toEqual([])
    expect(defects).toEqual([{slot: 0, reason: 'malformed-length'}])
  })

  it('keeps good rows when a neighbour is broken', () => {
    const {entries, defects} = decodeCard([
      row(0, CardKind.Website, 'https://pnyx.app'),
      row(1, 62, 'unknown'),
      row(2, CardKind.Email, 'a@b.co'),
    ])
    expect(entries).toEqual([
      {kind: CardKind.Website, value: 'https://pnyx.app'},
      {kind: CardKind.Email, value: 'a@b.co'},
    ])
    expect(defects).toEqual([{slot: 1, reason: 'unknown-kind'}])
  })

  it('does not join a run across a slot gap, which would splice two entries together', () => {
    // Slot 0 continues, but slot 1 is missing — slot 2 is a different entry and must not be appended.
    const {entries, defects} = decodeCard([
      row(0, CardKind.Did | 0x80, 'did:midnight:offchain:aaa'),
      row(2, CardKind.Did, 'zzz'),
    ])
    expect(defects).toEqual([{slot: 0, reason: 'dangling-continuation'}])
    expect(entries).toEqual([{kind: CardKind.Did, value: 'zzz'}])
  })

  it('does not join a run across a change of kind', () => {
    const {entries, defects} = decodeCard([
      row(0, CardKind.Did | 0x80, 'did:midnight:offchain:aaa'),
      row(1, CardKind.Website, 'https://pnyx.app'),
    ])
    expect(defects).toEqual([{slot: 0, reason: 'dangling-continuation'}])
    expect(entries).toEqual([{kind: CardKind.Website, value: 'https://pnyx.app'}])
  })

  it('reads rows back in slot order however they arrived', () => {
    const {entries} = decodeCard([row(2, CardKind.Email, 'c@x.co'), row(0, CardKind.Website, 'https://a')])
    expect(entries.map((e) => e.value)).toEqual(['https://a', 'c@x.co'])
  })
})

describe('cardWriteSet', () => {
  it('clears the slots a shrinking card leaves behind', () => {
    const next: CardEntry[] = [{kind: CardKind.Website, value: 'https://pnyx.app'}]
    const writeSet = cardWriteSet(next, 3)
    expect(writeSet).toHaveLength(3)
    expect(writeSet[0]?.kind).toBe(CardKind.Website)
    expect(writeSet.slice(1).map((r) => r.kind)).toEqual([0, 0])
    expect(writeSet.map((r) => r.slot)).toEqual([0, 1, 2])
  })

  it('clears nothing when the card grew', () => {
    const next: CardEntry[] = [
      {kind: CardKind.Website, value: 'https://a'},
      {kind: CardKind.Email, value: 'a@b.co'},
    ]
    expect(cardWriteSet(next, 1).every((r) => r.kind !== 0)).toBe(true)
  })

  it('accounts for the extra slots a chunked value occupies when clearing', () => {
    // Replacing a 3-row DID with a 1-row website must clear two slots, not zero.
    const before = encodeCard([{kind: CardKind.Did, value: DID_LONG}])
    expect(before).toHaveLength(3)
    const writeSet = cardWriteSet([{kind: CardKind.Website, value: 'https://pnyx.app'}], before.length)
    expect(writeSet.filter((r) => r.kind === 0)).toHaveLength(2)
  })
})

describe('cardBatches', () => {
  const sixRows = () =>
    cardWriteSet(
      Array.from({length: 6}, (_, i) => ({kind: CardKind.Note, value: `n${i}`})),
      6,
    )

  it('emits batches of exactly the contract width, since the circuit takes four slots either way', () => {
    expect(cardBatches(sixRows()).map((b) => b.length)).toEqual([BATCH_WIDTH, BATCH_WIDTH])
  })

  it('never pads a batch with a slot that batch is writing — the padding erases the row otherwise', () => {
    // The bug this guards: kind zero is the contract's remove sentinel, so filling a short batch by
    // repeating one of its own slots deletes the row it just wrote. Every card save of 1–3 rows hit it.
    for (const batch of cardBatches(sixRows())) {
      const written = batch.filter((r) => r.kind !== 0).map((r) => r.slot)
      const cleared = batch.filter((r) => r.kind === 0).map((r) => r.slot)
      expect(cleared.filter((slot) => written.includes(slot))).toEqual([])
    }
  })

  it('never pads with a slot any other batch touches either', () => {
    const writeSet = sixRows()
    const touched = new Set(writeSet.map((r) => r.slot))
    const pads = cardBatches(writeSet)
      .flat()
      .filter((r) => !writeSet.some((w) => w.slot === r.slot && w.kind === r.kind))
    expect(pads.length).toBeGreaterThan(0)
    for (const pad of pads) expect(touched.has(pad.slot)).toBe(false)
  })

  it('pads a single-row save without touching slot zero', () => {
    const batches = cardBatches(cardWriteSet([{kind: CardKind.Website, value: 'https://pnyx.app'}], 0))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(BATCH_WIDTH)
    expect(batches[0]?.filter((r) => r.slot === 0).map((r) => r.kind)).toEqual([CardKind.Website])
  })

  it('has room to pad a card that fills every slot but one', () => {
    // Padding needed is (4 - n%4)%4 and free slots is 64 - n; 64 is a multiple of 4, so the second is
    // always at least the first. The boundary is worth pinning rather than trusting the arithmetic.
    for (const n of [61, 62, 63, MAX_SLOTS]) {
      const entries = Array.from({length: n}, (_, i) => ({kind: CardKind.Note, value: `n${i}`}))
      const batches = cardBatches(cardWriteSet(entries, 0))
      expect(batches.every((b) => b.length === BATCH_WIDTH)).toBe(true)
    }
  })

  it('is empty for an empty write set', () => {
    expect(cardBatches([])).toEqual([])
  })

  it('turns a six-row save into two proofs rather than six', () => {
    expect(cardBatches(sixRows())).toHaveLength(2)
  })
})

describe('normalizeCardEntries', () => {
  it('trims and NFC-normalizes, so the same text always encodes the same bytes', () => {
    // "é" as e + combining acute, which NFC folds to the single code point.
    const decomposed = 'caf\u0065\u0301'
    const [entry] = normalizeCardEntries([{kind: CardKind.Note, value: `  ${decomposed}  `}])
    expect(entry?.value).toBe('caf\u00e9')
  })

  // ⚠️ Kind zero is the contract's remove sentinel, so "a row saying nothing" is not a state the card
  // can express — `encodeCard` throws on one. Dropping it here is what lets a form hold a half-typed row.
  it('drops an entry left empty rather than rejecting it', () => {
    expect(normalizeCardEntries([{kind: CardKind.Note, value: '   '}])).toEqual([])
    expect(() => encodeCard([{kind: CardKind.Note, value: ''}])).toThrow(/empty value/)
  })

  it('keeps the kind and the encrypted flag untouched', () => {
    const [entry] = normalizeCardEntries([{kind: CardKind.Did, value: ' x ', encrypted: true}])
    expect(entry).toEqual({kind: CardKind.Did, value: 'x', encrypted: true})
  })
})

describe('cardWritePlan', () => {
  const note = (value: string): CardEntry => ({kind: CardKind.Note, value})

  it('writes nothing when nothing changed', () => {
    const entries = [note('a'), note('b')]
    expect(cardWritePlan(encodeCard(entries), entries)).toEqual([])
  })

  // The point of the diff: one edited entry costs one `setRow`, not a batch over the whole card.
  it('uses a single setRow for one changed slot', () => {
    const before = encodeCard([note('a'), note('b'), note('c')])
    const plan = cardWritePlan(before, [note('a'), note('CHANGED'), note('c')])
    expect(plan).toHaveLength(1)
    expect(plan[0]?.op).toBe('row')
    expect(plan[0]?.op === 'row' ? plan[0].row.slot : -1).toBe(1)
  })

  it('batches two or more changes', () => {
    const before = encodeCard([note('a'), note('b'), note('c')])
    const plan = cardWritePlan(before, [note('X'), note('Y'), note('c')])
    expect(plan).toHaveLength(1)
    expect(plan[0]?.op).toBe('rows')
    expect(plan[0]?.op === 'rows' ? plan[0].rows.length : 0).toBe(BATCH_WIDTH)
  })

  /**
   * ⚠️ The trap this function exists to avoid. `cardBatches` pads with slots the *write set* does not
   * touch, which for a diff is very often an **occupied** slot — padding it with kind zero would delete
   * a row nobody edited. Repeating one of the batch's own writes is idempotent instead.
   */
  it('pads a partial batch by repeating its own writes, never by clearing another slot', () => {
    const before = encodeCard([note('a'), note('b'), note('c'), note('d'), note('e')])
    const plan = cardWritePlan(before, [note('X'), note('Y'), note('c'), note('d'), note('e')])
    const rows = plan[0]?.op === 'rows' ? plan[0].rows : []
    expect(rows).toHaveLength(BATCH_WIDTH)
    // Nothing in the batch clears, and no slot outside the two edits is named — slots 2..4 hold rows
    // nobody edited, and a clear aimed at one of them would delete it.
    expect(rows.every((r) => r.kind !== 0)).toBe(true)
    expect(new Set(rows.map((r) => r.slot))).toEqual(new Set([0, 1]))
  })

  it('clears the tail a shrinking card leaves behind', () => {
    const before = encodeCard([note('a'), note('b'), note('c')])
    const plan = cardWritePlan(before, [note('a')])
    // Distinct slots: a partial batch is padded by repeating one of its own writes, so a slot can
    // legitimately appear twice in one transaction.
    const cleared = plan.flatMap((w) => (w.op === 'rows' ? [...w.rows] : [w.row])).filter((r) => r.kind === 0)
    expect([...new Set(cleared.map((r) => r.slot))].sort()).toEqual([1, 2])
  })

  it('writes only the new slots when an entry is appended', () => {
    const before = encodeCard([note('a'), note('b')])
    const plan = cardWritePlan(before, [note('a'), note('b'), note('c')])
    expect(plan).toEqual([{op: 'row', row: encodeCard([note('a'), note('b'), note('c')])[2]}])
  })

  // ── Multi-row entries ──
  //
  // A value longer than one row spans consecutive slots with the continuation flag, so the plan has to
  // reason in *rows* and not in entries.

  it('writes every slot a long value spans', () => {
    const long = note('x'.repeat(ROW_PAYLOAD_BYTES + 10))
    const plan = cardWritePlan([], [long])
    const rows = plan.flatMap((w) => (w.op === 'rows' ? [...w.rows] : [w.row]))
    expect([...new Set(rows.map((r) => r.slot))].sort()).toEqual([0, 1])
    // ⚠️ Decode the *encoding*, not the padded batch. Padding repeats a write, so a transaction's rows
    // are not the chain's rows — feeding them to `decodeCard` breaks the continuation chain and would be
    // asserting against a state that never exists.
    expect(decodeCard(encodeCard([long])).entries).toEqual([long])
  })

  it('rewrites only the slot that changed inside a long value', () => {
    const head = 'x'.repeat(ROW_PAYLOAD_BYTES)
    const before = encodeCard([note(`${head}tail`)])
    const plan = cardWritePlan(before, [note(`${head}TAIL`)])
    expect(plan).toHaveLength(1)
    // Slot 0 holds the unchanged first chunk; only the continuation row moved.
    expect(plan[0]?.op === 'row' ? plan[0].row.slot : -1).toBe(1)
  })

  it('clears the extra slot when a long value shrinks to one row', () => {
    const before = encodeCard([note('x'.repeat(ROW_PAYLOAD_BYTES + 10))])
    const plan = cardWritePlan(before, [note('short')])
    const rows = plan.flatMap((w) => (w.op === 'rows' ? [...w.rows] : [w.row]))
    expect(rows.filter((r) => r.kind === 0).map((r) => r.slot)).toEqual([1])
  })
})

describe('cardSaveCost', () => {
  const note = (value: string): CardEntry => ({kind: CardKind.Note, value})

  it('is nothing to do when nothing changed', () => {
    const entries = [note('a'), note('b')]
    expect(cardSaveCost(encodeCard(entries), entries)).toBe(0)
  })

  it('is one for a single edit, whatever the card holds', () => {
    const before = encodeCard([note('a'), note('b'), note('c'), note('d'), note('e')])
    expect(cardSaveCost(before, [note('a'), note('b'), note('C'), note('d'), note('e')])).toBe(1)
  })

  it('counts one per batch when more changed', () => {
    expect(cardSaveCost([], [note('a'), note('b'), note('c'), note('d'), note('e')])).toBe(2)
  })

  // A long value costs by rows, not by entries.
  it('follows rows when a value spans slots', () => {
    const long = note('x'.repeat(ROW_PAYLOAD_BYTES + 1))
    expect(cardSaveCost([], [long])).toBe(1)
    expect(cardSaveCost([], [long, long, long])).toBe(2)
  })
})

describe('chain address values', () => {
  const ADDR = 'addr1q8g3dv6ptkgsdfhkjshdfkjhsdf'

  it('round-trips a chain id and an address', () => {
    const value = encodeChainAddress('cardano:preprod', ADDR)
    expect(decodeChainAddress(value)).toEqual({chainId: 'cardano:preprod', address: ADDR})
  })

  // CAIP-2's grammar cannot contain a space, so the *first* space delimits — an address may contain
  // as many as it likes without becoming ambiguous.
  it('splits on the first space, so the address may contain more', () => {
    expect(decodeChainAddress(encodeChainAddress('eip155:1', 'a b c'))).toEqual({
      chainId: 'eip155:1',
      address: 'a b c',
    })
  })

  it('refuses a chain id that would make the delimiter ambiguous', () => {
    expect(() => encodeChainAddress('cardano preprod', ADDR)).toThrow(/space/)
    expect(() => encodeChainAddress('', ADDR)).toThrow(/empty/)
    expect(() => encodeChainAddress('cardano:preprod', '')).toThrow(/empty/)
  })

  // `null` rather than a half-parsed answer: a row this client cannot read must not render as an
  // address with an empty chain, or as a chain with an empty address.
  it('returns null rather than half an answer', () => {
    expect(decodeChainAddress('nodelimiter')).toBeNull()
    expect(decodeChainAddress(' leadingspace')).toBeNull()
    expect(decodeChainAddress('trailing ')).toBeNull()
    expect(decodeChainAddress('')).toBeNull()
  })
})
