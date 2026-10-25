// One word for a sponsor host serving N networks, from what each of its wallets says.
//
// Pure, because the part that goes wrong is the *rule*, not the fan-out — and the router it serves is
// a `Bun.serve` script that exits on a missing env var, so nothing importable could test it in place.

/**
 * The vocabulary, worst last.
 *
 * - `starting` — still syncing. Not an error; the only honest answer during a cold sync.
 * - `degraded` — serving, but something is wrong: a section behind, a DUST floor crossed, a backlog.
 * - `failing`  — cannot sponsor: never started, DUST exhausted, or the process is not answering.
 */
export type HostState = 'ok' | 'starting' | 'degraded' | 'failing';

const SEVERITY: Record<HostState, number> = { ok: 0, starting: 1, degraded: 2, failing: 3 };

const isHostState = (value: unknown): value is HostState =>
  typeof value === 'string' && Object.hasOwn(SEVERITY, value);

/** One probe's answer, as the router collects it. */
export type NetworkProbe = {
  readonly httpStatus: number | null;
  readonly body: { status?: unknown } | null;
};

/**
 * What one network is actually saying.
 *
 * ⚠️ **A degraded wallet answers HTTP 200.** Counting statuses alone therefore reported the whole
 * host `ok` while preprod was degraded — an aggregate that hid the one thing it exists to surface.
 * The wallet's own word wins; the HTTP status is the fallback for an answer that carries none
 * (`/health` on an older wallet, or a body that did not parse).
 */
export const networkState = (probe: NetworkProbe): HostState => {
  if (isHostState(probe.body?.status)) return probe.body.status;
  return probe.httpStatus === 200 ? 'ok' : 'failing';
};

/**
 * Worst wins.
 *
 * ⚠️ **`ok` requires every configured network to be `ok`.** A host serving two of three is not
 * healthy: the third is a network somebody deployed on purpose, and reporting `ok` while it refuses
 * every call is exactly the reading that cost this project an hour on 2026-08-28.
 *
 * No probes at all is `failing`, not `ok`: a router with nothing behind it can sponsor nothing, and
 * an empty aggregate defaulting to healthy is the same defect one level up.
 */
export const hostState = (probes: readonly NetworkProbe[]): HostState => {
  if (probes.length === 0) return 'failing';
  return probes.map(networkState).reduce((worst, one) => (SEVERITY[one] > SEVERITY[worst] ? one : worst), 'ok');
};

/** Is the host serving at all? `starting` is not — nothing can be sponsored until a sync finishes. */
export const isServing = (state: HostState): boolean => state === 'ok' || state === 'degraded';
