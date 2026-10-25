// Which module specifiers in a source file are needed at runtime.
//
// Pure and separate from the filesystem walk so it can be tested directly — it is the part of the
// deploy closure that can silently break. Miss a runtime import and the sponsor host fails at boot;
// wrongly keep a type-only one and a 41 MB per-contract build artifact lands on a host whose entire
// point is that it does not depend on the deployed contract (`witnesses.ts` imports `Witnesses` from
// `contract/managed` that way).
//
// Erring towards *including* a specifier is the safe direction: an extra package costs disk, a missing
// one costs a failed boot. So `import type` / `export type` is the only exclusion.

const FROM_CLAUSE = /(?:^|[\n;{}])[ \t]*(import|export)\b([ \t]+type\b)?([^'"]*?)\bfrom[ \t]*['"]([^'"]+)['"]/g
const SIDE_EFFECT = /(?:^|[\n;{}])[ \t]*import[ \t]*['"]([^'"]+)['"]/g
const DYNAMIC = /\bimport\([ \t]*['"]([^'"]+)['"][ \t]*\)/g
const REQUIRE = /\brequire\([ \t]*['"]([^'"]+)['"][ \t]*\)/g

/**
 * Runtime module specifiers in `code`, deduplicated, in no particular order.
 *
 * A dynamic `import()` whose argument is not a literal cannot be resolved statically and is not
 * reported. The one such call in the sponsor's reach is `createChainClient`'s contract-module import,
 * which the sponsor never calls — `sponsor-client` exists precisely to avoid it.
 */
export const runtimeSpecifiers = (code: string): readonly string[] => {
  const found = new Set<string>()

  for (const match of code.matchAll(FROM_CLAUSE)) {
    const [, , typeKeyword, clause, spec] = match
    if (typeKeyword !== undefined) continue
    if (clause === undefined || spec === undefined) continue
    // A lazy match can run past the end of a statement when the file has no `from` after an early
    // `import`/`export`; a clause spanning another quoted specifier means the pairing is wrong.
    if (clause.includes('import ') || clause.includes('require(')) continue
    found.add(spec)
  }
  for (const pattern of [SIDE_EFFECT, DYNAMIC, REQUIRE]) {
    for (const match of code.matchAll(pattern)) {
      const spec = match[1]
      if (spec !== undefined) found.add(spec)
    }
  }

  return [...found]
}
