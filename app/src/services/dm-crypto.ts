/**
 * Conversation naming for direct messages.
 *
 * Pure protocol logic — no React, no RN, no network — so it is unit-tested directly.
 *
 * This module used to carry the phase-1 DM key agreement as well. That was **static-static ECDH**:
 * one shared secret per pair for all time, so leaking a seed decrypted that pair's entire history.
 * The dev lead reversed the plan's v1 trade-off on 2026-07-30 (**"ship forward secrecy"**), MLS won
 * the transport decision, and `dm-mls.ts` has owned key agreement and message sealing since. The
 * superseded `sealMessage` / `openMessage` / `deriveDmKeypair` were deleted 2026-07-31 rather than
 * left as an unused second crypto path next to the real one — git history has them if the
 * derivation is ever wanted again.
 *
 * What survives is the part MLS does not replace: a thread still needs a deterministic name that
 * both sides compute without talking to each other.
 *
 * @module
 */

/**
 * Re-exported from `@pnyx/contract-client/dm-conversation`, which is where it moved on 2026-09-01.
 *
 * ⚠️ **The content service verifies this derivation**, so it cannot live in the app: it re-derives
 * the id from the authenticated sender and the named recipient to prove membership without a
 * lookup. Two copies across two runtimes would drift, and the drift would present as the client
 * addressing threads the service had begun refusing. Kept exported here so existing callers and
 * their tests do not move.
 */
export {conversationId, isConversationBetween} from '@pnyx/contract-client/dm-conversation'
