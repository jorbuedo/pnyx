/** Shared URI resolver — the single source of truth for scheme classification, used
 * by reconcile (CIP-25), ingest-cip68, and the re-resolve fixups. Aggressively and
 * encoding-agnostically recovers IPFS: for an `ipfs://` URI the canonical is whatever
 * follows the scheme (any multibase CID — Qm / bafy / z… / k…), never regex-gated. */

// Loose CID token for GATEWAY urls and bare values (all common multibases).
const CID_RE =
  /(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[0-9a-z]{20,}|b[A-Za-z2-7]{58,}|z[1-9A-HJ-NP-Za-km-z]{48,}|k[0-9a-z]{50,})(\/[^\s?#]*)?/
export const extractCid = (s: string): string | null => {
  const m = s.match(CID_RE)
  return m ? m[0] : null
}

const stripQuery = (s: string): string => s.split(/[?#\s]/)[0]

export const resolve = (uri: string): {scheme: string; canonical: string | null} => {
  const u = (uri ?? '').trim()
  if (!u || u.toLowerCase() === 'none' || u.toLowerCase() === 'null') return {scheme: 'none', canonical: null}
  if (u.startsWith('data:')) return {scheme: 'data', canonical: u}
  if (/^ar:\/\//i.test(u)) return {scheme: 'arweave', canonical: u.slice(5)}
  // ipfs://CID[/path], tolerating ipfs://ipfs/ — take the remainder verbatim (any CID encoding)
  if (/^ipfs:\/\//i.test(u)) {
    const rest = stripQuery(u.replace(/^ipfs:\/\/(?:ipfs\/)?/i, '').replace(/^\/+/, ''))
    if (rest) return {scheme: 'ipfs', canonical: rest}
  }
  // malformed ipfs prefixes: ipfs:, ipfs/, ipfs:/ (no double slash)
  if (/^ipfs[:/]/i.test(u)) {
    const rest = stripQuery(u.replace(/^ipfs[:/\s]+(?:ipfs\/)?/i, '').replace(/^\/+/, ''))
    const cid = extractCid(rest) ?? (rest || null)
    if (cid) return {scheme: 'ipfs', canonical: cid}
  }
  // any gateway URL with an /ipfs/ path segment
  const gw = u.match(/\/ipfs\/([^?#\s]+)/i)
  if (gw) return {scheme: 'ipfs', canonical: gw[1] }
  // bare leading CID (with optional path)
  const bare = extractCid(u)
  if (bare && u.startsWith(bare)) return {scheme: 'ipfs', canonical: bare}
  if (/^https?:\/\//i.test(u)) {
    const ar = u.match(/^https?:\/\/(?:www\.)?arweave\.net\/([A-Za-z0-9_-]{43})/i)
    if (ar) return {scheme: 'arweave', canonical: ar[1]}
    return {scheme: 'http', canonical: u}
  }
  return {scheme: 'other', canonical: null}
}
