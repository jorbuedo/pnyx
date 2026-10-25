/**
 * The CIP-1854 script *template* — a native script whose key-hash leaves are
 * replaced by co-signer tags.
 *
 * A shared wallet is defined by a template plus a tag→account-xpub map, not by a
 * list of key hashes. That is what makes the wallet reproducible by other
 * software: given the same template and the same xpubs, every participant's
 * wallet derives byte-identical addresses at every index. A flat roster of
 * hashes pins the wallet to one address and cannot be imported anywhere else.
 *
 * The shape mirrors `ScriptWallet.NativeSpec` in the Cardano rail (the
 * CIP-106 requirements type) with one addition — the `cosigner` leaf. Resolving
 * every tag to a key hash turns a template into a `NativeSpec`; see `derive.ts`.
 *
 * @module
 */

/** A co-signer's position in the template. Canonically `cosigner#0`, `cosigner#1`, … */
export type CoSignerTag = string

export type ScriptTemplate =
  | {readonly kind: 'cosigner'; readonly tag: CoSignerTag}
  | {readonly kind: 'all'; readonly scripts: readonly ScriptTemplate[]}
  | {readonly kind: 'any'; readonly scripts: readonly ScriptTemplate[]}
  | {readonly kind: 'atLeast'; readonly n: number; readonly scripts: readonly ScriptTemplate[]}
  /** Valid from this slot onward (CIP-1854 `from`). */
  | {readonly kind: 'invalidBefore'; readonly slot: bigint}
  /** Valid only before this slot (CIP-1854 `until`). */
  | {readonly kind: 'invalidHereafter'; readonly slot: bigint}

/** The canonical tag for the co-signer at `index`. */
export const tagAt = (index: number): CoSignerTag => `cosigner#${index}`

/** Every tag the template references, in first-appearance order, deduped. */
export const templateTags = (template: ScriptTemplate): readonly CoSignerTag[] => {
  const seen = new Set<CoSignerTag>()
  const out: CoSignerTag[] = []
  const walk = (node: ScriptTemplate): void => {
    switch (node.kind) {
      case 'cosigner':
        if (!seen.has(node.tag)) {
          seen.add(node.tag)
          out.push(node.tag)
        }
        return
      case 'all':
      case 'any':
      case 'atLeast':
        for (const child of node.scripts) walk(child)
        return
      case 'invalidBefore':
      case 'invalidHereafter':
        return
    }
  }
  walk(template)
  return out
}

/** True when any branch constrains validity by slot — the tx needs a matching validity interval. */
export const hasTimeLock = (template: ScriptTemplate): boolean => {
  switch (template.kind) {
    case 'invalidBefore':
    case 'invalidHereafter':
      return true
    case 'all':
    case 'any':
    case 'atLeast':
      return template.scripts.some(hasTimeLock)
    case 'cosigner':
      return false
  }
}

/**
 * The validity interval a template demands, as the tightest bounds across every
 * branch. `null` on either side means unconstrained.
 *
 * Intersecting rather than collecting is deliberate: a transaction carries one
 * interval, so a template with two `from` bounds must satisfy the later one.
 * Note this is exact only for `all`; under `any` an intersection is stricter
 * than necessary, which errs toward a transaction that certainly validates.
 */
export const validityBounds = (
  template: ScriptTemplate,
): {readonly from: bigint | null; readonly until: bigint | null} => {
  let from: bigint | null = null
  let until: bigint | null = null
  const walk = (node: ScriptTemplate): void => {
    switch (node.kind) {
      case 'invalidBefore':
        from = from === null || node.slot > from ? node.slot : from
        return
      case 'invalidHereafter':
        until = until === null || node.slot < until ? node.slot : until
        return
      case 'all':
      case 'any':
      case 'atLeast':
        for (const child of node.scripts) walk(child)
        return
      case 'cosigner':
        return
    }
  }
  walk(template)
  return {from, until}
}

export type TemplateProblem =
  | {readonly kind: 'empty-branch'}
  | {readonly kind: 'threshold-out-of-range'; readonly n: number; readonly available: number}
  | {readonly kind: 'unknown-tag'; readonly tag: CoSignerTag}
  | {readonly kind: 'no-signers'}
  | {readonly kind: 'inverted-time-lock'; readonly from: bigint; readonly until: bigint}

/**
 * Structural problems that would make the template unsatisfiable. Returned as a
 * list rather than thrown, so the editor can show every issue at once.
 *
 * `knownTags` is the roster the template is checked against — a tag with no
 * co-signer behind it compiles to nothing and would silently weaken the script.
 */
export const validateTemplate = (
  template: ScriptTemplate,
  knownTags: readonly CoSignerTag[],
): readonly TemplateProblem[] => {
  const known = new Set(knownTags)
  const problems: TemplateProblem[] = []
  const walk = (node: ScriptTemplate): void => {
    switch (node.kind) {
      case 'cosigner':
        if (!known.has(node.tag)) problems.push({kind: 'unknown-tag', tag: node.tag})
        return
      case 'all':
      case 'any':
        if (node.scripts.length === 0) problems.push({kind: 'empty-branch'})
        for (const child of node.scripts) walk(child)
        return
      case 'atLeast':
        if (node.scripts.length === 0) problems.push({kind: 'empty-branch'})
        if (!Number.isInteger(node.n) || node.n < 1 || node.n > node.scripts.length) {
          problems.push({kind: 'threshold-out-of-range', n: node.n, available: node.scripts.length})
        }
        for (const child of node.scripts) walk(child)
        return
      case 'invalidBefore':
      case 'invalidHereafter':
        return
    }
  }
  walk(template)
  if (templateTags(template).length === 0) problems.push({kind: 'no-signers'})
  const {from, until} = validityBounds(template)
  if (from !== null && until !== null && from >= until) problems.push({kind: 'inverted-time-lock', from, until})
  return problems
}

/**
 * How many co-signers must sign, and how many the template names.
 *
 * `required` counts distinct tags, so a tag appearing twice under `all` is one
 * signature. Time-lock leaves satisfy themselves and never count toward either
 * figure. Under `any`, one signer suffices regardless of how many are named.
 */
export const signPolicy = (template: ScriptTemplate): {readonly required: number; readonly total: number} => {
  const total = templateTags(template).length
  const requiredOf = (node: ScriptTemplate): number => {
    switch (node.kind) {
      case 'cosigner':
        return 1
      case 'all':
        return node.scripts.reduce((sum, child) => sum + requiredOf(child), 0)
      case 'any': {
        const costs = node.scripts.map(requiredOf).filter((c) => c > 0)
        return costs.length === 0 ? 0 : Math.min(...costs)
      }
      case 'atLeast': {
        // The n cheapest branches — `at_least 2 [a, all[b,c], d]` needs 2, not 3.
        const costs = node.scripts.map(requiredOf).sort((a, b) => a - b)
        return costs.slice(0, node.n).reduce((sum, c) => sum + c, 0)
      }
      case 'invalidBefore':
      case 'invalidHereafter':
        return 0
    }
  }
  return {required: requiredOf(template), total}
}

/**
 * Whether the tags that have signed satisfy the template.
 *
 * Evaluated over the structure rather than by counting against a threshold: a
 * count is only correct for a flat `at_least`, and would wrongly clear a
 * transaction under a nested or time-locked template.
 */
export const isSatisfied = (template: ScriptTemplate, signedTags: ReadonlySet<CoSignerTag>): boolean => {
  switch (template.kind) {
    case 'cosigner':
      return signedTags.has(template.tag)
    case 'all':
      return template.scripts.every((child) => isSatisfied(child, signedTags))
    case 'any':
      return template.scripts.some((child) => isSatisfied(child, signedTags))
    case 'atLeast':
      return template.scripts.filter((child) => isSatisfied(child, signedTags)).length >= template.n
    // A time lock is satisfied by the transaction's validity interval, which the
    // builder sets from `validityBounds`; it is never satisfied by a signature.
    case 'invalidBefore':
    case 'invalidHereafter':
      return true
  }
}

/** The flat quorum shapes the create screen offers, as templates over `tags`. */
export const flatTemplate = (
  quorum: {readonly kind: 'all'} | {readonly kind: 'any'} | {readonly kind: 'atLeast'; readonly n: number},
  tags: readonly CoSignerTag[],
): ScriptTemplate => {
  const scripts = tags.map((tag): ScriptTemplate => ({kind: 'cosigner', tag}))
  return quorum.kind === 'atLeast' ? {kind: 'atLeast', n: quorum.n, scripts} : {kind: quorum.kind, scripts}
}

/** Wrap a template in slot bounds. Omitting both returns it unchanged. */
export const withTimeLock = (
  template: ScriptTemplate,
  bounds: {readonly from?: bigint; readonly until?: bigint},
): ScriptTemplate => {
  const locks: ScriptTemplate[] = []
  if (bounds.from !== undefined) locks.push({kind: 'invalidBefore', slot: bounds.from})
  if (bounds.until !== undefined) locks.push({kind: 'invalidHereafter', slot: bounds.until})
  return locks.length === 0 ? template : {kind: 'all', scripts: [template, ...locks]}
}

/**
 * A template as JSON.
 *
 * `bigint` slots are decimal strings because `JSON.stringify` refuses a bigint,
 * and `number` would silently lose precision past 2^53 — slots are ledger-wide
 * counters. This shape is the wire *and* the stored form: the registry writes it
 * to storage and a definition link carries it between participants, and two
 * spellings of the same structure would be two things to keep in step.
 */
export type TemplateJson =
  | {readonly kind: 'cosigner'; readonly tag: string}
  | {readonly kind: 'all' | 'any'; readonly scripts: readonly TemplateJson[]}
  | {readonly kind: 'atLeast'; readonly n: number; readonly scripts: readonly TemplateJson[]}
  | {readonly kind: 'invalidBefore' | 'invalidHereafter'; readonly slot: string}

export const templateToJson = (t: ScriptTemplate): TemplateJson => {
  switch (t.kind) {
    case 'cosigner':
      return {kind: 'cosigner', tag: t.tag}
    case 'all':
    case 'any':
      return {kind: t.kind, scripts: t.scripts.map(templateToJson)}
    case 'atLeast':
      return {kind: 'atLeast', n: t.n, scripts: t.scripts.map(templateToJson)}
    case 'invalidBefore':
    case 'invalidHereafter':
      return {kind: t.kind, slot: t.slot.toString()}
  }
}

/** Decimal digits only: `BigInt('0x10')` and `BigInt(' 1 ')` both succeed and would shift a lock. */
const parseSlot = (value: unknown): bigint | null =>
  typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseChildren = (value: unknown): readonly ScriptTemplate[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  const parsed = value.map(templateFromJson)
  return parsed.some((child) => child === null) ? null : (parsed as readonly ScriptTemplate[])
}

/**
 * Read a template back, validating as it goes — `null` for anything that is not
 * one.
 *
 * Validating rather than trusting, because both readers need it for different
 * reasons: a definition link arrives from another device and is untrusted by
 * construction, and a stored record can have been half-written or hand-edited.
 * A template that revived into the wrong shape compiles to a script with the
 * wrong spending rule, which is the one failure nobody notices until funds are
 * in it.
 */
export const templateFromJson = (value: unknown): ScriptTemplate | null => {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'cosigner':
      return typeof value.tag === 'string' && value.tag !== '' ? {kind: 'cosigner', tag: value.tag} : null
    case 'all':
    case 'any': {
      const scripts = parseChildren(value.scripts)
      return scripts === null ? null : {kind: value.kind, scripts}
    }
    case 'atLeast': {
      if (typeof value.n !== 'number' || !Number.isInteger(value.n) || value.n < 1) return null
      const scripts = parseChildren(value.scripts)
      // A quorum larger than the branch it applies to can never be met.
      return scripts === null || value.n > scripts.length ? null : {kind: 'atLeast', n: value.n, scripts}
    }
    case 'invalidBefore':
    case 'invalidHereafter': {
      const slot = parseSlot(value.slot)
      return slot === null ? null : {kind: value.kind, slot}
    }
    default:
      return null
  }
}
