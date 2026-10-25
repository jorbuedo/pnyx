/**
 * One agent approval at a time, with a bound on how long an agent waits for a person.
 *
 * An agent's `signTx` cannot be answered from the frame it arrived on: it needs the **canonical review
 * screen** ([[one-canonical-review-path]]), which is a route a person walks through. So the reply is
 * deferred — this module holds the promise open, hands the review a callback to settle it, and makes
 * sure the two failure modes an agent cannot recover from on its own are impossible:
 *
 * | failure | what this does |
 * |---|---|
 * | a second request arrives while a review is open | refuses it, naming what is already waiting — the review screen shows one thing at a time, and silently replacing it would put a signature the agent asked for behind a screen describing a different one |
 * | nobody ever decides | answers after {@link DEFAULT_APPROVAL_TIMEOUT_MS} — an agent left waiting cannot tell a thinking human from a killed app |
 *
 * ⚠️ **A timeout is not a decline, and the message says so.** An agent that reads "declined" will not
 * ask again; one that reads "nobody answered" can. Getting that backwards teaches the model the wrong
 * thing about a user who simply walked away.
 *
 * Pure and free of React so the ordering is testable — the ordering is the whole content.
 *
 * @module
 */

/**
 * Long enough to read a transaction, short enough that an agent is not stuck for a session.
 *
 * Reviewing a real transaction — reading outputs, checking a fee — is a minute or two of human time, and
 * a hardware signer adds more. Five minutes is generous for that and still bounded.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** What the agent asked for, in words a person's answer can be attributed to. */
export type ApprovalKind = 'a transaction signature' | 'a data signature'

/**
 * ⚠️ **Generic in what it answers with, and that is load-bearing.** Two surfaces queue behind this one
 * gate — a connector `signTx`, which answers with a `WalletResponse`, and a builder, which answers with
 * a tool outcome. A gate that spoke only the connector's shape would have forced the builders to invent
 * a second one, and two gates mean two reviews on one screen.
 */
export type AgentApprovalRequest<A> = {
  readonly kind: ApprovalKind
  /**
   * Open the review and settle. Called once; `answer` may be called at most once, and any later call is
   * ignored — a review that both settles and cancels must not answer twice.
   */
  readonly open: (answer: (value: A) => void) => Promise<void>
  /**
   * How this surface says "refused, and here is why".
   *
   * Injected rather than built here: the gate's own three refusals — already busy, nobody answered,
   * could not open — have to reach the agent in whatever shape the surface speaks, and the *wording*
   * is the gate's because it is the gate that knows which of the three happened.
   */
  readonly refuse: (message: string) => A
}

export type AgentApprovalGate = {
  /** What is waiting for a person, or `undefined`. */
  readonly waitingFor: () => ApprovalKind | undefined
  readonly request: <A>(request: AgentApprovalRequest<A>) => Promise<A>
}

export type GateOptions = {
  readonly timeoutMs?: number
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  readonly clearTimeoutImpl?: (handle: unknown) => void
}

export const createAgentApprovalGate = (options: GateOptions = {}): AgentApprovalGate => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const schedule = options.setTimeoutImpl ?? setTimeout
  const cancel = options.clearTimeoutImpl ?? (clearTimeout as (handle: unknown) => void)
  let waiting: ApprovalKind | undefined

  return {
    waitingFor: () => waiting,
    request: async <A>(request: AgentApprovalRequest<A>): Promise<A> => {
      if (waiting !== undefined) {
        return request.refuse(
          `this wallet is already waiting for someone to approve ${waiting} on the device. Wait for that to finish before asking again.`,
        )
      }
      waiting = request.kind
      try {
        return await new Promise<A>((resolve) => {
          let settled = false
          const settle = (value: A) => {
            if (settled) return
            settled = true
            cancel(timer)
            resolve(value)
          }
          const timer = schedule(
            () =>
              settle(
                request.refuse(
                  // ⚠️ Not "declined": the person may still be looking at it, and an agent told it was
                  // declined will not ask again.
                  `nobody answered on the device in time — ${request.kind} is still waiting there, or was abandoned. Ask the person to check Pnyx.`,
                ),
              ),
            timeoutMs,
          )
          // A rejection here means the review could not even be opened, which is a definite answer and
          // must not leave the agent on the timeout. `open` is not trusted to settle in that case.
          void request.open(settle).catch((error: unknown) => {
            settle(request.refuse(`the wallet could not open the review: ${String(error)}`))
          })
        })
      } finally {
        // Whatever happened, the next request must be able to get through. A gate that leaks its
        // pending flag refuses for ever, which looks exactly like a wallet that stopped answering.
        waiting = undefined
      }
    },
  }
}
