/**
 * Shared transport seam for the pool/DRep services: an injectable `fetch` so
 * tests never hit the network, plus hex↔bytes helpers used to derive bech32 ids.
 *
 * @module
 */

/** Injectable fetch so tests never hit the network. */
export type FetchLike = (
  url: string,
  init?: {method?: string; headers?: Record<string, string>; body?: string},
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly json: () => Promise<unknown>
}>

export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
