// Reading a failure the sponsor host reported. The reason surviving the trip is the whole point:
// a 5xx from behind the tunnel arrives with its body replaced by Cloudflare's own error page.
import { describe, expect, it } from 'vitest';
import { SPONSOR_FAILURE_STATUS, sponsorFailure, sponsorFailureReason } from './sponsor-failure.js';

describe('sponsorFailure', () => {
  // ⚠️ Both callers accept on `202` alone. If either ever widened to "2xx", this status would turn a
  // reported failure into a silent success — the exact inversion this shape trades on.
  it('is not an accepting status', () => {
    expect(SPONSOR_FAILURE_STATUS).not.toBe(202);
    expect(sponsorFailure('DUST is exhausted')).toEqual({ ok: false, error: 'DUST is exhausted' });
  });
});

describe('sponsorFailureReason', () => {
  it('takes the reason out of a sponsor body', () => {
    expect(sponsorFailureReason(JSON.stringify({ ok: false, error: 'register failed: Custom error: 170' }))).toBe(
      'register failed: Custom error: 170',
    );
    expect(sponsorFailureReason(JSON.stringify({ error: 'the preprod sponsor wallet is not answering' }))).toBe(
      'the preprod sponsor wallet is not answering',
    );
  });

  // A body a tunnel or proxy rewrote is still more than the status alone, and "the body was not ours"
  // is itself the finding.
  it('reports a body it did not write rather than dropping it', () => {
    expect(sponsorFailureReason('<html>error code: 502</html>')).toBe('<html>error code: 502</html>');
    expect(sponsorFailureReason(JSON.stringify({ ok: false }))).toBe('{"ok":false}');
  });

  it('bounds a body that would otherwise flood a log line', () => {
    expect(sponsorFailureReason('x'.repeat(5_000))).toHaveLength(300);
  });

  // The one case where the status really is all there is.
  it('names nothing when there was no body', () => {
    expect(sponsorFailureReason('')).toBeUndefined();
    expect(sponsorFailureReason('   \n ')).toBeUndefined();
  });
});
