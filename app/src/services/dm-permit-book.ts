/**
 * What this device knows about who may reach whom.
 *
 * Three parts, and they are not symmetric:
 *
 * - **held** — permits *we* were given, keyed by the peer who issued one. Presented on every
 *   delivery to them. Losing one is recoverable under an `open` policy (the service auto-issues a
 *   replacement) and not under `permit` (the peer has to grant again).
 * - **granted** — the id of the permit a *peer* is using to reach us, keyed by conversation. This is
 *   the only place that id is kept: the service stores no mapping from a permit to the pair it
 *   covers, which is what keeps muting from leaving a social graph behind
 *   (`docs/ABUSE_MITIGATION.md` §5). We learn it because the sender presents the permit on every
 *   delivery and the service puts it on the row we read.
 * - **issued** — invitations *we* minted. Also the only place they are kept, and for the same
 *   reason: issuing a permit writes nothing on the service, so an invitation this device forgets is
 *   a door that stays open until it expires.
 *
 * ⚠️ **`muted` is a mirror, not the truth.** The service decides whether a push fires; this is here
 * so the menu can render the right label without a round trip. If the two disagree the service
 * wins — and they can, because a mute made on another device is invisible until that device's
 * permit id is seen again.
 *
 * Pure: no storage, no network, no React. `dm-session` seals it; `dm-consent` drives it.
 *
 * @module
 */

/**
 * An invitation this device minted, and everything needed to use or withdraw it later.
 *
 * ⚠️ **This row is the only record the invitation exists.** A permit is a stateless signed token, so
 * issuing one writes nothing anywhere (`services/content/migrations/0006_dm_consent.sql` — there is
 * deliberately no permits table). Dropping it leaves a link that anyone holding can still convert,
 * for the whole of its 180-day life, with nobody able to name the id that would revoke it.
 */
export type DmIssuedInvite = {
  /** The permit id. What revoking names, and all the service ever stores about it. */
  readonly jti: string
  /** The shareable link. Kept whole so the invitation can be re-shared, not just withdrawn. */
  readonly link: string
  /** Seconds since the epoch, copied from the permit. */
  readonly expiresAt: number
  /** Seconds since the epoch. Shown, so several invitations can be told apart. */
  readonly createdAt: number
}

export type DmPermitBook = {
  /** Peer `pnyx_id` → the permit token they issued us. */
  readonly held: Readonly<Record<string, string>>
  /** Conversation id → the id of the permit the peer is reaching us with. */
  readonly granted: Readonly<Record<string, string>>
  /** Conversations muted from this device. */
  readonly muted: readonly string[]
  /**
   * Invitations minted from this device, newest first.
   *
   * Optional because books written before invitations were kept have no such field, and an absent
   * one means what it says: this device has issued none that it remembers.
   */
  readonly issued?: readonly DmIssuedInvite[]
}

export const EMPTY_PERMIT_BOOK: DmPermitBook = {held: {}, granted: {}, muted: [], issued: []}

/** The permit to present when writing to `peer`, if we hold one. */
export const heldPermitFor = (book: DmPermitBook, peer: string): string | undefined => book.held[peer]

/** The permit id to revoke when muting `convId`, if we have seen one. */
export const grantedPermitFor = (book: DmPermitBook, convId: string): string | undefined => book.granted[convId]

export const isConversationMuted = (book: DmPermitBook, convId: string): boolean => book.muted.includes(convId)

/**
 * Record a permit a peer issued us.
 *
 * Last write wins: a re-grant supersedes, and the service treats a permit minted after a revocation
 * as a deliberate unmute, so keeping the older one would silently stay muted.
 */
export const rememberHeldPermit = (book: DmPermitBook, peer: string, token: string): DmPermitBook => ({
  ...book,
  held: {...book.held, [peer]: token},
})

/**
 * Record the permit id a peer is reaching us with.
 *
 * ⚠️ **A new id for a conversation clears its mute.** Under an `open` policy a sender who lost their
 * permit is auto-issued a fresh one, and the old revocation does not cover it — so the mirror has to
 * follow, or the menu would offer "unmute" for a conversation that is already buzzing.
 */
export const rememberGrantedPermit = (book: DmPermitBook, convId: string, jti: string): DmPermitBook => {
  if (book.granted[convId] === jti) return book
  return {
    ...book,
    granted: {...book.granted, [convId]: jti},
    muted: book.muted.filter((id) => id !== convId),
  }
}

export const setConversationMuted = (book: DmPermitBook, convId: string, muted: boolean): DmPermitBook => ({
  ...book,
  muted: muted ? [...new Set([...book.muted, convId])] : book.muted.filter((id) => id !== convId),
})

/** Drop everything about one conversation — for a thread the user deleted. */
export const forgetConversationPermits = (book: DmPermitBook, convId: string): DmPermitBook => {
  const granted = {...book.granted}
  delete granted[convId]
  return {...book, granted, muted: book.muted.filter((id) => id !== convId)}
}

/**
 * The invitations still worth showing: an expired permit admits nobody, so revoking it is a no-op
 * the user should not be offered.
 */
export const liveIssuedInvites = (book: DmPermitBook, nowSeconds: number): readonly DmIssuedInvite[] =>
  (book.issued ?? []).filter((invite) => invite.expiresAt > nowSeconds)

/**
 * Keep an invitation we just minted, newest first, dropping any that have since expired.
 *
 * ⚠️ **No cap.** Every other local list here is bounded, but a cap would evict a live invitation
 * whose id is stored nowhere else — turning a tidy-up into a door that can never be closed. Expiry
 * is the bound, and it is one the service agrees with.
 */
export const rememberIssuedInvite = (book: DmPermitBook, invite: DmIssuedInvite, nowSeconds: number): DmPermitBook => ({
  ...book,
  issued: [invite, ...(book.issued ?? []).filter((i) => i.jti !== invite.jti && i.expiresAt > nowSeconds)],
})

/** Drop an invitation the service has confirmed revoked. */
export const forgetIssuedInvite = (book: DmPermitBook, jti: string): DmPermitBook => ({
  ...book,
  issued: (book.issued ?? []).filter((invite) => invite.jti !== jti),
})
