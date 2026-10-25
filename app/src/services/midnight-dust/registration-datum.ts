/**
 * Plutus datum for a cNIGHT→DUST mapping registration (Proposal 0018).
 *
 * The mapping validator stores each registration as an inline datum
 * `Constr0 [ Constr0 [ bytes28 c_wallet ], bytes(≤33) dust_address ]`, where `c_wallet`
 * is the registrant's Cardano **stake key hash** and `dust_address` is the raw payload
 * inside the designated `mn_dust` bech32m address.
 *
 * Two things here differ from the written proposal, both established by decoding a real
 * register transaction rather than from the spec:
 *
 * - **The identity is the stake key hash, not a payment `PubKeyHash`.** Registration is
 *   one-per-account, and every cNIGHT the account holds across its addresses shares that
 *   stake key.
 * - **There is no `active` flag.** A registration UTxO's *presence* is the registration,
 *   and deregistering removes it — so there is no inactive state to reactivate.
 *
 * Hand-rolled CBOR rather than the `Data` facade: this is byte-shape matching, the shape
 * is pinned by goldens taken from that real transaction, and keeping it free of the codec
 * lets the health core stay pure.
 *
 * @module
 */

const MAX_DUST_ADDR_BYTES = 33
const STAKE_KEY_HASH_BYTES = 28

const isHex = (s: string): boolean => s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s)
const byteLen = (hex: string): number => hex.length / 2

/** CBOR major-type-2 (byte string) header for `len` bytes — ≤ 255, all this datum needs. */
const cborByteStringHeader = (len: number): string => {
  if (len < 24) return (0x40 + len).toString(16).padStart(2, '0')
  return `58${len.toString(16).padStart(2, '0')}`
}

const cborByteString = (hex: string): string => `${cborByteStringHeader(byteLen(hex))}${hex.toLowerCase()}`

/** Plutus `Constr` alternative 0: CBOR tag 121 (`d879`) + an indefinite array (`9f`). */
const CONSTR0_OPEN = 'd8799f'
const INDEF_BREAK = 'ff'

/**
 * Encode the registration datum to Plutus-data CBOR (hex).
 *
 * Throws on malformed hex or out-of-spec lengths rather than truncating or padding: a
 * datum the validator rejects is better than one it accepts with the wrong destination.
 */
export const encodeDustRegistrationDatum = (stakeKeyHash: string, dustPayload: string): string => {
  if (!isHex(stakeKeyHash) || byteLen(stakeKeyHash) !== STAKE_KEY_HASH_BYTES) {
    throw new Error(`stakeKeyHash must be ${STAKE_KEY_HASH_BYTES} hex bytes`)
  }
  if (!isHex(dustPayload) || byteLen(dustPayload) === 0 || byteLen(dustPayload) > MAX_DUST_ADDR_BYTES) {
    throw new Error(`dustPayload must be 1..${MAX_DUST_ADDR_BYTES} hex bytes`)
  }
  return `${CONSTR0_OPEN}${CONSTR0_OPEN}${cborByteString(stakeKeyHash)}${INDEF_BREAK}${cborByteString(dustPayload)}${INDEF_BREAK}`
}

export type DecodedDustRegistrationDatum = {
  /** 28-byte Cardano stake key hash (hex) — the datum's `c_wallet`. */
  readonly stakeKeyHash: string
  /** Raw DUST address payload (hex, ≤ 33 bytes) — the bytes inside `mn_dust`. */
  readonly dustPayload: string
}

/**
 * Decode a registration inline datum back into its fields — the inverse of
 * {@link encodeDustRegistrationDatum}. This is how the on-chain DUST destination of *any*
 * registration is read, including one this wallet did not create.
 *
 * `null` for anything that is not exactly `Constr0[Constr0[bytes28], bytes(1..33)]`,
 * trailing bytes included. Never guesses and never partially decodes: a half-read datum
 * would let the wallet claim a DUST destination the chain does not agree with.
 */
export const decodeDustRegistrationDatum = (datumHex: string): DecodedDustRegistrationDatum | null => {
  if (!isHex(datumHex)) return null
  const h = datumHex.toLowerCase()
  let cursor = 0

  const take = (nBytes: number): string | null => {
    const end = cursor + nBytes * 2
    if (end > h.length) return null
    const slice = h.slice(cursor, end)
    cursor = end
    return slice
  }

  const readByteString = (): string | null => {
    const head = take(1)
    if (head === null) return null
    const b = Number.parseInt(head, 16)
    let len: number
    if (b >= 0x40 && b <= 0x57) len = b - 0x40
    else if (b === 0x58) {
      const lenByte = take(1)
      if (lenByte === null) return null
      len = Number.parseInt(lenByte, 16)
    } else return null
    return take(len)
  }

  if (take(3) !== CONSTR0_OPEN) return null
  if (take(3) !== CONSTR0_OPEN) return null
  const stakeKeyHash = readByteString()
  if (stakeKeyHash === null) return null
  if (take(1) !== INDEF_BREAK) return null
  const dustPayload = readByteString()
  if (dustPayload === null) return null
  if (take(1) !== INDEF_BREAK) return null
  if (cursor !== h.length) return null

  if (byteLen(stakeKeyHash) !== STAKE_KEY_HASH_BYTES) return null
  if (byteLen(dustPayload) === 0 || byteLen(dustPayload) > MAX_DUST_ADDR_BYTES) return null
  return {stakeKeyHash, dustPayload}
}
