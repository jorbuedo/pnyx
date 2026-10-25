/**
 * What an agent is told when the connector asks for UI the MCP surface is not driving.
 *
 * The connector answers a request that needs a person with a *sentinel* — a typed failure the host app
 * catches to open a sheet. The in-app browser has those sheets; this surface does not yet
 * (`docs/MCP_DEV_TOOL_SPEC.md` milestone 3 is where `signTx` reaches the review screen). Until then a
 * sentinel has to become a sentence.
 *
 * ⚠️ **Never let one reach `Effect.runPromise`.** A rejected Effect arrives as a `FiberFailure` whose
 * `String(...)` reads "An error has occurred", so the reason is gone by the time anything can log it —
 * the reason this maps to a `WalletResponse` error instead, which the protocol layer already turns into
 * an `isError` tool result the model can act on.
 *
 * ⚠️ **Wording is the interface.** An agent shows this to a person and decides from it whether to
 * retry. "Refused" invites a retry loop; naming the screen that grants the session does not.
 *
 * @module
 */

import type {SentinelError} from '@pnyx/dapp-connector'

/** Where a person turns serving on. Named in full because an agent's user has to find it. */
const PAIRING_SCREEN = 'Settings › Developer tools › Pair an AI agent'

export const sentinelMessage = (sentinel: SentinelError): string => {
  switch (sentinel._tag) {
    case 'ConnectionRequired':
      return `this wallet has not granted a session to ${sentinel.origin} — open Pnyx on the paired device, go to ${PAIRING_SCREEN}, and turn on "serve agents". Nothing to retry until then.`
    case 'SignTxRequired':
    case 'SignDataRequired':
    case 'MidnightSignDataRequired':
      return 'signing needs approval on the phone, and the agent surface cannot show that screen yet. Ask the person to do it in the app.'
    case 'MidnightTransferRequired':
    case 'MidnightSubmitRequired':
    case 'MidnightBalanceRequired':
      return 'moving funds needs approval on the phone, and the agent surface cannot show that screen yet. Ask the person to do it in the app.'
    case 'MidnightAppSecretRequired':
      return 'deriving an app secret needs approval on the phone, and the agent surface cannot show that screen yet.'
  }
}
