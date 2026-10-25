// How the sponsor host reports a failure it wants explained.
//
// ⚠️ **A 5xx from behind a Cloudflare tunnel arrives with its body replaced** by Cloudflare's own
// "error code: 502" page. Answering 502 therefore throws away the only account of what went wrong —
// which is how a node rejection (`Custom error: 170`, an expired intent, a stale coin) reached the
// app as a bare gateway error with nothing in any log to join the two halves together.
//
// A *refusal* already answers 400, whose body survives, and that stays. This is the other half: a
// genuine failure answers **200 with `ok: false`**.
//
// The status is a lie in the small. It is worth it because it is a lie across exactly one hop,
// between two processes we own, on a channel where 5xx has been measured to be lossy — and because
// nothing distinguishes success by "2xx": both callers test for `202`, which is the only status the
// sponsor ever answers with when it has accepted bytes. What the app is told is the truth.
//
// The alternative considered was having the Worker read `/status` after a 5xx. `/status` reports the
// host's *latest* failure, which need not be this request's — a race that produces a confident wrong
// answer, and a confident wrong answer is worse than a vague right one.

/** The status a genuine (non-refusal) sponsor failure answers with. See the note above. */
export const SPONSOR_FAILURE_STATUS = 200;

export type SponsorFailure = { readonly ok: false; readonly error: string };

export const sponsorFailure = (error: string): SponsorFailure => ({ ok: false, error });

/**
 * The reason out of whatever a sponsor hop answered with, for a caller that already knows it is not
 * a `202`.
 *
 * Falls back to the raw text — trimmed and bounded — because the body may well be Cloudflare's error
 * page or a proxy's, and an opaque body is still more than "502". `undefined` only when there was no
 * body at all, which is the one case where the status is genuinely all there is.
 */
export const sponsorFailureReason = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const named = typeof parsed.error === 'string' ? parsed.error : parsed.message;
    if (typeof named === 'string' && named.trim() !== '') return named.trim();
  } catch {
    // Not JSON — an HTML error page, or a proxy's plain text. Reported as-is below rather than
    // dropped: "the body was not ours" is itself the finding when a tunnel has rewritten it.
  }
  return trimmed.slice(0, 300);
};
