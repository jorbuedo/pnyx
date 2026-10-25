/**
 * Terms of Service loader.
 *
 * Written to the subset `utils/markdown.tsx` renders; see `legal-markdown.test.ts`.
 *
 * The document speaks as Pnyx and names no legal entity, registered address or governing law:
 * a product decision taken for the open-early-access launch, enforced by `legal-markdown.test.ts`.
 *
 * **Open questions for counsel, deliberately kept out of the user-facing text:**
 *
 * - Governing law and venue. The app ships worldwide.
 * - Whether arbitration and class-action-waiver terms are used, and whether they survive EU/UK
 *   consumer protections.
 * - Liability cap and its carve-outs. Section 12 currently disclaims broadly with the
 *   non-excludable carve-out, but names no cap.
 * - DSA notice-and-action: our own takedown duties, the reporting route, and the appeal path.
 *   Section 7 says communities moderate themselves, which does not discharge our obligations.
 * - Minimum age, kept consistent with the Privacy Policy and the store listings.
 * - The licence Pnyx itself is released under, and trade-mark use. Section 13 covers only the
 *   third-party components.
 * - Sanctions and prohibited-jurisdiction screening, if any is required of a non-custodial app.
 *
 * @module
 */

import {loadTextAsset} from '../loadTextAsset'

const asset: string = require('./en-US.md')

// Legally binding; always shown in English regardless of app locale.
export const loadTOS = async (): Promise<string> => loadTextAsset(asset)
