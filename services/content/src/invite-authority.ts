// The invite authority a circle delegates to this deployment: one secret per circle, derived.
//
// `circle.compact`'s `inviteAuthority` cell holds `inviteAuthorityCommitment(sk)`, and whoever knows
// `sk` may insert and remove entries in `invites` — nothing else. That is the whole capability a
// founder hands us when they turn on self-service joining.
//
// ⚠️ **Per circle, never one secret for the deployment.** A single deployment-wide `sk` would mean a
// founder delegating to us hands over an authority shared with every other circle that ever did the
// same: one leak, and every gated circle on the deployment is open. Deriving per circle costs one
// hash and keeps the blast radius at one circle — and because it is a *derivation* rather than a
// stored row, there is still exactly one secret on disk (`INVITE_AUTHORITY_ROOT`) and nothing to
// back up per circle.
//
// ⚠️ **The root never reaches the Worker.** Cloudflare asks the sponsor host for a circle's
// commitment and stores that; the host is the only place the root exists. Putting it in both would
// double the exposure of the one secret this feature has, for no capability the Worker needs — it
// cannot prove a contract call anyway.

import { inviteAuthorityCommitment } from '@pnyx/contract-client/circle-derivations';
import { circleIdFromContentId } from '@pnyx/contract-client/circle-id';
import { pad32, persistentHash32 } from '@pnyx/contract-client/derivations';

/** Bytes of the deployment root, fixed: it keys a 32-byte derivation and is read as 64 hex. */
export const INVITE_AUTHORITY_ROOT_BYTES = 32;

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Read `INVITE_AUTHORITY_ROOT` from its configured form.
 *
 * Refuses rather than truncating or padding: a root of the wrong length would derive perfectly
 * valid-looking secrets that simply are not the ones the founders' circles committed to, and every
 * mint would fail as "not the invite authority" several layers from the typo.
 */
export const parseInviteAuthorityRoot = (
  raw: string,
): { readonly ok: true; readonly root: Uint8Array } | { readonly ok: false; readonly message: string } => {
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    return { ok: false, message: 'INVITE_AUTHORITY_ROOT must be hex' };
  }
  if (raw.length !== INVITE_AUTHORITY_ROOT_BYTES * 2) {
    return {
      ok: false,
      message: `INVITE_AUTHORITY_ROOT must be ${INVITE_AUTHORITY_ROOT_BYTES * 2} hex characters, got ${raw.length}`,
    };
  }
  return { ok: true, root: fromHex(raw.toLowerCase()) };
};

/**
 * This deployment's invite-authority secret for one circle.
 *
 * Keyed on the **on-chain** circle id rather than the content-plane uuid, because that is the value
 * `circle.compact` seals into its own state: a circle re-created in the content plane under a new
 * uuid is a different circle and gets a different authority, while a contract redeployed for the same
 * circle keeps the one its founder already delegated to.
 *
 * ⚠️ Its own domain tag. `pnyx:ia` is the *commitment*'s tag and hashing the root under it would make
 * the root itself a valid authority secret for a circle that committed to `H("pnyx:ia", root)`.
 */
export const inviteAuthoritySk = (root: Uint8Array, contentCircleId: string): Uint8Array => {
  if (root.length !== INVITE_AUTHORITY_ROOT_BYTES) {
    throw new Error(`inviteAuthoritySk: root must be ${INVITE_AUTHORITY_ROOT_BYTES} bytes, got ${root.length}`);
  }
  return persistentHash32([pad32('pnyx:ia-seed'), root, circleIdFromContentId(contentCircleId)]);
};

/**
 * What a founder posts with `setInviteAuthority` to delegate to this deployment, as hex.
 *
 * Public by construction — it is a commitment, and the circle stores it in a public ledger cell.
 */
export const inviteAuthorityCommitmentFor = (root: Uint8Array, contentCircleId: string): string =>
  toHex(inviteAuthorityCommitment(inviteAuthoritySk(root, contentCircleId)));

/** The secret itself, as hex — for the one caller that proves with it. */
export const inviteAuthoritySkHex = (root: Uint8Array, contentCircleId: string): string =>
  toHex(inviteAuthoritySk(root, contentCircleId));
