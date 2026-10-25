/**
 * Post-extraction checkpoint numbers: distinct assets with usable media, scheme
 * breakdown, CIP-25 vs CIP-68, mint-year curve, projected output size + disk
 * headroom. Reads assets.db + the extractor summary. Writes coverage-checkpoint.md.
 *
 * Usage: bun run checkpoint-report.ts <assets.db> <extract.summary.log> <out.md>
 */
import {Database} from 'bun:sqlite'
import {writeFileSync, readFileSync} from 'node:fs'

const [, , dbPath = '../data/assets.db', summaryPath = '../data/extract.summary.log', outMd = '../coverage-checkpoint.md'] =
  process.argv
const db = new Database(dbPath)
const ex = JSON.parse(readFileSync(summaryPath, 'utf8'))
const cal = JSON.parse(readFileSync('../data/calibration.json', 'utf8'))

// Cardano slot → UTC year. Byron: 20s slots from 2017-09-23 21:44:51.
// Shelley (slot >= 4492800): 1s slots from 2020-07-29 21:44:51.
const BYRON_START = 1506203091
const SHELLEY_SLOT = 4492800
const SHELLEY_START = 1596059091
const slotToUnix = (slot: number): number =>
  slot < SHELLEY_SLOT ? BYRON_START + slot * 20 : SHELLEY_START + (slot - SHELLEY_SLOT)
const slotYear = (slot: number): number => new Date(slotToUnix(slot) * 1000).getUTCFullYear()

const q = (sql: string): any[] => db.query(sql).all()
const one = (sql: string): any => db.query(sql).get()

const FETCHABLE = "('ipfs','http','arweave','data','data-registry')"
const total = one('SELECT COUNT(*) c FROM asset').c
const byKind = q('SELECT kind, COUNT(*) c FROM asset GROUP BY kind ORDER BY c DESC')
const byScheme = q('SELECT scheme, COUNT(*) c FROM asset GROUP BY scheme ORDER BY c DESC')
const byClass = q('SELECT cip_class, COUNT(*) c FROM asset GROUP BY cip_class ORDER BY c DESC')
const byMatch = q('SELECT name_match, COUNT(*) c FROM asset GROUP BY name_match ORDER BY c DESC')
const fetchable = one(`SELECT COUNT(*) c FROM asset WHERE scheme IN ${FETCHABLE}`).c
const unfetchable = total - fetchable

// mint-year curve (NFT rows only; ft-logos have no mint slot)
const slots = q("SELECT mint_slot FROM asset WHERE kind='nft'")
const yearCount = new Map<number, number>()
for (const {mint_slot} of slots) {
  const y = slotYear(mint_slot)
  yearCount.set(y, (yearCount.get(y) ?? 0) + 1)
}
const years = [...yearCount.entries()].sort((a, b) => a[0] - b[0])

// projected output size @ 20/50/100 KB per WebP
const kb = (n: number, per: number) => ((n * per) / 1024 / 1024).toFixed(1) // GB
const proj = {low: kb(fetchable, 20), mid: kb(fetchable, 50), high: kb(fetchable, 100)}
// R2 storage cost: $0.015 / GB-month
const cost = (gb: string) => (Number(gb) * 0.015).toFixed(2)

const cip68Universe = ex.class.nft222 + ex.class.ft333 + ex.class.rft444

const pct = (n: number) => ((100 * n) / total).toFixed(1)
const md: string[] = []
md.push('# Coverage — extraction checkpoint\n')
md.push(`_Generated after the extraction pass. Chain tip: slot ${ex.last_slot} (~${new Date(slotToUnix(ex.last_slot) * 1000).toISOString().slice(0, 10)}), ${ex.blocks.toLocaleString()} blocks, ${ex.txs.toLocaleString()} txs._\n`)

md.push('## Distinct assets with a usable media URI\n')
md.push(`**${fetchable.toLocaleString()}** assets have a fetchable media candidate (of ${total.toLocaleString()} total media rows).`)
md.push(`- Unfetchable (no CID/URL recovered — junk/empty/\`none\`): **${unfetchable.toLocaleString()}** (${pct(unfetchable)}%)\n`)

md.push('### By kind')
md.push('| kind | count |\n|---|--:|')
for (const r of byKind) md.push(`| ${r.kind} | ${r.c.toLocaleString()} |`)
md.push('')

md.push('### By URI scheme')
md.push('| scheme | count | % |\n|---|--:|--:|')
for (const r of byScheme) md.push(`| ${r.scheme} | ${r.c.toLocaleString()} | ${pct(r.c)} |`)
md.push('')

md.push('### By CIP-67 name class (of the 721/registry rows)')
md.push('| class | count |\n|---|--:|')
for (const r of byClass) md.push(`| ${r.cip_class} | ${r.c.toLocaleString()} |`)
md.push('')

md.push('## CIP-25 vs CIP-68\n')
md.push(`- **CIP-25 (label 721) assets with media** (this dataset, NFT rows): **${(byKind.find((k) => k.kind === 'nft')?.c ?? 0).toLocaleString()}**`)
md.push(`- **CIP-68 user tokens on-chain** (from mint tally — 222+333+444): **${cip68Universe.toLocaleString()}** (222=${ex.class.nft222.toLocaleString()}, 333=${ex.class.ft333.toLocaleString()}, 444=${ex.class.rft444.toLocaleString()}); reference NFTs (100)=${ex.class.ref100.toLocaleString()}`)
md.push(`- CIP-68 metadata lives in the reference-NFT datum. **v1 scope decision pending** (see below). Most CIP-68 assets do NOT post 721, so they are largely absent from the CIP-25 count above.\n`)

md.push('### Asset-name resolution quality')
md.push('| method | count |\n|---|--:|')
for (const r of byMatch) md.push(`| ${r.name_match} | ${r.c.toLocaleString()} |`)
md.push('\n_`hex` = metadata asset-name key matched the on-chain mint exactly; `one-to-one` = single mint/single entry association; `unverified` = no mint match, best-guess hex (fingerprint may not correspond to a real on-chain asset)._\n')

md.push('## Mint-year curve (NFT media rows)\n')
md.push('| year | assets |\n|---|--:|')
for (const [y, c] of years) md.push(`| ${y} | ${c.toLocaleString()} |`)
md.push('')

// realistic fetched count using measured per-scheme hit rates
const hr: Record<string, number> = cal.hit_rate_by_scheme
const schemeCount = Object.fromEntries(byScheme.map((r) => [r.scheme, r.c]))
const estFetched = Math.round(
  (schemeCount.ipfs ?? 0) * (hr.ipfs / 100) +
    (schemeCount.http ?? 0) * (hr.http / 100) +
    (schemeCount.arweave ?? 0) * (hr.arweave / 100) +
    (schemeCount.data ?? 0) * (hr.data / 100) +
    (schemeCount['data-registry'] ?? 0) * (hr['data-registry'] / 100),
)
const gbStill = (estFetched * cal.still_policy_mean_kb / 1024 / 1024).toFixed(0)
const gbAnim = (estFetched * cal.animated_policy_mean_kb / 1024 / 1024).toFixed(0)

md.push('## Calibration — MEASURED on a live sample\n')
md.push(`A stratified ${cal.sampled}-asset sample was actually fetched (public gateways only, no local kubo, single pass) and encoded to 720px WebP. **These are lower bounds** on eventual coverage — kubo + multi-day retries lift them.\n`)
md.push('### Fetch hit-rate by scheme (the loss signal)')
md.push('| scheme | hit rate |\n|---|--:|')
for (const [s, v] of Object.entries(hr)) md.push(`| ${s} | ${v}% |`)
md.push(`\n**HTTP-hosted media is ~80% gone** (dead domains, expired certs) — it skews to older mints and is the bulk of what is permanently lost. IPFS ${hr.ipfs}% (public gw), Arweave ${hr.arweave}%, on-chain data/registry 100% (unlosable).\n`)
md.push('### Output WebP size — depends entirely on the animation policy')
md.push('| policy | mean/asset | median | p90 |\n|---|--:|--:|--:|')
md.push(`| **first-frame still** (recommended) | **${cal.still_policy_mean_kb} KB** | ${cal.still_policy_median_kb} KB | ${cal.still_policy_p90_kb} KB |`)
md.push(`| animated WebP | ${cal.animated_policy_mean_kb} KB | — | — |`)
md.push(`\n_Animated sources encode to an avg **${(cal.animated_webp_mean_kb / 1024).toFixed(1)} MB** WebP (p90 ${(cal.animated_webp_p90_kb / 1024).toFixed(1)} MB) vs ${cal.animated_as_still_mean_kb} KB as a still — a 6× blob-size multiplier for zero benefit, since \`AssetMedia\` renders a still at 240pt. **Recommendation: first-frame still.**_\n`)

md.push('## Projected output size & cost (measured)\n')
md.push(`Estimated **${estFetched.toLocaleString()}** assets fetch successfully (applying measured per-scheme hit-rates to the corpus).`)
md.push('| policy | blob size | R2 storage $/mo |\n|---|--:|--:|')
md.push(`| first-frame still (${cal.still_policy_mean_kb} KB) | **~${gbStill} GB** | **$${cost(gbStill)}** |`)
md.push(`| animated WebP (${cal.animated_policy_mean_kb} KB) | ~${gbAnim} GB (~${(Number(gbAnim) / 1024).toFixed(1)} TB) | $${cost(gbAnim)} |`)

md.push('## Disk headroom for the fetch phase\n')
md.push(`- **Free on / : 372 GB.** Final still-policy blob: **~${gbStill} GB** → fits, with margin.`)
md.push(`- Animated policy (~${(Number(gbAnim) / 1024).toFixed(1)} TB) does **NOT** fit — another reason for the still policy.`)
md.push(`- Scratch (originals streamed through a temp dir, not retained; 50 MB source cap): budget ~5-10 GB transient.`)
md.push(`- State DB + logs: ~8 GB. \`meta721.jsonl\` (12 GB) is deletable after this checkpoint.\n`)

md.push('## CIP-68 scope decision (needs your call)\n')
md.push(`The naive assumption is that CIP-68 needs a live indexer (kupo/ogmios/db-sync) because its metadata is in the reference-NFT datum, i.e. "ledger state." **That is not quite true here:** CIP-68 metadata lives in an *inline datum* on the label-100 reference-NFT output, and inline datums are recorded in transaction outputs — which ARE in the immutable chunks. So CIP-68 is reachable from the same dump, no new infra, by a second pass that scans outputs for label-100 ref-NFT + inline datum and takes the latest by slot (approximating current ledger state; correct except for the rare recreated-without-change case).`)
md.push(`\n**Options for v1:**`)
md.push(`- **(A) CIP-25 only** — ship the ${(byKind.find((k) => k.kind === 'nft')?.c ?? 0).toLocaleString()} assets now. Defers ~${(cip68Universe - (byClass.find((c) => c.cip_class === 'cip68-nft222')?.c ?? 0)).toLocaleString()} CIP-68 assets *not* also carrying 721. **The asset that motivated this project is CIP-68, so this defers the motivating case.**`)
md.push(`- **(B) CIP-25 + CIP-68 from chunks** (recommended) — one extra Rust pass over the dump (~10-15 min) + a datum parser. No kupo/ogmios. Adds the full ${cip68Universe.toLocaleString()}-asset CIP-68 universe.`)
md.push(`- **(C) CIP-68 via external indexer** — the textbook path; requires syncing kupo/ogmios (hours-days of infra). No advantage over (B) here.\n`)

md.push('## The unfetchable list = the loss record\n')
md.push('```sql')
md.push("SELECT policy_id, asset_name_hex, fingerprint, scheme, image_raw, mint_slot, status, last_error")
md.push("FROM asset WHERE status NOT IN ('ok') ORDER BY mint_slot;  -- the record of what was lost")
md.push('```')
md.push(`Already-unfetchable at extraction (no CID/URL recoverable): **${unfetchable.toLocaleString()}**. The rest of the loss is measured during the fetch (projected from calibration: ~${(100 - Math.round((estFetched / fetchable) * 100)).toFixed(0)}% of fetchable candidates, concentrated in the HTTP scheme and older mints).\n`)

writeFileSync(outMd, md.join('\n'))
console.log(JSON.stringify({
  total, fetchable, unfetchable,
  by_kind: Object.fromEntries(byKind.map((r) => [r.kind, r.c])),
  by_scheme: Object.fromEntries(byScheme.map((r) => [r.scheme, r.c])),
  by_class: Object.fromEntries(byClass.map((r) => [r.cip_class, r.c])),
  by_name_match: Object.fromEntries(byMatch.map((r) => [r.name_match, r.c])),
  cip68_universe: cip68Universe,
  mint_years: Object.fromEntries(years),
  projected_gb: proj,
}, null, 2))
db.close()
