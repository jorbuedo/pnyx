// Regenerates the pinned tables in `src/handle-charset.ts` from this engine's Unicode properties.
//
// Run it when `DENIED_PROPERTIES` changes, or when a Unicode upgrade should be adopted, and then
// **read the diff**: a denylist is open by default, so regenerating is the moment somebody decides a
// new version's characters may be claimed on a contract where ownership is permanent.
//
// ⚠️ Run it with **Node**, not Bun: the drift test runs under vitest, and the two engines ship
// different Unicode versions, so a Bun-generated table fails the moment it lands.
//
//   node --import tsx packages/contract-client/scripts/generate-handle-charset.mts
import {readFileSync, writeFileSync} from 'node:fs'
import {CHARSET_TABLES, pack} from '../src/handle-charset-source.js'

const wrap = (packed: string): string => {
  const lines: string[] = []
  let line = ''
  for (const segment of packed.split(',')) {
    if (line.length + segment.length + 1 > 108) {
      lines.push(line)
      line = ''
    }
    line += (line ? ',' : '') + segment
  }
  if (line) lines.push(line)
  return lines.map((l, i) => (i === lines.length - 1 ? `  '${l}',` : `  '${l},' +`)).join('\n')
}

const target = new URL('../src/handle-charset.ts', import.meta.url)
let source = readFileSync(target, 'utf8')
for (const [name, table] of [
  ['DENIED_RANGES', CHARSET_TABLES.denied()],
  ['COMBINING_MARK_RANGES', CHARSET_TABLES.marks()],
  ['NONSPACING_MARK_RANGES', CHARSET_TABLES.nonspacing()],
] as const) {
  const head = `export const ${name}: readonly HandleRange[] = decode(\n`
  const start = source.indexOf(head)
  if (start === -1) throw new Error(`cannot find ${name} in handle-charset.ts`)
  const bodyStart = start + head.length
  const end = source.indexOf('\n)', bodyStart)
  source = `${source.slice(0, bodyStart)}${wrap(pack(table))}${source.slice(end)}`
}
writeFileSync(target, source)
console.log('handle-charset.ts regenerated — read the diff before committing')
