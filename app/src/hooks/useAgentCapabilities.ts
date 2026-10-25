/**
 * What the user has granted to agents, loaded and persisted.
 *
 * Thin on purpose: every rule lives in {@link module:../services/mcp/agent-capabilities}, which is pure
 * and tested. This is storage and React state.
 *
 * ⚠️ **One setting, not one per wallet.** A scope names the wallet as well as the account, so the whole
 * choice spans wallets — keying this by wallet group would make the scope for wallet B unreachable while
 * wallet A was selected.
 *
 * ⚠️ **One key, two shapes.** It used to hold a bare `AgentCapabilities`; it now holds a book. The
 * parser reads the old value as the shared set rather than as an empty book, because the alternative
 * silently turns capabilities back *on* that someone had turned off.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {storage} from '../platform/storage'
import {
  type AgentCapabilityBook,
  DEFAULT_AGENT_CAPABILITIES,
  parseAgentCapabilityBook,
  sharedOnly,
} from '../services/mcp/agent-capabilities'

const ORIGIN = 'agent-capabilities'

const STORAGE_KEY = '@pnyx/agent_capabilities'

export type UseAgentCapabilities = {
  /** The shared set and every per-agent override — see {@link AgentCapabilityBook}. */
  readonly capabilities: AgentCapabilityBook
  /** True once the stored value has been read, so a screen does not save over what it never loaded. */
  readonly loaded: boolean
  readonly setCapabilities: (next: AgentCapabilityBook) => void
}

export const useAgentCapabilities = (): UseAgentCapabilities => {
  const [capabilities, setState] = useState<AgentCapabilityBook>(sharedOnly(DEFAULT_AGENT_CAPABILITIES))
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    setLoaded(false)
    void (async () => {
      try {
        const raw = await storage.get(STORAGE_KEY)
        if (!live) return
        setState(raw === null ? sharedOnly(DEFAULT_AGENT_CAPABILITIES) : parseAgentCapabilityBook(JSON.parse(raw)))
      } catch (error) {
        // Defaults are a safe fallback *and* a different fact from "the user chose these", so it is
        // logged: a read that failed silently would look like a wallet that had never been configured.
        logger.warn('agent capabilities could not be read; using the defaults', {origin: ORIGIN, error: String(error)})
        if (live) setState(sharedOnly(DEFAULT_AGENT_CAPABILITIES))
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const setCapabilities = useCallback((next: AgentCapabilityBook) => {
    // Optimistic, because the switch has to move under the finger; the write is what may fail.
    setState(next)
    void storage.set(STORAGE_KEY, JSON.stringify(next)).catch((error: unknown) => {
      // ⚠️ Not silent: the toggle will have moved on screen, so a failed write means the UI and the
      // stored grant disagree — and the next launch would quietly serve the old scope.
      logger.warn('agent capabilities could not be saved', {origin: ORIGIN, error: String(error)})
    })
  }, [])

  return {capabilities, loaded, setCapabilities}
}
