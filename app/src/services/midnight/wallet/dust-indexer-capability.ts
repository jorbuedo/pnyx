/**
 * Which shape of `dustGenerations` an indexer serves.
 *
 * ⚠️ **Midnight's networks are the same indexer at different versions, and preview runs ahead.**
 * Introspected 2026-08-27: preview's subscription set is a strict superset of preprod's — 13 against
 * 9, the extras being the USDM bridge surface and `contractEvents` — which is what a newer build
 * looks like rather than a differently-configured deployment. The one breaking change rides in that
 * same build:
 *
 * | | preprod / mainnet | preview |
 * |---|---|---|
 * | `dustGenerations` | `dustAddress!, startIndex: Int!, endIndex: Int!` | `dustAddress!, blockHash: HexEncoded!, dtimeCutoffHeight: Int!` |
 *
 * All three preview arguments are required, so there is no index range left to ask for: index-range
 * paging was replaced by a block anchor plus a dtime cutoff, not extended. **Both are now served** —
 * `./dust-generations-query.ts` names the range for whichever shape this probe reports.
 *
 * **Why this is a capability and not a network name.** Because it is a rollout, preprod *will* get
 * the newer shape. A `network === 'preview'` branch would keep sending the old query to a server that
 * had stopped accepting it, and the failure would arrive on the day of somebody else's deploy. Asking
 * the endpoint what it takes means each network works on whatever it is running today and fixes
 * itself as the change is pushed up — and the branch we no longer need becomes dead code we delete on
 * our own schedule.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../../../logger'

const ORIGIN = 'dust-indexer-capability'

export type DustGenerationsShape =
  /** `dustAddress, startIndex, endIndex` — what the sync's index-range paging is written against. */
  | {readonly kind: 'index-range'}
  /** `dustAddress, blockHash, dtimeCutoffHeight` — preview's, as of 2026-08-27. */
  | {readonly kind: 'block-anchored'}
  /**
   * Something else. Carried with the argument names the server actually declared, because that is
   * the whole diagnosis: today's failure was legible only because the server named the arguments it
   * wanted, and a shape we guessed at would have hidden that.
   */
  | {readonly kind: 'unrecognised'; readonly args: readonly string[]}

/**
 * Classify by argument names — order-independent, and ignoring extras.
 *
 * Extras are ignored on purpose: an added *optional* argument is the ordinary way this API grows,
 * and refusing over one would turn a compatible server into an outage. A missing required argument
 * is the opposite, and shows up as neither shape matching.
 */
export const dustGenerationsShapeOf = (argNames: readonly string[]): DustGenerationsShape => {
  const args = new Set(argNames)
  const has = (...names: readonly string[]): boolean => names.every((n) => args.has(n))
  if (has('dustAddress', 'startIndex', 'endIndex')) return {kind: 'index-range'}
  if (has('dustAddress', 'blockHash', 'dtimeCutoffHeight')) return {kind: 'block-anchored'}
  return {kind: 'unrecognised', args: [...argNames].sort()}
}

/**
 * What we can say about a shape we do not implement, for a person reading a log or an error.
 *
 * ⚠️ Takes only the unrecognised shape, because both named shapes are now served — see
 * `./dust-generations-query.ts`. Widening it back would let a caller report an implemented shape as
 * unsupported, which is what this said about `block-anchored` until the port landed.
 */
export const unsupportedShapeReason = (shape: Extract<DustGenerationsShape, {kind: 'unrecognised'}>): string =>
  `this indexer's \`dustGenerations\` takes arguments this wallet does not recognise: ${shape.args.join(', ')}`

type IntrospectionResponse = {
  readonly __schema?: {
    readonly subscriptionType?: {
      readonly fields?: readonly {readonly name?: unknown; readonly args?: readonly {readonly name?: unknown}[]}[]
    } | null
  } | null
}

/**
 * Argument names of `dustGenerations` in an introspection response, or `null` when the field is
 * absent — which is not the same as an unrecognised shape and must not be reported as one.
 */
export const dustGenerationsArgsFrom = (data: IntrospectionResponse): readonly string[] | null => {
  const fields = data.__schema?.subscriptionType?.fields
  if (fields === undefined || fields === null) return null
  const field = fields.find((f) => f.name === 'dustGenerations')
  if (field === undefined) return null
  return (field.args ?? []).flatMap((a) => (typeof a.name === 'string' ? [a.name] : []))
}

/**
 * Per-endpoint cache. Keyed by URL rather than by network, because the URL is what was asked and two
 * networks could be pointed at one host during a migration.
 *
 * ⚠️ Held for the process, not persisted. A server upgraded under a running app keeps serving the
 * shape we probed until the next launch — acceptable, because the alternative is an introspection
 * round trip on every sync, and a wrong shape fails loudly rather than silently.
 */
const cache = new Map<string, DustGenerationsShape>()

/** Forget what was probed — network switch, tests. */
export const clearDustCapabilityCache = (): void => cache.clear()

/**
 * The shape this indexer serves, probed once and remembered.
 *
 * `probe` is injected so the decision is testable without a server; production passes the module's
 * own GraphQL POST.
 */
export const dustGenerationsShapeFor = (
  indexerUrl: string,
  probe: (url: string) => Effect.Effect<IntrospectionResponse, unknown>,
): Effect.Effect<DustGenerationsShape | null, never> =>
  Effect.gen(function* () {
    const cached = cache.get(indexerUrl)
    if (cached !== undefined) return cached
    const answered = yield* Effect.either(probe(indexerUrl))
    if (answered._tag === 'Left') {
      // ⚠️ Not cached, and not an unrecognised shape. "We could not ask" and "it answered something
      // we do not implement" are different facts, and caching the first would pin a transient outage
      // for the life of the process.
      logger.warn('could not introspect the indexer for its dustGenerations shape', {
        origin: ORIGIN,
        indexerUrl,
        error: String(answered.left),
      })
      return null
    }
    const args = dustGenerationsArgsFrom(answered.right)
    if (args === null) {
      logger.warn('this indexer declares no dustGenerations subscription', {origin: ORIGIN, indexerUrl})
      return null
    }
    const shape = dustGenerationsShapeOf(args)
    cache.set(indexerUrl, shape)
    logger.info('probed the indexer’s dustGenerations shape', {origin: ORIGIN, indexerUrl, shape: shape.kind, args})
    return shape
  })
