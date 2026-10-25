/** Measure WebP size vs. resolution: fetch a sample, encode each at several edges,
 * report mean bytes per size → total blob projection + R2 cost. Stills only. */
import {Database} from 'bun:sqlite'
import {readFileSync} from 'node:fs'
import sharp from 'sharp'

const db = new Database('../data/assets.db')
const N = Number(process.argv[2] ?? 300)
const SIZES = [48, 64, 96, 128, 240]
const GATEWAYS = ['https://nftstorage.link/ipfs/', 'https://ipfs.io/ipfs/', 'https://w3s.link/ipfs/', 'https://dweb.link/ipfs/']
const UA = 'pnyx-media-blob/0.1 (+cardano native-asset media archival; https://media.pxkq.uk)'
const CAP = 50 * 1024 * 1024

const rows = db.query(
  `SELECT scheme, canonical FROM asset WHERE scheme IN ('ipfs','data') AND canonical IS NOT NULL ORDER BY substr(fingerprint,9) LIMIT ?`,
).all(N) as any[]

const fetchCap = async (url: string): Promise<Uint8Array | null> => {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 12000)
  try {
    const r = await fetch(url, {signal: ctl.signal, headers: {'User-Agent': UA}})
    if (!r.ok) return null
    const b = new Uint8Array(await r.arrayBuffer())
    return b.length > CAP ? null : b
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
const getSource = async (r: any): Promise<Uint8Array | null> => {
  if (r.scheme === 'data') {
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(r.canonical)
    if (!m) return null
    try {
      return m[1] ? Uint8Array.from(Buffer.from(m[2], 'base64')) : new TextEncoder().encode(decodeURIComponent(m[2]))
    } catch {
      return null
    }
  }
  for (const g of GATEWAYS) {
    const b = await fetchCap(g + r.canonical)
    if (b) return b
  }
  return null
}

const sizes: Record<number, number[]> = Object.fromEntries(SIZES.map((s) => [s, []]))
let ok = 0
let idx = 0
const worker = async () => {
  while (idx < rows.length) {
    const r = rows[idx++]
    const src = await getSource(r)
    if (!src) continue
    try {
      for (const edge of SIZES) {
        const out = await sharp(src, {limitInputPixels: 500_000_000})
          .resize(edge, edge, {fit: 'inside', withoutEnlargement: true})
          .webp({quality: 80, effort: 4})
          .toBuffer()
        sizes[edge].push(out.length)
      }
      ok++
    } catch {}
  }
}
await Promise.all(Array.from({length: 24}, worker))

const FETCHED = 7_490_000
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1)
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0
console.log(`measured on ${ok} assets encoded at each size\n`)
console.log('edge  mean_KB  median_KB   blob_GB(×7.49M)   R2 $/mo')
for (const edge of SIZES) {
  const mk = mean(sizes[edge]) / 1024
  const gb = (mean(sizes[edge]) * FETCHED) / 1024 / 1024 / 1024
  console.log(
    `${edge}px  ${mk.toFixed(1).padStart(6)}  ${(median(sizes[edge]) / 1024).toFixed(1).padStart(7)}   ${gb.toFixed(0).padStart(10)} GB      $${(gb * 0.015).toFixed(2)}`,
  )
}
db.close()
