/**
 * Splits the English source into translation-sized chunks.
 *
 *   bun scripts/i18n/chunk.ts [workDir]
 *
 * Chunks break on a top-level namespace boundary where possible so related copy
 * stays together and a translator can see a whole screen at once.
 */
import {translations} from '../../src/i18n/translations'

const WORK = process.argv[2] ?? `${import.meta.dir}/../../.i18n-work`
const TARGET = 340
const HARD_CAP = 400

export function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') out[path] = child
    else if (child && typeof child === 'object') flatten(child, path, out)
  }
  return out
}

const en = flatten(translations)
const keys = Object.keys(en)

const chunks: string[][] = []
let current: string[] = []
let currentTop = ''
for (const key of keys) {
  const top = key.split('.')[0] ?? key
  if ((current.length >= TARGET && top !== currentTop) || current.length >= HARD_CAP) {
    chunks.push(current)
    current = []
  }
  current.push(key)
  currentTop = top
}
if (current.length > 0) chunks.push(current)

for (const [index, chunkKeys] of chunks.entries()) {
  const name = `chunk-${String(index).padStart(2, '0')}.json`
  const body = JSON.stringify(Object.fromEntries(chunkKeys.map((k) => [k, en[k]])), null, 1)
  await Bun.write(`${WORK}/src/${name}`, body)
  console.log(
    `${name}  ${String(chunkKeys.length).padStart(4)} keys  ${String(Math.round(body.length / 1024)).padStart(3)} KB`,
  )
}
console.log(`\n${chunks.length} chunks, ${keys.length} keys -> ${WORK}/src`)
