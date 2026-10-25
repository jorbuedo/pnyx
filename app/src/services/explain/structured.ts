/**
 * The constrained-decoding half of the explain rail (Phase 14 item 38).
 *
 * ### Why this exists
 *
 * A free-text explanation cannot be checked. On a Pixel 10 the model ignored a
 * mandatory prompt rule; on iOS it went further and inverted the direction of funds —
 * told, in the facts, that *the owner received 5 ADA*, it wrote "your wallet
 * successfully transferred 4.827195 ADA to the address you provided", inventing the
 * amount and dropping the SAFETY line in the same breath. No wording fixed it, because
 * the failure is not a wording problem.
 *
 * Constrained decoding changes what is possible to check, not how obedient the model
 * is. `direction` comes back from a closed set, so this module can compare it against
 * what the facts actually say and **reject** the answer when they disagree. The prose
 * fields are still the model's, and still unverifiable — but the one claim that decides
 * whether the explanation is dangerously wrong is no longer taken on trust.
 *
 * The division of labour: the model writes the words, this module guarantees the facts.
 * Anything that must hold is enforced here, never asked for in the prompt.
 *
 * @module
 */

import type {ModelSchema} from '@pnyx/model-native'
import type {ExplainFacts} from './facts'
import {isFeeOnly} from './facts'
import {sanitizeExplanation} from './sanitize'

/**
 * What the transaction did to the owner, as a closed set.
 *
 * Deliberately coarse. A finer vocabulary would be more descriptive and less
 * checkable, and checkability is the entire reason the field exists — every member
 * here is decidable from the facts without judgement.
 */
export type ExplainDirection = 'sent' | 'received' | 'feeOnly' | 'mixed'

const DIRECTIONS: readonly ExplainDirection[] = ['sent', 'received', 'feeOnly', 'mixed']

/** The shape the decoder is pinned to. */
export const explainSchema = (): ModelSchema => ({
  type: 'object',
  name: 'Explanation',
  description: 'A plain-language explanation of one Cardano transaction for its owner.',
  properties: [
    {
      name: 'direction',
      description: 'What happened to the owner: sent, received, feeOnly, or mixed.',
      schema: {type: 'enum', values: [...DIRECTIONS]},
    },
    {
      name: 'summary',
      description: 'One plain sentence: what this transaction accomplished for the owner.',
      schema: {type: 'string'},
    },
    {
      name: 'cost',
      description:
        'A complete sentence naming the network fee and saying it is already part of the total, not an extra charge. Not a bare amount.',
      schema: {type: 'string'},
    },
    {
      name: 'safety',
      description: 'A complete sentence restating the SAFETY line in plain words. Empty when there is no SAFETY line.',
      schema: {type: 'string'},
      optional: true,
    },
  ],
})

/**
 * What the facts say the direction is — the claim the model has to match.
 *
 * Mirrors how `buildExplainPrompt` renders the owner's section, and shares `isFeeOnly`
 * with it, so the two cannot disagree about the fee-only shape. An empty delta set is
 * fee-only for the same reason it is there: the prompt states "NO funds are transferred".
 */
export const expectedDirectionOf = (facts: ExplainFacts): ExplainDirection => {
  if (facts.ownDeltas.length === 0 || isFeeOnly(facts)) return 'feeOnly'
  let out = false
  let inbound = false
  for (const delta of facts.ownDeltas) {
    if (delta.delta.startsWith('-')) out = true
    else inbound = true
  }
  if (out && inbound) return 'mixed'
  return out ? 'sent' : 'received'
}

export type StructuredExplanation =
  | {
      readonly ok: true
      readonly text: string
      /**
       * The model wrote a warning the facts do not support, and it was discarded.
       *
       * Worth counting: it is the failure mode this schema *introduced*. Giving the
       * model a named safety slot makes it want to fill one.
       */
      readonly droppedUnfoundedSafety: boolean
    }
  | {readonly ok: false; readonly reason: StructuredRejection}

/**
 * Why an answer was thrown away.
 *
 * Kept as a union rather than a string so the caller can log which check fired: these
 * counts are the evidence for whether constrained decoding actually helped, and a free
 * string would make them ungroupable.
 */
export type StructuredRejection =
  | 'malformed'
  | 'direction-missing'
  | 'direction-mismatch'
  | 'safety-missing'
  | 'summary-empty'

/**
 * Terminal punctuation, added when the model left it off.
 *
 * Per-field generation loses the run-on protection prose had: the first real iOS run
 * returned the safety line without a full stop, and joining the fields produced
 * "…is not known You received 5.000000 ADA." Enforced rather than requested, for the
 * same reason everything else here is.
 */
const asSentence = (text: string): string => (text.length === 0 || /[.!?…]$/.test(text) ? text : `${text}.`)

const stringField = (source: Record<string, unknown>, key: string): string => {
  const value = source[key]
  return typeof value === 'string' ? asSentence(sanitizeExplanation(value)) : ''
}

/**
 * Check a decoded answer against the facts, and compose the text to render.
 *
 * Fails closed. A rejected answer does **not** fall back to the free-text path: the
 * text path shares the same model and the same facts, so it would reproduce the error
 * the check just caught, only unverifiably. Showing nothing is the correct outcome.
 */
export const composeStructuredExplanation = (
  raw: unknown,
  expectations: {readonly direction: ExplainDirection; readonly requiresSafety: boolean},
): StructuredExplanation => {
  if (typeof raw !== 'object' || raw === null) return {ok: false, reason: 'malformed'}
  const fields = raw as Record<string, unknown>

  const direction = fields.direction
  if (typeof direction !== 'string' || !DIRECTIONS.includes(direction as ExplainDirection)) {
    return {ok: false, reason: 'direction-missing'}
  }
  // The check the whole module is built around.
  if (direction !== expectations.direction) return {ok: false, reason: 'direction-mismatch'}

  const written = stringField(fields, 'safety')
  // The model dropped a mandatory SAFETY restatement on iOS with the rule in the prompt.
  // Requiring the field to be filled turns that from a hope into a postcondition.
  if (expectations.requiresSafety && written.length === 0) return {ok: false, reason: 'safety-missing'}

  // ...and the mirror, which the first real run needed. On a transaction with no SAFETY
  // line at all the model filled the slot anyway — "Do not send any more money to this
  // address. It is unknown who owns it, and you could lose your ADA." — inventing a
  // warning and giving financial advice the prompt forbids. An empty slot is an
  // invitation, so the field is only honoured when the facts put something in it.
  const droppedUnfoundedSafety = !expectations.requiresSafety && written.length > 0
  const safety = expectations.requiresSafety ? written : ''

  const summary = stringField(fields, 'summary')
  if (summary.length === 0) return {ok: false, reason: 'summary-empty'}

  const cost = stringField(fields, 'cost')
  // Safety leads, for the same reason it leads in the prompt: a warning read as a
  // footnote has already failed.
  return {
    ok: true,
    text: [safety, summary, cost].filter((s) => s.length > 0).join(' '),
    droppedUnfoundedSafety,
  }
}
