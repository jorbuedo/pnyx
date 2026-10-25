/**
 * Deterministic clean-up of whatever the model returns.
 *
 * ### Why this is code and not another prompt rule
 *
 * The prompt already says "Never copy a label such as SAFETY: into your answer". The
 * model copied it anyway, on a real device, with that rule present in the input. A
 * ~3B model treats instructions as suggestions, so anything that MUST hold about the
 * output has to be enforced after the fact rather than requested before it.
 *
 * The labels stay in the prompt — they work, the model leads with safety because of
 * them. Only the leak into user-facing text is a defect, and that is fixable here
 * without weakening the input.
 *
 * @module
 */

/**
 * Section labels the prompt uses. A line that is exactly one of these, or begins with
 * one followed by a colon, is scaffolding rather than content.
 */
const LABELS = [
  'SAFETY',
  'FACTS',
  'OTHER PARTIES',
  "THE OWNER'S OWN WALLET",
  'WHAT THE TRANSACTION DID',
  'WHAT APPROVING ACTUALLY DOES',
  'UNTRUSTED',
  'UNTRUSTED TEXT',
] as const

const LABEL_PREFIX = new RegExp(
  `^\\s*(?:${LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:\\s*`,
  'i',
)

/**
 * Strip prompt scaffolding from a generated explanation.
 *
 * Conservative on purpose: only a label at the *start of a line*, followed by a colon,
 * is removed, and only for labels this prompt actually emits. Anything else the model
 * wrote is left alone — trimming output on a guess would be its own way of showing the
 * user something that was never said.
 */
export const sanitizeExplanation = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(LABEL_PREFIX, ''))
    .join('\n')
    // Collapse the blank line a stripped label leaves behind at the top.
    .replace(/^\s*\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
