import {describe, expect, it} from 'vitest'
import {INPUT_RECORD_LEN, type UnshieldedSpend} from './unshielded-wire'
import {
  COIN_WIRE_LEN,
  coinToWire,
  collapseRangeHex,
  type DustGenerationEntry,
  deficitsOf,
  fromHex,
  GENERATION_OFFSETS,
  GENERATION_RECORD_LEN,
  generationToWire,
  parseDecryptedCoin,
  parseDustBalance,
  parseDustRegistration,
  parseDustUtxos,
  parseIdentifiers,
  parseNightSignature,
  parseTxBalance,
  parseWalletSummary,
  registerArg,
  type TxBalanceEntry,
  toHex,
  u64ToLeHex,
} from './wallet-wire'

const nonce = new Uint8Array(32).fill(7)
const color = new Uint8Array(32).fill(0xaa)

describe('coinToWire', () => {
  it('lays a coin out as nonce, colour, then a little-endian 128-bit value', () => {
    const wire = fromHex(coinToWire({nonce, color, value: 1n}))
    expect(wire.length).toBe(COIN_WIRE_LEN)
    expect(toHex(wire.subarray(0, 32))).toBe(toHex(nonce))
    expect(toHex(wire.subarray(32, 64))).toBe(toHex(color))
    // Little-endian: the 1 lands in the first value byte, not the last.
    expect(wire[64]).toBe(1)
    expect(wire[79]).toBe(0)
  })

  it('carries the largest possible coin value without loss', () => {
    const value = 2n ** 128n - 1n
    const wire = fromHex(coinToWire({nonce, color, value}))
    expect(Array.from(wire.subarray(64))).toEqual(new Array(16).fill(255))
  })

  it('rejects a value past 128 bits rather than truncating it', () => {
    expect(() => coinToWire({nonce, color, value: 2n ** 128n})).toThrow(/exceeds 128 bits/)
  })

  it('rejects a negative value', () => {
    expect(() => coinToWire({nonce, color, value: -1n})).toThrow(/cannot be negative/)
  })

  it.each([
    ['nonce', {nonce: new Uint8Array(31), color, value: 1n}, /nonce must be 32 bytes/],
    ['colour', {nonce, color: new Uint8Array(33), value: 1n}, /color must be 32 bytes/],
  ])('rejects a wrong-length %s instead of padding it into a different coin', (_what, coin, message) => {
    expect(() => coinToWire(coin)).toThrow(message)
  })
})

describe('parseWalletSummary', () => {
  it('reads balances and coins as bigints, keeping full 128-bit precision', () => {
    // Past 2^53, so a JSON number would have rounded it. This is the case the string encoding exists
    // for: the summary is what a balance is rendered from.
    const big = '340282366920938463463374607431768211454'
    const summary = parseWalletSummary(
      `{"firstFree":3,"pending":0,"balances":[{"color":"${toHex(color)}","value":"${big}"}],` +
        `"coins":[{"nonce":"${toHex(nonce)}","color":"${toHex(color)}","value":"${big}","mtIndex":2}]}`,
    )
    expect(summary.firstFree).toBe(3)
    expect(summary.balances[0]?.value).toBe(BigInt(big))
    expect(summary.coins[0]?.value).toBe(BigInt(big))
    expect(summary.coins[0]?.mtIndex).toBe(2)
    expect(toHex(summary.coins[0]?.color ?? new Uint8Array())).toBe(toHex(color))
  })

  it('reads an empty wallet as empty rather than failing', () => {
    const summary = parseWalletSummary('{"firstFree":0,"pending":0,"balances":[],"coins":[]}')
    expect(summary).toEqual({firstFree: 0, pending: 0, balances: [], coins: []})
  })

  it('carries the pending-spend count, which is not part of any balance', () => {
    // A coin spent by an unconfirmed transfer: excluded from coins and balances, counted here. Showing
    // it as a balance would offer money that cannot be sent.
    const summary = parseWalletSummary('{"firstFree":5,"pending":2,"balances":[],"coins":[]}')
    expect(summary.pending).toBe(2)
    expect(summary.balances).toEqual([])
  })
})

describe('parseDecryptedCoin', () => {
  it('reads a coin that is ours', () => {
    const coin = parseDecryptedCoin(`{"nonce":"${toHex(nonce)}","color":"${toHex(color)}","value":"12"}`)
    expect(coin?.value).toBe(12n)
    expect(toHex(coin?.nonce ?? new Uint8Array())).toBe(toHex(nonce))
  })

  it('reads null as "not ours", which is an answer and not a failure', () => {
    expect(parseDecryptedCoin('null')).toBeUndefined()
  })
})

describe('parseIdentifiers', () => {
  it('reads the hex list a proven transaction reports', () => {
    expect(parseIdentifiers('["00aa","01bb"]')).toEqual(['00aa', '01bb'])
  })

  it('rejects an empty list rather than returning one', () => {
    // `[]` would mean "this send can never be matched to its on-chain row", which is exactly the
    // silent untrackability the identifier work exists to remove.
    expect(() => parseIdentifiers('[]')).toThrow(/at least one/)
  })

  it('rejects a non-array and a list holding a non-string', () => {
    expect(() => parseIdentifiers('{"identifiers":["00aa"]}')).toThrow(/expected an array/)
    expect(() => parseIdentifiers('["00aa",7]')).toThrow(/expected an array/)
  })
})

describe('parseNightSignature', () => {
  const sig = 'ab'.repeat(64)
  const key = 'cd'.repeat(32)

  it('reads a 64-byte signature and a 32-byte key', () => {
    expect(parseNightSignature(JSON.stringify({signature: sig, verifyingKey: key}))).toEqual({
      signature: sig,
      verifyingKey: key,
    })
  })

  it('rejects the wrong widths rather than passing on something that cannot verify', () => {
    // A dApp verifies against these exact widths; handing on a short signature makes the wallet look
    // responsible for a verification failure it caused.
    expect(() => parseNightSignature(JSON.stringify({signature: 'ab', verifyingKey: key}))).toThrow(/signature/)
    expect(() => parseNightSignature(JSON.stringify({signature: sig, verifyingKey: 'cd'}))).toThrow(/verifying key/)
  })

  it('rejects a missing or non-hex field', () => {
    expect(() => parseNightSignature(JSON.stringify({verifyingKey: key}))).toThrow(/signature/)
    expect(() => parseNightSignature(JSON.stringify({signature: 'z'.repeat(128), verifyingKey: key}))).toThrow(
      /signature/,
    )
  })
})

describe('parseTxBalance', () => {
  const night = '00'.repeat(32)

  it('reads a deficit as a negative bigint', () => {
    const entries = parseTxBalance(`[{"kind":"unshielded","tokenType":"${night}","segment":1,"delta":"-1000000"}]`)
    expect(entries).toEqual([{kind: 'unshielded', tokenType: night, segment: 1, delta: -1_000_000n}])
  })

  it('carries a value past 2^53 without rounding it', () => {
    // The whole reason `delta` crosses as a string: a Number here would fund the wrong amount.
    const huge = '170141183460469231731687303715884105727'
    const [entry] = parseTxBalance(`[{"kind":"unshielded","tokenType":"${night}","segment":1,"delta":"-${huge}"}]`)
    expect(entry?.delta).toBe(-BigInt(huge))
  })

  it('accepts a null token type for DUST', () => {
    const [entry] = parseTxBalance('[{"kind":"dust","tokenType":null,"segment":0,"delta":"-5"}]')
    expect(entry).toEqual({kind: 'dust', tokenType: null, segment: 0, delta: -5n})
  })

  it('reads an empty map as no imbalance', () => {
    expect(parseTxBalance('[]')).toEqual([])
  })

  it('refuses an unknown token kind rather than guessing', () => {
    expect(() => parseTxBalance('[{"kind":"wat","tokenType":null,"segment":0,"delta":"-5"}]')).toThrow(
      /unknown token kind 'wat'/,
    )
  })

  it('refuses a delta that arrived as a number', () => {
    // A number is how precision is lost, so it is a failure and not a value to coerce.
    expect(() => parseTxBalance(`[{"kind":"unshielded","tokenType":"${night}","segment":1,"delta":-5}]`)).toThrow(
      /delta must be a decimal string/,
    )
  })

  it('refuses a non-integer segment', () => {
    expect(() => parseTxBalance(`[{"kind":"unshielded","tokenType":"${night}","segment":1.5,"delta":"-5"}]`)).toThrow(
      /segment must be an integer/,
    )
  })

  it('refuses something that is not an array', () => {
    expect(() => parseTxBalance('{}')).toThrow(/expected an array/)
  })
})

describe('deficitsOf', () => {
  const night = '00'.repeat(32)
  const other = '07'.repeat(32)
  const entry = (segment: number, delta: bigint, tokenType = night): TxBalanceEntry => ({
    kind: 'unshielded',
    tokenType,
    segment,
    delta,
  })

  it('keeps only what is owed, as a positive magnitude', () => {
    expect(deficitsOf([entry(1, -1_000n), entry(2, 500n)])).toEqual([
      {kind: 'unshielded', tokenType: night, segment: 1, owed: 1_000n},
    ])
  })

  it('treats a surplus as nothing to fund', () => {
    // `balancing_check` rejects negatives only, so a positive entry is legal and must not be "covered".
    expect(deficitsOf([entry(1, 900n)])).toEqual([])
  })

  it('treats an exactly-zero entry as nothing to fund', () => {
    expect(deficitsOf([entry(1, 0n)])).toEqual([])
  })

  it('orders by amount owed, largest first', () => {
    const ordered = deficitsOf([entry(1, -10n), entry(3, -900n, other), entry(2, -50n)])
    expect(ordered.map((d) => d.owed)).toEqual([900n, 50n, 10n])
  })

  it('breaks a tie by segment so the order is stable', () => {
    const ordered = deficitsOf([entry(4, -7n), entry(2, -7n)])
    expect(ordered.map((d) => d.segment)).toEqual([2, 4])
  })
})

describe('u64ToLeHex', () => {
  it('writes eight little-endian bytes', () => {
    expect(u64ToLeHex(1n)).toBe('0100000000000000')
  })

  it('writes zero as eight zero bytes, not as empty', () => {
    // The native side length-checks at 8; an empty arg would be refused rather than read as zero.
    expect(u64ToLeHex(0n)).toBe('0000000000000000')
  })

  it('carries a real unix timestamp', () => {
    expect(fromHex(u64ToLeHex(1_800_000_000n)).length).toBe(8)
  })

  it('refuses a negative value', () => {
    expect(() => u64ToLeHex(-1n)).toThrow(/cannot be negative/)
  })

  it('refuses a value past 64 bits rather than wrapping it', () => {
    // Wrapping would silently ask for a different tree index or instant.
    expect(() => u64ToLeHex(2n ** 64n)).toThrow(/exceeds 64 bits/)
  })

  it('accepts the largest u64', () => {
    expect(u64ToLeHex(2n ** 64n - 1n)).toBe('ffffffffffffffff')
  })
})

describe('collapseRangeHex', () => {
  it('writes start then end, sixteen bytes in all', () => {
    expect(collapseRangeHex(1n, 2n)).toBe('01000000000000000200000000000000')
  })

  it('allows a single-index range', () => {
    expect(fromHex(collapseRangeHex(5n, 5n)).length).toBe(16)
  })

  it('refuses a backwards range', () => {
    // Collapsing is irreversible, so a silently swapped range would discard leaves nobody asked to
    // lose. Refused on both sides of the bridge deliberately.
    expect(() => collapseRangeHex(9n, 4n)).toThrow(/must not end before it starts/)
  })
})

describe('parseDustBalance', () => {
  it('reads a balance as a bigint', () => {
    expect(parseDustBalance('{"balance":"12712997288999987988","syncTime":1700000000,"utxos":3}')).toEqual({
      balance: 12_712_997_288_999_987_988n,
      syncTime: 1_700_000_000,
      utxos: 3,
    })
  })

  it('keeps a balance past 2^53 exact', () => {
    // A DUST balance in SPECK routinely exceeds it; a Number here would show a wrong figure and pay a
    // wrong fee from it.
    const {balance} = parseDustBalance('{"balance":"17037035324531249969","syncTime":0,"utxos":1}')
    expect(balance).toBe(17_037_035_324_531_249_969n)
  })

  it('reads an unsynced state as syncTime 0, not as missing', () => {
    expect(parseDustBalance('{"balance":"0","syncTime":0,"utxos":0}').syncTime).toBe(0)
  })

  it('refuses a balance that arrived as a number', () => {
    expect(() => parseDustBalance('{"balance":123,"syncTime":0,"utxos":0}')).toThrow(/decimal string/)
  })

  it('refuses a missing syncTime rather than defaulting it', () => {
    // "synced to the epoch" and "we do not know" are different facts, and only one is safe to act on.
    expect(() => parseDustBalance('{"balance":"0","utxos":0}')).toThrow(/malformed syncTime/)
  })
})

describe('parseDustUtxos', () => {
  const row = '{"initialValue":"5000","seq":2,"ctime":1700000000,"mtIndex":7,"backingNight":"aa"}'

  it('reads a utxo', () => {
    expect(parseDustUtxos(`[${row}]`)).toEqual([
      {initialValue: 5_000n, seq: 2, ctime: 1_700_000_000, mtIndex: 7, backingNight: 'aa'},
    ])
  })

  it('reads an empty list as holding nothing', () => {
    expect(parseDustUtxos('[]')).toEqual([])
  })

  it('refuses an initialValue that arrived as a number', () => {
    expect(() => parseDustUtxos('[{"initialValue":5000,"seq":0,"ctime":0,"mtIndex":0,"backingNight":"aa"}]')).toThrow(
      /decimal string/,
    )
  })

  it('refuses a missing mtIndex, which a spend needs', () => {
    expect(() => parseDustUtxos('[{"initialValue":"1","seq":0,"ctime":0,"backingNight":"aa"}]')).toThrow(/mtIndex/)
  })

  it('refuses something that is not an array', () => {
    expect(() => parseDustUtxos('{}')).toThrow(/expected an array/)
  })
})

describe('generationToWire', () => {
  const entry = (over: Partial<DustGenerationEntry> = {}): DustGenerationEntry => ({
    generationIndex: 238_131,
    commitmentIndex: 705_946,
    value: 5_000_000_000n,
    initialValue: 17_031_838_739_999_999_999n,
    ctime: 1_780_421_334,
    seq: 0,
    backingNight: 'ab'.repeat(32),
    dtime: null,
    ...over,
  })

  it('writes exactly the width the native side reads', () => {
    // 100, spelled out rather than compared to the constant: measuring the encoder against the same
    // number it uses passed while both were wrong by the backing-night field's 32 bytes.
    expect(fromHex(generationToWire(entry())).length).toBe(100)
    expect(GENERATION_RECORD_LEN).toBe(100)
  })

  it('lays the fields out where dust.rs reads them', () => {
    expect(GENERATION_OFFSETS).toEqual({
      generationIndex: 0,
      commitmentIndex: 8,
      value: 16,
      initialValue: 32,
      ctime: 48,
      seq: 56,
      backingNight: 60,
      dtime: 92,
    })
    // Every field must fit inside the record, with the last one ending exactly at the width.
    expect(GENERATION_OFFSETS.dtime + 8).toBe(GENERATION_RECORD_LEN)
  })

  it('puts the backing night where the 32 bytes actually land', () => {
    const wire = fromHex(generationToWire(entry({backingNight: 'ab'.repeat(32)})))
    expect([...wire.slice(60, 92)].every((b) => b === 0xab)).toBe(true)
  })

  it('carries an initialValue past 2^64 across both halves', () => {
    // A real preprod entry is ~1.7e19 SPECK, which needs the full u128. Truncating to 64 bits would
    // land a different, valid-looking amount.
    const wire = fromHex(generationToWire(entry({initialValue: 2n ** 100n})))
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    const low = view.getBigUint64(32, true)
    const high = view.getBigUint64(40, true)
    expect((high << 64n) | low).toBe(2n ** 100n)
  })

  it('writes a live registration as the zero "never" sentinel', () => {
    // 0 means Timestamp::MAX natively. Writing an actual 0 timestamp would stop generation dead.
    const wire = fromHex(generationToWire(entry({dtime: null})))
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    expect(view.getBigUint64(GENERATION_OFFSETS.dtime, true)).toBe(0n)
  })

  it('writes a real dtime when the entry has stopped generating', () => {
    const wire = fromHex(generationToWire(entry({dtime: 1_780_500_000})))
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    expect(view.getBigUint64(GENERATION_OFFSETS.dtime, true)).toBe(1_780_500_000n)
  })

  it('refuses a backing night that is not 32 bytes', () => {
    expect(() => generationToWire(entry({backingNight: 'abcd'}))).toThrow(/32 bytes/)
  })

  it('refuses a seq that cannot be a u32', () => {
    expect(() => generationToWire(entry({seq: -1}))).toThrow(/u32/)
  })

  it('refuses a value past a u128 rather than wrapping it', () => {
    expect(() => generationToWire(entry({value: 2n ** 128n}))).toThrow(/u128/)
  })

  it('round-trips the indices', () => {
    const wire = fromHex(generationToWire(entry()))
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    expect(view.getBigUint64(0, true)).toBe(238_131n)
    expect(view.getBigUint64(8, true)).toBe(705_946n)
  })
})

describe('registerArg', () => {
  const base = {
    dustRoleKey: new Uint8Array(32).fill(3),
    register: true,
    ttlSecs: 1_800_000_000,
    ctimeSecs: 1_700_000_000,
    feeMargin: 2,
    nightInputs: [],
    networkId: 'preprod',
  }

  const night = (value: bigint, outputIndex: number): UnshieldedSpend => ({
    value,
    tokenType: new Uint8Array(32),
    intentHash: new Uint8Array(32).fill(outputIndex + 1),
    outputIndex,
  })

  it('lays the fields out where dust.rs reads them', () => {
    const wire = fromHex(registerArg(base))
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    expect(wire.slice(0, 32).every((b) => b === 3)).toBe(true)
    expect(wire[32]).toBe(1)
    expect(view.getBigUint64(33, true)).toBe(1_800_000_000n)
    expect(view.getBigUint64(41, true)).toBe(1_700_000_000n)
    expect(wire[49]).toBe(2)
    expect(view.getUint16(50, true)).toBe(0)
    expect(new TextDecoder().decode(wire.slice(52))).toBe('preprod')
  })

  // The count is what frames the inputs, so the network id's offset moves with it. A count that did
  // not match the bytes would have `dust.rs` read part of an input as the network id.
  it('counts the inputs and puts the network id after them', () => {
    const wire = fromHex(registerArg({...base, nightInputs: [night(7n, 0), night(9n, 1)]}))
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
    expect(view.getUint16(50, true)).toBe(2)
    expect(wire.length).toBe(52 + 2 * INPUT_RECORD_LEN + 'preprod'.length)
    expect(new TextDecoder().decode(wire.slice(52 + 2 * INPUT_RECORD_LEN))).toBe('preprod')
    // First record: value (u128 LE) then the token type.
    expect(view.getBigUint64(52, true)).toBe(7n)
  })

  it('writes 0 for a deregistration', () => {
    // The flag decides register versus *deregister*, so it must be exact rather than truthy.
    expect(fromHex(registerArg({...base, register: false}))[32]).toBe(0)
  })

  it('refuses an empty network id rather than sending one', () => {
    // '' is not 'undeployed' — the ledger rejects the empty string outright.
    expect(() => registerArg({...base, networkId: ''})).toThrow(/needs a network id/)
  })

  it('refuses a dust key of the wrong width', () => {
    expect(() => registerArg({...base, dustRoleKey: new Uint8Array(16)})).toThrow(/32 bytes/)
  })

  it('refuses a fee margin that cannot fit a byte', () => {
    expect(() => registerArg({...base, feeMargin: 300})).toThrow(/fit a byte/)
  })

  it('carries a multi-byte network id whole', () => {
    const wire = fromHex(registerArg({...base, networkId: 'undeployed'}))
    expect(new TextDecoder().decode(wire.slice(52))).toBe('undeployed')
  })

  // Empty is legal here and only here: a deregistration spends nothing, while `packUnshieldedInputs`
  // refuses an empty list because a transfer with no inputs can only fail later.
  it('accepts no inputs, for a deregistration', () => {
    expect(() => registerArg({...base, register: false, nightInputs: []})).not.toThrow()
  })
})

describe('parseDustRegistration', () => {
  it('reads the transaction and the authorised amount', () => {
    expect(parseDustRegistration('{"tx":"00ff","allowFeePayment":"686161378353573"}')).toEqual({
      transaction: new Uint8Array([0, 255]),
      allowFeePayment: 686_161_378_353_573n,
    })
  })

  it('refuses an amount that arrived as a number', () => {
    // A fee in SPECK exceeds 2^53, so a Number would authorise a different amount than intended. The
    // type guard catches it before the shape guard, hence this message rather than the other.
    expect(() => parseDustRegistration('{"tx":"00","allowFeePayment":123}')).toThrow(/as strings/)
  })

  it('refuses a string that is not a decimal amount', () => {
    expect(() => parseDustRegistration('{"tx":"00","allowFeePayment":"lots"}')).toThrow(/decimal string/)
  })

  it('refuses a missing transaction', () => {
    expect(() => parseDustRegistration('{"allowFeePayment":"1"}')).toThrow(/must return tx/)
  })
})
