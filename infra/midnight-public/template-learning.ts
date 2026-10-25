/**
 * Whether a request the indexer made teaches the read-ahead proxy a template worth prefetching.
 *
 * Extracted from `readahead-proxy.ts` so it can be tested at all: that module calls `Bun.serve()`
 * and installs four timers at import, so importing `learn` from it started a server on port 9944.
 * The decision is pure and the caller owns the mutation and the logging.
 *
 * A template is fired against *every* prefetched block for the rest of the run, so it only pays if
 * its arguments are the same for every block. `MidnightRuntimeApi_get_contract_state` takes a
 * contract address, so each new contract taught the proxy another call it would make forever and
 * hit almost never: 781 accumulated on the 2026-10-11 mainnet walk, which turned each block into
 * ~790 upstream calls and ~790 cached answers against the "~10" that `MAX_WARM = DEPTH * 8` is
 * sized on. A cache bounded by block count but not by bytes is how that became a 21 GB footprint.
 */

export type TemplateKind = 'call' | 'storage'

export type TemplateDecision =
  /** Not a per-block request we know how to prefetch. */
  | {verdict: 'not-a-template'}
  /** Parameterised by a block we have never seen, so we cannot tell what it is a template of. */
  | {verdict: 'unknown-block'}
  /** Parameterised by an entity rather than a block: a template of this can never pay. */
  | {verdict: 'entity-keyed'; call: string}
  | {verdict: 'already-known'; kind: TemplateKind; template: string}
  /** The backstop against the next per-entity method, whatever it turns out to be called. */
  | {verdict: 'cap-reached'; kind: TemplateKind; template: string; cap: number}
  | {verdict: 'learn'; kind: TemplateKind; template: string}

export const ENTITY_KEYED_CALLS: ReadonlySet<string> = new Set(['MidnightRuntimeApi_get_contract_state'])

export const MAX_LEARNED_TEMPLATES = 32

export type TemplateState = {
  knowsBlock: (hash: string) => boolean
  callTemplates: ReadonlySet<string>
  storageTemplates: ReadonlySet<string>
}

export const decideTemplate = (method: string, params: unknown, state: TemplateState): TemplateDecision => {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return {verdict: 'not-a-template'}
  if (!state.knowsBlock(params[0])) return {verdict: 'unknown-block'}

  const kind: TemplateKind | undefined =
    method === 'archive_v1_call' && params.length === 3
      ? 'call'
      : method === 'archive_v1_storage' && params.length === 3
        ? 'storage'
        : undefined
  if (kind === undefined) return {verdict: 'not-a-template'}

  if (kind === 'call' && typeof params[1] === 'string' && ENTITY_KEYED_CALLS.has(params[1])) {
    return {verdict: 'entity-keyed', call: params[1]}
  }

  const known = kind === 'call' ? state.callTemplates : state.storageTemplates
  const template = JSON.stringify([params[1], params[2]])
  if (known.has(template)) return {verdict: 'already-known', kind, template}
  if (known.size >= MAX_LEARNED_TEMPLATES) return {verdict: 'cap-reached', kind, template, cap: known.size}
  return {verdict: 'learn', kind, template}
}
