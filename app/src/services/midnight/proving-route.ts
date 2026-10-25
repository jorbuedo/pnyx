/**
 * Where a proof gets made: on this device, or delegated to a proof server.
 *
 * A pure decision rule, so the answer is the same wherever it is asked and can be tested without a
 * device or a network. `dapp-proving.ts` consults it before fetching a prover key — which is the point
 * of doing it here: `circuitK` reads K from the **ZKIR alone** (~4 KB), so the route is decidable
 * before the megabytes are moved.
 *
 * **Today only `device` is implemented**, and `server` is a route this returns but nothing yet honours.
 * The seam exists because the mode is going to be a **user setting** (on-device vs a proof server), and
 * the alternative — a hardcoded `throw` above a K ceiling — would have to be unpicked from the middle
 * of the proving path when that setting lands.
 *
 * ⚠️ **The mode must never be inferred from K.** A proof server receives the `ProofPreimage`, which
 * *is* the transaction's witness — Gero's own proof-server client says the same thing, and gates every
 * remote mode behind consent for exactly that reason. So a circuit too large for the phone yields
 * `refuse` under a `device` mode and `server` only under a mode the **user chose**. Silently
 * delegating because a circuit was big would disclose private inputs on a size heuristic.
 *
 * ## The rule
 *
 * | mode | K ≤ {@link DEVICE_MAX_K} | K > {@link DEVICE_MAX_K} |
 * |---|---|---|
 * | `device` | `device` | `refuse` — naming K and the SRS size |
 * | `server` | `server` | `server` |
 *
 * Under `server` the small cases go to the server too: a user who chose delegation chose it, and
 * quietly proving some circuits locally would make the setting mean something different per circuit.
 *
 * @module
 */

/**
 * The largest circuit this device will prove.
 *
 * K is log2 of the circuit's rows and the SRS doubles with every step: K=16 is 12.5 MB, K=17 is 25 MB,
 * K=20 is 201 MB. Our own circuits are K=14 and K=15. The ceiling is about the **SRS** rather than
 * proving time — the alternative is a phone downloading hundreds of megabytes and then running out of
 * memory, which is the same failure an hour later and with no explanation.
 */
export const DEVICE_MAX_K = 16

/** Where proofs are made. Will be a user setting; `device` is the only implemented value today. */
export type ProvingMode = 'device' | 'server'

export type ProvingRoute =
  /** Prove here, natively. */
  | {readonly route: 'device'}
  /**
   * Delegate over HTTP.
   *
   * ⚠️ Reachable only under an explicitly chosen `server` mode. Nothing honours it yet — a caller that
   * receives it and has no client must refuse rather than fall back to `device`, because falling back
   * would prove locally a circuit the device was just said to be unable to hold.
   */
  | {readonly route: 'server'}
  /** Cannot be proved. `reason` is caller-facing and names both figures. */
  | {readonly route: 'refuse'; readonly reason: string}

/**
 * Decide where a circuit of this size gets proved.
 *
 * `mode` comes from settings, never from the circuit. See the module note on why.
 */
export const provingRouteFor = (k: number, mode: ProvingMode): ProvingRoute => {
  if (!Number.isInteger(k) || k < 0) {
    // A K that is not a whole count is a ZKIR we misread, not a circuit to route. Guessing a route for
    // it would turn a parse failure into a proving failure much later.
    return {route: 'refuse', reason: `this circuit reports K=${k}, which is not a circuit size`}
  }
  if (mode === 'server') return {route: 'server'}
  if (k > DEVICE_MAX_K) {
    return {
      route: 'refuse',
      reason: `this circuit is K=${k}, and this device proves up to K=${DEVICE_MAX_K} — K=${k} needs an SRS this phone cannot hold`,
    }
  }
  return {route: 'device'}
}
