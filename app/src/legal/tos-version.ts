/**
 * Pinned Terms of Service / Privacy Policy timestamp.
 *
 * Bump when the wording changes — `useLegalAgreement` re-prompts users whose
 * stored acceptance (`acceptedAt`, a `Date.now()` at accept time) is older than
 * this constant.
 *
 * This is the in-app *rollout cutoff*, NOT the document's printed "Last Updated"
 * date. To actually re-prompt existing users it must be LATER than their prior
 * acceptance — i.e. set it to ~now when the new wording ships, not to the date
 * on the document. (A doc-date earlier than current acceptances re-prompts nobody.)
 *
 * Use ms-since-epoch (UTC). Add a comment with the human date so the file
 * stays auditable.
 *
 * Invariant: the value is monotonically non-decreasing across releases. A
 * downward edit would re-show the screen to users who already accepted.
 *
 * @module
 */

// 2026-05-01T00:00:00Z — initial pinned ToS.
// 2026-06-01T00:00:00Z — upstream Terms of Use rollout (doc Last Updated: May 2026).
// 2026-06-17T00:00:00Z — upstream Terms of Use rollout (doc Last Updated: June 2026).
// 2026-09-12T00:00:00Z — first substantive ToS + Privacy Policy (doc Last Updated: September 2026).
//   The July placeholders were replaced with text grounded in what the app actually does, including
//   the non-custodial and on-chain-permanence disclosures, so every prior acceptance is stale.
//   Dated 09-12 rather than 09-13 because UTC had not yet rolled over when this shipped, and the
//   value must stay in the past — `tos-version.test.ts` asserts exactly that.
// 2026-10-01T00:00:00Z — open-early-access rewrite (doc Last Updated: October 2026).
//   The operating-entity name, the registered-address placeholder and the "DRAFT — pending legal
//   review" banner were removed; both documents now speak as Pnyx and carry an early-access
//   section saying core functionality may change drastically on feedback.
export const TOS_PINNED_AT = Date.UTC(2026, 9, 1)
