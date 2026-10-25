/**
 * What the agents have actually been doing — a bounded tail, and a rate.
 *
 * Serving is otherwise invisible: the screen says "connected" whether an agent is hammering it or has
 * been idle since morning, and the only record of a call is a `debug` line in a log nobody has open.
 * This is the surface that tells the two apart.
 *
 * ⚠️ **Bounded, and never persisted.** The tail is the last {@link ACTIVITY_CAP} calls in memory and
 * dies with the session — an agent's traffic is a live signal, not a record to keep about its owner.
 *
 * ⚠️ **Arguments are deliberately absent.** A call carries addresses, amounts, sometimes a whole
 * transaction; a screen that showed them would put a wallet's contents on a page that stays open. The
 * same allow-list reasoning `platform/dev-fetch-proxy.native.ts` applies to request bodies.
 *
 * @module
 */

/** How a call ended, in the three ways that mean different things to somebody watching. */
export type AgentCallOutcome =
  /** Answered normally. */
  | 'ok'
  /** The wallet answered, and the answer was a refusal the agent has to act on. */
  | 'refused'
  /** The call did not produce an answer — a protocol error, or the wallet failing. */
  | 'error'

export type AgentCall = {
  /** When the call finished, epoch ms. */
  readonly at: number
  /** The JSON-RPC method — `tools/call`, `tools/list`, `resources/read`, … */
  readonly method: string
  /** For a `tools/call`, which tool. Absent for every other method. */
  readonly tool?: string
  /** The agent's label, or `null` when the relay did not attribute the frame. */
  readonly agent: string | null
  readonly outcome: AgentCallOutcome
  /** How long the wallet took, ms. */
  readonly ms: number
}

/**
 * How many calls the tail keeps.
 *
 * Enough to see a burst and what preceded it, small enough that the list never becomes the reason the
 * screen is slow — an agent can issue calls far faster than a person scrolls.
 */
export const ACTIVITY_CAP = 50

/** The window the rate is measured over. */
const RATE_WINDOW_MS = 60_000

/**
 * Add a call to the tail, newest first, dropping the oldest past the cap.
 *
 * Returns a new array rather than mutating: the caller is React state.
 */
export const appendCall = (tail: readonly AgentCall[], call: AgentCall, cap: number = ACTIVITY_CAP): AgentCall[] => [
  call,
  ...tail.slice(0, Math.max(0, cap - 1)),
]

/**
 * Calls in the last minute.
 *
 * ⚠️ **Counted over a window, not extrapolated from an interval.** A rate derived from the gap between
 * the last two calls reads 600/min for two calls a tenth of a second apart and then stays there while
 * nothing happens — which is exactly the reading a person would act on. This one falls to zero on its
 * own, provided the caller re-renders while idle.
 *
 * The tail is capped, so a genuinely faster rate than the cap cannot be represented; that is reported
 * by {@link rateIsCapped} rather than shown as a smaller number than the truth.
 */
export const callsPerMinute = (tail: readonly AgentCall[], now: number): number =>
  tail.filter((call) => now - call.at < RATE_WINDOW_MS).length

/**
 * Whether the rate is only a floor — every call the tail holds is inside the window, so the real figure
 * may be higher and the tail has already dropped the evidence.
 */
export const rateIsCapped = (tail: readonly AgentCall[], now: number, cap: number = ACTIVITY_CAP): boolean =>
  tail.length >= cap && callsPerMinute(tail, now) >= cap

/** What to draw for one call: `tools/call` shows the tool, anything else shows the method. */
export const callLabel = (call: AgentCall): string => call.tool ?? call.method
