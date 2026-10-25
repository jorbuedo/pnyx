/**
 * Refuse an argument no tool declared, because every tool's schema already says so.
 *
 * ⚠️ **This was advertised and not enforced, and it silently dropped data.** Every descriptor in the
 * catalogue carries `additionalProperties: false`, and nothing checked it: the hand-written parser for
 * each tool reads the keys it knows and ignores the rest. Found by sending
 * `cardano_buildCoFundedSend` a `memo` — a field that tool does not have, though `cardano_buildTransfer`
 * does. The call was accepted, the transaction was co-signed by two wallets and landed on preprod
 * (block 5,105,284) carrying no metadata at all. An agent that passes a memo is entitled to conclude
 * the transaction has one; this one would have told a person their message was on chain when the chain
 * had never seen it.
 *
 * A typo is the same story with a smaller blast radius: `submit: true` misspelt is a transaction nobody
 * approves and an agent that thinks one is pending.
 *
 * The check is recursive because the nested schemas make the same promise — an output's `lovelace` or a
 * source's `scope` misspelt inside an array element would otherwise pass in exactly the same way.
 *
 * @module
 */

type Schema = {
  readonly type?: unknown
  readonly properties?: Readonly<Record<string, unknown>>
  readonly additionalProperties?: unknown
  readonly items?: unknown
}

const asSchema = (value: unknown): Schema | undefined =>
  typeof value === 'object' && value !== null ? (value as Schema) : undefined

/**
 * Every path in `args` the schema does not declare, in the order they were found.
 *
 * Empty when the arguments fit — including when the schema declares nothing about a subtree, since a
 * schema that does not say `additionalProperties: false` has not promised anything to enforce.
 */
export const unknownArgPaths = (schema: unknown, args: unknown, path = ''): readonly string[] => {
  const shape = asSchema(schema)
  if (shape === undefined) return []
  const items = asSchema(shape.items)
  if (items !== undefined && Array.isArray(args)) {
    return args.flatMap((entry, i) => unknownArgPaths(items, entry, `${path}[${i}]`))
  }
  if (shape.properties === undefined) return []
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return []
  const declared = shape.properties
  const found: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const child = declared[key]
    if (child === undefined) {
      // Only when the schema actually forbids extras. Nothing here invents a rule a tool did not state.
      if (shape.additionalProperties === false) found.push(path === '' ? key : `${path}.${key}`)
      continue
    }
    found.push(...unknownArgPaths(child, value, path === '' ? key : `${path}.${key}`))
  }
  return found
}

/**
 * The sentence an agent gets, or `undefined` when the arguments fit.
 *
 * ⚠️ **It names the tool's own fields.** "unknown argument" alone leaves a model guessing, and guessing
 * is what produced the wrong field in the first place — a memo passed to the one builder that has no
 * memo. Listing what the tool does take turns a refusal into the correction.
 */
export const unknownArgRefusal = (
  toolName: string,
  schema: unknown,
  args: unknown,
  scopeArgument: string,
): string | undefined => {
  const unknown = unknownArgPaths(schema, args)
  if (unknown.length === 0) return undefined
  const shape = asSchema(schema)
  const accepted = Object.keys(shape?.properties ?? {})
    .filter((key) => key !== scopeArgument)
    .join(', ')
  return (
    `${toolName} does not take ${unknown.map((u) => `\`${u}\``).join(', ')}. ` +
    `It takes ${accepted === '' ? `only \`${scopeArgument}\`` : accepted}. ` +
    'Nothing was built or sent — the arguments were refused rather than partly applied, because a field ' +
    'this tool ignores is one you would have no way to know had been dropped.'
  )
}
