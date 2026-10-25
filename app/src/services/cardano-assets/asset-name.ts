/**
 * Decode a Cardano asset name from its on-chain hex.
 *
 * Two things make the naive `hex → ASCII` read wrong often enough to matter:
 *
 *  - **CIP-67 label prefixes.** A CIP-68 asset name starts with a 4-byte label
 *    (`000643b0` = 100 reference, `000de140` = 222 NFT, `0014df10` = 333 FT,
 *    `001bc280` = 444 RFT) whose bytes are not printable, so a printable-only
 *    check rejects the whole name and falls back to showing the prefix itself.
 *    That is where a token renders as literally `0014df10` instead of `CLIP IT`.
 *  - **Non-ASCII names.** Plenty of names are legitimate UTF-8 beyond ASCII, and
 *    rejecting them shows hex to the user for no reason.
 *
 * The label is validated by its own CRC-8 before being stripped, so a name that
 * merely begins with `00` keeps all of its bytes.
 *
 * @module
 */

import {logger} from '../../logger'

/** CIP-67 label: `0` + 16-bit label + CRC-8 + `0`, i.e. 4 bytes / 8 hex chars. */
const LABEL_HEX_LEN = 8

/** CRC-8/ATM (poly 0x07, init 0x00) — the checksum CIP-67 puts in the label. */
const crc8 = (bytes: readonly number[]): number => {
  let crc = 0
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Split a CIP-67 label off an asset-name hex: `{label, restHex}`, or `null` when
 * the name does not carry a checksum-valid label.
 */
export const splitCip67Label = (assetNameHex: string): {readonly label: number; readonly restHex: string} | null => {
  if (assetNameHex.length < LABEL_HEX_LEN) return null
  const head = assetNameHex.slice(0, LABEL_HEX_LEN).toLowerCase()
  if (!/^0[0-9a-f]{6}0$/.test(head)) return null
  const label = Number.parseInt(head.slice(1, 5), 16)
  const checksum = Number.parseInt(head.slice(5, 7), 16)
  if (crc8([(label >> 8) & 0xff, label & 0xff]) !== checksum) return null
  return {label, restHex: assetNameHex.slice(LABEL_HEX_LEN)}
}

/** Standard CIP-68 class for a label, when it is one we know. */
export const cip68ClassOf = (label: number): 'reference' | 'nft' | 'ft' | 'rft' | null =>
  label === 100 ? 'reference' : label === 222 ? 'nft' : label === 333 ? 'ft' : label === 444 ? 'rft' : null

/** A name is displayable if it decodes as UTF-8 and holds no control characters. */
const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (text.length === 0 || /[\u0000-\u001f\u007f]/.test(text)) return null
    return text
  } catch (e: unknown) {
    // `fatal: true` makes the throw the answer: these bytes are not text, so the asset keeps
    // its hex name. Debug, so it stays separable from a real decode fault.
    logger.debug('Asset name bytes are not valid UTF-8; keeping the hex form', {
      origin: 'asset-name',
      error: String(e),
    })
    return null
  }
}

/**
 * The human asset name in an asset-name hex, or `null` when the bytes are not
 * text. A CIP-67 label is stripped first; `null` means "we do not have a name",
 * never a hex fragment dressed up as one.
 */
export const decodeAssetName = (assetNameHex: string): string | null => {
  if (assetNameHex.length === 0) return null
  const split = splitCip67Label(assetNameHex)
  const bytes = hexToBytes(split === null ? assetNameHex : split.restHex)
  if (bytes === null || bytes.length === 0) return null
  return decodeUtf8(bytes)
}
