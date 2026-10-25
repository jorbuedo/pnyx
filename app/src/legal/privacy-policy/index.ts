/**
 * Privacy Policy loader.
 *
 * The document is written to the subset `utils/markdown.tsx` renders — no tables, one line per
 * list item, inline `**bold**` only. `legal-markdown.test.ts` enforces that; both rules exist
 * because both were broken in the first draft.
 *
 * **Open questions for counsel, deliberately kept out of the user-facing text.** They are real
 * gaps, not placeholders to delete:
 *
 * - Lawful basis under GDPR Art. 6 for each purpose (forum content, DM metadata, push tokens).
 * - Retention periods: forum content, DM ciphertext, DM delivery metadata, support mail.
 * - How an erasure request is answered for data on a public blockchain, which nobody can delete.
 *   Section 6 states the fact; the process is still undefined.
 * - International transfer mechanism — infrastructure and several third parties sit outside the EEA.
 * - Whether a DPO or an Art. 27 representative is required.
 * - Minimum age, and how it is enforced.
 * - CCPA/CPRA applicability.
 * - App Store and Play data-safety declarations must match this document. The Firebase push token
 *   is the one most often declared wrongly.
 * - A controller identity and a rights-request route. The document speaks as Pnyx and names no
 *   legal entity, registered address or mailbox, a product decision taken for the
 *   open-early-access launch; the in-app support community is the only contact route it gives,
 *   which is awkward for a GDPR request made through a public forum.
 *
 * @module
 */

import {loadTextAsset} from '../loadTextAsset'

const asset: string = require('./en-US.md')

// Legally binding; always shown in English regardless of app locale.
export const loadPrivacyPolicy = async (): Promise<string> => loadTextAsset(asset)
