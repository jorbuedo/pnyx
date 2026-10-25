/**
 * The wire shape of a handle contract's record.
 *
 * Pure and separate from `index.ts` so the parse can be tested without the native module — a malformed
 * answer has to be caught here, and this is where a test can reach.
 *
 * @module
 */

/** What a handle contract holds. One **half** of handle validity — see {@link HandleRecord.owner}. */
export type HandleRecord = {
  /** The canonical (folded) name sealed at deploy. Compare it to your own encoding to confirm the fetch. */
  readonly name: Uint8Array
  /** The payment contract this handle's permits must come from, sealed at deploy. */
  readonly payment: Uint8Array
  /**
   * The holder's `C`, or `undefined` when the shell is deployed and unbound.
   *
   * ⚠️ **Owning is not displaying.** Validity is *bidirectional*: this must equal the identity's `C`
   * **and** that identity's `primaryName` must fold to this name, and the handle must be neither banned
   * nor burned. Treating `owner` alone as "who holds this name" renders a name its holder never claimed.
   */
  readonly owner: Uint8Array | undefined
  readonly banned: boolean
  readonly burned: boolean
}

const hex32 = (value: unknown, what: string): Uint8Array => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`handle record: ${what} must be 64 lowercase hex, got ${String(value)}`)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Parse `handle:record`. `owner` arrives as `null` for an unbound shell — never as 64 zeros. */
export const parseHandleRecord = (json: string): HandleRecord => {
  const parsed = JSON.parse(json) as {
    name?: unknown
    payment?: unknown
    owner?: unknown
    banned?: unknown
    burned?: unknown
  }
  if (typeof parsed.banned !== 'boolean' || typeof parsed.burned !== 'boolean') {
    throw new Error(`handle record: banned/burned must be booleans in ${json.slice(0, 80)}`)
  }
  return {
    name: hex32(parsed.name, 'name'),
    payment: hex32(parsed.payment, 'payment'),
    owner: parsed.owner === null ? undefined : hex32(parsed.owner, 'owner'),
    banned: parsed.banned,
    burned: parsed.burned,
  }
}
