/**
 * Serving AI agents while this screen is open.
 *
 * The wallet is the MCP server, but it cannot listen — so "serving" means holding a socket out to the
 * relay, and it lasts exactly as long as the caller keeps this hook mounted with `serving` on
 * (`docs/MCP_DEV_TOOL_SPEC.md` §4.4, §5). Leaving the screen stops it, and the agent is told the wallet
 * is not connected rather than being left to time out.
 *
 * The connector comes from {@link useDappConnector}, unchanged: an agent is gated by the same session
 * rules, handlers and refusals the in-app browser is.
 *
 * @module
 */

import {useCallback, useEffect, useRef, useState} from 'react'
import {logger} from '../logger'
import {usePnyxSession} from '../providers'
import type {AgentCall} from '../services/mcp/activity'
import {ACTIVITY_CAP, appendCall, callsPerMinute, rateIsCapped} from '../services/mcp/activity'
import type {AgentCapabilityBook} from '../services/mcp/agent-capabilities'
import type {McpServing} from '../services/mcp/serve'
import {serveAgents} from '../services/mcp/serve'
import {useDappConnector} from './useDappConnector'

const ORIGIN = 'mcp-serving'

/** The MCP surface answers no WebView tab, so a bridge answer arriving here is a wiring mistake. */
const noTabToAnswer = (tabId: string) => {
  logger.warn('the mcp surface was handed a browser bridge answer', {origin: ORIGIN, tabId})
}

/** Why serving is not running, as a translation key — the screen owns the words. */
export type McpServingErrorKey =
  | 'agents.errors.signInFirst'
  | 'agents.errors.sessionExpired'
  | 'agents.errors.noCardanoWallet'
  | 'agents.errors.couldNotStart'

export type UseMcpServing = {
  /** Whether the user has asked to serve. Not the same as connected. */
  readonly serving: boolean
  /** Whether the relay socket is actually open — what an agent can reach right now. */
  readonly connected: boolean
  readonly error: McpServingErrorKey | undefined
  readonly setServing: (on: boolean) => void
  /** The last {@link ACTIVITY_CAP} calls, newest first. Empty until an agent asks for something. */
  readonly activity: readonly AgentCall[]
  /** Calls in the last minute. Falls to zero on its own while nothing is happening. */
  readonly callsPerMinute: number
  /** The rate is a floor rather than a reading — the tail is full and all of it is inside the window. */
  readonly rateCapped: boolean
}

export const useMcpServing = (
  capabilities: AgentCapabilityBook,
  /** How to name each granted scope to a person — only a screen knows a wallet's name. */
  scopeLabels: ReadonlyMap<string, string>,
): UseMcpServing => {
  const {session, signIn, refresh} = usePnyxSession()
  const sessionToken = session?.token
  const {mcpDeps} = useDappConnector(noTabToAnswer)
  const [serving, setServing] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<McpServingErrorKey | undefined>(undefined)
  const [activity, setActivity] = useState<readonly AgentCall[]>([])
  /**
   * Re-render while idle so the rate can fall to zero.
   *
   * Without it the figure freezes at whatever the last burst produced and reads as live traffic — the
   * failure the windowed count in `activity.ts` exists to avoid, reintroduced by never re-measuring.
   */
  const [, tick] = useState(0)
  /**
   * The token we started with was refused as expired, so the next attempt must mint a new one.
   *
   * ⚠️ A ref rather than state: the session in the provider is still there and still stale, so nothing
   * observable changes when it lapses. Without this the next tap would dial with the same dead token.
   */
  const staleToken = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!serving) return
    const timer = setInterval(() => tick((n) => n + 1), 5_000)
    return () => clearInterval(timer)
  }, [serving])

  useEffect(() => {
    if (!serving) return
    let live = true
    let started: McpServing | undefined
    let unsubscribe: (() => void) | undefined
    void (async () => {
      try {
        /**
         * Sign in again when there is no token, or when the one we hold has already been refused.
         *
         * ⚠️ **Only ever inside the user's own tap.** Signing in fires an OS biometric prompt, and one
         * that appears because a timer lapsed — with the phone in a pocket — is worse than no prompt at
         * all. The gesture that turned serving on is the consent.
         */
        const held = sessionToken !== undefined && sessionToken !== staleToken.current ? sessionToken : undefined
        // A lapsed token is replaced from the identity master already in memory — no enclave, no
        // prompt. `signIn` is the fallback for the two cases a refresh genuinely cannot cover: no
        // session at all, and a row the service will not authenticate.
        const token = held ?? (await refresh())?.token ?? (await signIn())?.token
        if (token === undefined) {
          // Both branches end with the screen refusing to serve, and which one it was is the whole
          // difference between "sign in" and "your session lapsed" — neither is diagnosable from the
          // screen alone.
          logger.warn('mcp serving has no session token, so it will not start', {
            origin: ORIGIN,
            afterStaleToken: staleToken.current !== undefined,
          })
          setError(staleToken.current === undefined ? 'agents.errors.signInFirst' : 'agents.errors.sessionExpired')
          setServing(false)
          return
        }
        staleToken.current = undefined
        if (!live) return
        const connector = await mcpDeps(capabilities, scopeLabels)
        if (connector === null) {
          // ⚠️ The screen says "no Cardano wallet is available", which reads as a fact about the
          // account. It is really "no granted scope opened" — and the reason each one failed is a
          // `useDappConnector` warning. Without this line the two are indistinguishable, and the
          // screen's version sends you looking at the wrong thing (measured, 2026-08-29).
          logger.warn('mcp serving opened no granted scope, so there is nothing to serve', {
            origin: ORIGIN,
            cardano: capabilities.shared.cardano,
            midnight: capabilities.shared.midnight,
            scopes: capabilities.shared.scopes.length,
          })
          setError('agents.errors.noCardanoWallet')
          setServing(false)
          return
        }
        const serviceSide = await serveAgents({
          connector,
          sessionToken: token,
          capabilities,
          scopeLabels,
          onActivity: (call) => {
            if (!live) return
            setActivity((tail) => appendCall(tail, call))
          },
          // The host has already stopped by the time this runs — retrying an expired session is what it
          // used to do for ever, with the screen saying `Connecting…` and every agent told the wallet is
          // not connected. One tap re-authenticates, because the tap is the consent for the prompt.
          // ⚠️ **Refresh, then stop — in that order.** Serving is the surface most likely to outlive an
          // hour: an agent works unattended, and stopping it to ask for a biometric the user is not
          // there to give ends the session it exists to hold open. Only a refresh that *fails* is
          // worth the screen.
          onSessionExpired: () => {
            staleToken.current = token
            void refresh().then((next) => {
              if (!live) return
              if (next !== undefined) {
                // `sessionToken` changes, so the effect re-runs and dials again with the new token.
                logger.debug('mcp serving refreshed a lapsed session and will redial', {origin: ORIGIN})
                return
              }
              setConnected(false)
              setServing(false)
              setError('agents.errors.sessionExpired')
            })
          },
        })
        // Stopped while the grant and socket were being set up: undo it rather than leaving a socket
        // nothing is watching.
        if (!live) {
          await serviceSide.stop()
          return
        }
        started = serviceSide
        unsubscribe = serviceSide.onStateChange(setConnected)
        setConnected(serviceSide.isConnected())
        setError(undefined)
      } catch (e) {
        logger.warn('mcp serving could not start', {origin: ORIGIN, error: String(e)})
        setError('agents.errors.couldNotStart')
        setServing(false)
      }
    })()
    return () => {
      live = false
      unsubscribe?.()
      setConnected(false)
      // The tail describes a session that has ended; keeping it would read as live traffic next time.
      setActivity([])
      void started?.stop()
    }
    // ⚠️ `capabilities` is a dependency: changing what is granted has to re-grant. Without it, turning
    // Midnight on would advertise its tools while no session backed them — the shape this whole surface
    // is built to avoid.
  }, [serving, sessionToken, signIn, refresh, mcpDeps, capabilities, scopeLabels])

  const now = Date.now()
  return {
    serving,
    connected,
    error,
    setServing: useCallback((on: boolean) => setServing(on), []),
    activity,
    callsPerMinute: callsPerMinute(activity, now),
    rateCapped: rateIsCapped(activity, now),
  }
}
