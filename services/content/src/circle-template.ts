/**
 * Whether a circle's deployed contract came from the compile this deployment speaks.
 *
 * A circle's verifier keys **are** its code — `sponsorship.ts` recognises our templates by hashing
 * them — and a contract deployed from an older compile of `circle.compact` keeps those keys for ever.
 * Its *reads* still work, because the ledger has only ever gained fields and they were appended, so
 * every slot an older client knew about is still where it was. What breaks is everything that proves:
 * a client builds its proof against today's verifier keys, the contract holds yesterday's, and the
 * sponsor refuses the call as a template it does not fund.
 *
 * So the circle looks healthy and is unusable, which is the one combination a UI must never present
 * without saying so.
 *
 * ⚠️ **`unknown` is a real answer and must not collapse into `current`.** A circle that has not
 * settled has no contract at all, and one whose digest has not been resolved yet is a fact we have
 * not looked up — neither is evidence that the template matches. Rendering either as "fine" is the
 * failure this module exists to prevent.
 *
 * @module
 */

/** What a client should believe about a circle's contract. */
export type CircleTemplate = 'current' | 'outdated' | 'unknown';

export type CircleTemplateInput = {
  /** The digest recorded for the circle's own contract, or absent if never resolved. */
  readonly codeDigest?: string | undefined;
  /** The digest this deployment builds and proves against, or absent if none is configured. */
  readonly currentDigest?: string | undefined;
};

/**
 * Compared case-insensitively, matching `sponsorshipRefusal` — the two must never disagree about the
 * same pair of hex strings, because the sponsor's answer is what actually decides whether a call works.
 */
export const circleTemplate = ({ codeDigest, currentDigest }: CircleTemplateInput): CircleTemplate => {
  if (codeDigest === undefined || codeDigest === '' || currentDigest === undefined || currentDigest === '') {
    return 'unknown';
  }
  return codeDigest.toLowerCase() === currentDigest.toLowerCase() ? 'current' : 'outdated';
};
