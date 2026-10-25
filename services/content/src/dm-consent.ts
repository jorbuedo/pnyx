/**
 * Who may reach you, and whether it buzzes.
 *
 * Pure: every input is a value the caller has already looked up, so the rule can be read and tested
 * without a store, a clock or a Worker runtime. Design and the defects that motivated it:
 * `docs/ABUSE_MITIGATION.md` §5.
 *
 * Three settings with three different shapes, and the shapes are the design:
 *
 * - **policy** is per-subject (`open | permit | closed`) — a preference, no peer in it.
 * - **a permit** is a stateless token the *sender* presents. Nothing is stored to issue one.
 * - **block** and **mute** are the negative overrides. Block is a durable pair; mute is a revoked
 *   permit id, which is opaque and carries no pair.
 *
 * ⚠️ **Block beats a permit, always.** A permit says the recipient once agreed; a block says they
 * have since changed their mind, and the later statement wins. Ordering them the other way would let
 * a permit issued before a block keep working, which is precisely the thing a block is for.
 *
 * ⚠️ **A policy is about strangers, so a targeted permit outlives a change to it.** The policy
 * answers "who may reach me that I have not already decided about"; a targeted permit *is* that
 * decision, made earlier about one named person. `closed` therefore means **nobody new** — which is
 * what its own copy has always said — and `block` remains how an earlier decision is taken back.
 * Until 2026-09-02 `closed` refused a valid permit too, which cut off the conversations the setting
 * promised to keep.
 *
 * ## The matrix
 *
 * | policy | blocked | permit | outcome |
 * |---|---|---|---|
 * | any | yes | any | `refused` — block outranks everything |
 * | any | no | targeted, valid | `allowed`, notify per the permit — an earlier grant survives a later policy change |
 * | any | no | targeted, revoked | `allowed`, **silent** — mute is not un-admission |
 * | `open` / `permit` | no | invite | `allowed`, and the caller **converts** it into a targeted permit for this sender |
 * | `closed` | no | invite | `refused` — converting admits somebody new, which is the one thing this setting refuses |
 * | `open` | no | none / invalid | `allowed`, and the caller **auto-issues** one so the conversation has an id to mute |
 * | `permit` | no | none / invalid | `refused` — the whole point of the setting |
 * | `closed` | no | none / invalid | `refused` |
 *
 * ⚠️ **`revoked` is not `invalid`.** A revoked permit still authorises delivery; it only stops the
 * push. Revocation is how *mute* is expressed, and muting someone is not un-accepting them — a muted
 * conversation must keep arriving or the user silently loses messages they agreed to receive.
 *
 * ⚠️ **Conversion is a decision, not a side effect.** An unconverted invite reaches here as its own
 * `kind`, and the caller mints only when told to. Doing it before the decision — as the router used
 * to — both admitted a stranger under `closed` and signed a token that was then thrown away.
 *
 * @module
 */

/** What a recipient has decided about strangers. */
export type DmPolicy = 'open' | 'permit' | 'closed';

/** The default for an identity that has never set one: reachable, like today. */
export const DEFAULT_DM_POLICY: DmPolicy = 'open';

/** Whether a string is a policy this service understands. */
export const isDmPolicy = (value: unknown): value is DmPolicy =>
  value === 'open' || value === 'permit' || value === 'closed';

/** What verifying the presented permit produced. */
export type PermitState =
  /**
   * No permit presented, or one that did not verify against this service's key.
   *
   * A *revoked invite* arrives as this too: it admits nobody in particular, so revoking it means the
   * link stopped working, and the policy is what answers next.
   */
  | { readonly kind: 'none' }
  /** A verified targeted permit, not revoked. Names this sender, so it is a decision about them. */
  | { readonly kind: 'valid'; readonly notify: boolean }
  /** Verified, but its id is on the revocation list — the recipient muted this sender. */
  | { readonly kind: 'revoked' }
  /**
   * A verified invite, not revoked and **not yet converted**. Names nobody, so it is not a decision
   * about this sender — it is a standing offer to whoever holds the link, and whether it still
   * stands is the policy's call.
   */
  | { readonly kind: 'invite'; readonly notify: boolean };

export type ConsentInput = {
  readonly policy: DmPolicy;
  readonly blocked: boolean;
  readonly permit: PermitState;
};

export type ConsentDecision =
  | { readonly deliver: false; readonly reason: 'blocked' | 'closed' | 'permit-required' }
  | {
      readonly deliver: true;
      readonly notify: boolean;
      /** True when the caller should mint a permit for this pair and hand it back. */
      readonly autoIssue: boolean;
      /** True when the caller should convert the presented invite into a targeted permit and hand it back. */
      readonly convert: boolean;
    };

/**
 * Decide whether a sender may reach a recipient, and whether it raises a push.
 *
 * ⚠️ **`deliver: true, notify: false` is a real and common outcome**, not a degenerate one: it is a
 * muted conversation, and treating it as a refusal would lose messages the recipient agreed to.
 */
export const decideConsent = ({ policy, blocked, permit }: ConsentInput): ConsentDecision => {
  if (blocked) return { deliver: false, reason: 'blocked' };
  // Already decided about, by name, before whatever the policy now says about strangers.
  if (permit.kind === 'valid') return { deliver: true, notify: permit.notify, autoIssue: false, convert: false };
  // Muted: still delivered, deliberately silent, and no new permit — auto-issuing here would hand
  // the sender a fresh id and un-mute them, which is the one thing revocation must survive.
  if (permit.kind === 'revoked') return { deliver: true, notify: false, autoIssue: false, convert: false };
  // The link still opens the door unless the door was shut. `closed` is the only policy that shuts
  // it: `permit` exists precisely so an invitation can let somebody in.
  if (permit.kind === 'invite') {
    return policy === 'closed'
      ? { deliver: false, reason: 'closed' }
      : { deliver: true, notify: permit.notify, autoIssue: false, convert: true };
  }
  if (policy === 'closed') return { deliver: false, reason: 'closed' };
  if (policy === 'open') return { deliver: true, notify: true, autoIssue: true, convert: false };
  return { deliver: false, reason: 'permit-required' };
};
