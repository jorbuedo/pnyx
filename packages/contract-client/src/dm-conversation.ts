// The name a pair of identities agree on for their conversation.
//
// Shared by the client, which derives it to address a thread, and the content service, which
// *verifies* it: a conversation id is a hash of its two participants, so re-deriving it from the
// authenticated sender and the named recipient proves membership with no lookup and no membership
// table. That check is the whole of the service's delivery authorisation — see
// `docs/ABUSE_MITIGATION.md` §5 for the defect it closes.
//
// ⚠️ It lives here rather than in either consumer because the two run on different runtimes (React
// Native and a Cloudflare Worker) and a second copy of a protocol derivation is a fork waiting to
// happen: the client would keep addressing threads the service had started refusing.
import {sha256} from '@noble/hashes/sha2.js'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Deterministic conversation id for a pair of `pnyx_id`s, order-independent so both clients agree
 * without a round-trip: `sha256("pnyx:dm:conv:v1|" ‖ lo ‖ "|" ‖ hi)` over the lexicographically
 * sorted pair, hex-encoded (it is a D1 primary key and a URL path segment).
 *
 * `|` is a safe separator because bech32 cannot contain it, so no two distinct pairs encode to the
 * same input. Both ids must be in canonical (lower-case) form — `classifyPeerInput` re-encodes what
 * the user typed for exactly this reason, since the sort is over strings, not bytes. The service
 * gets canonicality for free: a JWT subject is the canonical spelling or login refused it.
 *
 * ⚠️ **Two parties, by construction.** A group conversation has no pair to sort, so a third
 * participant would need a different naming scheme — and the membership check built on this would
 * have to become a real lookup rather than a re-derivation.
 */
export const conversationId = (idA: string, idB: string): string => {
  const [lo, hi] = idA <= idB ? [idA, idB] : [idB, idA]
  return toHex(sha256(utf8(`pnyx:dm:conv:v1|${lo}|${hi}`)))
}

/**
 * Whether `convId` names the conversation between exactly these two identities.
 *
 * The service's delivery gate. A caller may only write into the thread it shares with the recipient
 * it names, which makes every stored row attributable to the pair whose id it sits under.
 */
export const isConversationBetween = (convId: string, idA: string, idB: string): boolean =>
  convId === conversationId(idA, idB)
