/// <reference types="chrome" />
/**
 * Generic BLE bridge manager factory.
 *
 * Encapsulates the shared infrastructure between the Ledger and Trezor BLE
 * bridges: tab lifecycle, port management, keepalive ping/pong, disconnect
 * detection, and response waiting. Device-specific bridge managers call
 * `createBridgeManager` with their protocol constants and layer device-specific
 * operations on top. Web Bluetooth pickers are blocked in side panels / popups,
 * so the actual `navigator.bluetooth` work runs in a dedicated bridge tab and is
 * relayed over a `chrome.runtime` port (see `docs/EXTENSION.md`).
 *
 * @module
 */

// ============================================================================
// Types
// ============================================================================

export type BridgeState = 'disconnected' | 'opening' | 'ready' | 'connected'

export type BridgeConfig = {
  /** Port name used by the bridge tab when connecting to the background. */
  portName: string
  /** HTML file to open (e.g. 'ble-bridge.html?device=ledger'). */
  htmlFileName: string
  /** Label used in error messages (e.g. 'Ledger BLE'). */
  deviceLabel: string
  /** Timeout for the bridge tab to connect after opening (ms). */
  openTimeout: number
  /** Interval between keepalive pings (ms). */
  pingInterval: number
  /** Max time to wait for a pong before considering the bridge dead (ms). */
  pingTimeout: number
  /** Message type sent as ping (e.g. 'BLE_PING'). */
  pingType: string
  /** Message type expected as pong (e.g. 'BLE_PONG'). */
  pongType: string
  /** Message type indicating the device disconnected (e.g. 'BLE_DISCONNECTED'). */
  disconnectType: string
  /** Message types that indicate an error response. */
  errorTypes: string[]
}

export type BridgeManager = {
  /** Register chrome.runtime.onConnect and chrome.tabs.onRemoved listeners. */
  initListeners: () => void
  /** Open the bridge tab and wait for it to connect. */
  openBridge: () => Promise<void>
  /** Close the bridge entirely (transport + tab). */
  closeBridge: () => Promise<void>
  /** Get current bridge state. */
  getState: () => BridgeState
  /** Set bridge state (used by device-specific operations). */
  setState: (s: BridgeState) => void
  /** Register a listener for disconnect events. Returns unsubscribe function. */
  onDisconnect: (cb: (reason?: string) => void) => () => void
  /** Post a message to the bridge tab port. Throws if not connected. */
  postMessage: (msg: unknown) => void
  /** Get the bridge port (or null if not connected). */
  getPort: () => chrome.runtime.Port | null
  /** Wait for a response matching `expectedType` on the port. */
  waitForResponse: <T extends string>(expectedType: T, timeout: number) => Promise<Record<string, unknown> & {type: T}>
  /** Wait for a response matching `expectedType` AND `requestId`. */
  waitForRequestIdResponse: <T extends string>(
    expectedType: T,
    requestId: string,
    timeout: number,
  ) => Promise<Record<string, unknown> & {type: T}>
  /** Close the transport (keep bridge tab). */
  closeTransport: (closeType: string, closedType: string) => Promise<void>
}

// ============================================================================
// Factory
// ============================================================================

export const createBridgeManager = (config: BridgeConfig): BridgeManager => {
  let state: BridgeState = 'disconnected'
  let bridgePort: chrome.runtime.Port | null = null
  let bridgeTabId: number | null = null
  let pingIntervalId: ReturnType<typeof setInterval> | null = null
  let pendingPingTimeout: ReturnType<typeof setTimeout> | null = null
  let openBridgePromise: Promise<void> | null = null

  const disconnectListeners = new Set<(reason?: string) => void>()

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  const notifyDisconnect = (reason?: string) => {
    for (const listener of disconnectListeners) {
      try {
        listener(reason)
      } catch {
        // Ignore listener errors
      }
    }
  }

  const teardown = (reason?: string) => {
    if (pingIntervalId) {
      clearInterval(pingIntervalId)
      pingIntervalId = null
    }
    if (pendingPingTimeout) {
      clearTimeout(pendingPingTimeout)
      pendingPingTimeout = null
    }
    bridgePort = null
    const previousState = state
    state = 'disconnected'
    if (previousState !== 'disconnected') {
      notifyDisconnect(reason)
    }
  }

  const startPingKeepAlive = () => {
    if (pingIntervalId) clearInterval(pingIntervalId)
    pingIntervalId = setInterval(() => {
      if (!bridgePort) {
        teardown('port lost')
        return
      }
      // Skip if a ping is already in flight to avoid overwriting the pending timeout
      if (pendingPingTimeout) return
      bridgePort.postMessage({type: config.pingType})
      pendingPingTimeout = setTimeout(() => {
        teardown('ping timeout')
      }, config.pingTimeout)
    }, config.pingInterval)
  }

  const handleBridgeMessage = (msg: {type: string; reason?: string}) => {
    if (msg.type === config.pongType && pendingPingTimeout) {
      clearTimeout(pendingPingTimeout)
      pendingPingTimeout = null
    } else if (msg.type === config.disconnectType) {
      teardown(msg.reason ?? 'device disconnected')
    }
  }

  // --------------------------------------------------------------------------
  // Wait helpers
  // --------------------------------------------------------------------------

  const waitForResponse = <T extends string>(
    expectedType: T,
    timeout: number,
  ): Promise<Record<string, unknown> & {type: T}> => {
    return new Promise((resolve, reject) => {
      if (!bridgePort) {
        reject(new Error(`${config.deviceLabel} bridge port not connected`))
        return
      }

      const port = bridgePort
      const timer = setTimeout(() => {
        port.onMessage.removeListener(handler)
        reject(new Error(`${config.deviceLabel} bridge timeout waiting for ${expectedType}`))
      }, timeout)

      const handler = (msg: {type: string; message?: string; reason?: string}) => {
        if (msg.type === expectedType) {
          clearTimeout(timer)
          port.onMessage.removeListener(handler)
          resolve(msg as Record<string, unknown> & {type: T})
        } else if (config.errorTypes.includes(msg.type)) {
          clearTimeout(timer)
          port.onMessage.removeListener(handler)
          reject(new Error(msg.message ?? `${config.deviceLabel} bridge error`))
        } else if (msg.type === config.disconnectType) {
          clearTimeout(timer)
          port.onMessage.removeListener(handler)
          reject(new Error(msg.reason ?? `${config.deviceLabel} device disconnected`))
        }
      }

      port.onMessage.addListener(handler)
    })
  }

  const waitForRequestIdResponse = <T extends string>(
    expectedType: T,
    requestId: string,
    timeout: number,
  ): Promise<Record<string, unknown> & {type: T}> => {
    return new Promise((resolve, reject) => {
      if (!bridgePort) {
        reject(new Error(`${config.deviceLabel} bridge port not connected`))
        return
      }

      const port = bridgePort
      const timer = setTimeout(() => {
        port.onMessage.removeListener(handler)
        reject(new Error(`${config.deviceLabel} bridge timeout waiting for ${expectedType}`))
      }, timeout)

      const errorType = expectedType.replace('_RESULT', '_ERROR')

      const handler = (msg: Record<string, unknown>) => {
        if (msg.type === expectedType && msg.requestId === requestId) {
          clearTimeout(timer)
          port.onMessage.removeListener(handler)
          resolve(msg as Record<string, unknown> & {type: T})
        } else if (msg.type === errorType && msg.requestId === requestId) {
          clearTimeout(timer)
          port.onMessage.removeListener(handler)
          reject(new Error((msg.message as string) ?? `${config.deviceLabel} bridge error`))
        } else if (msg.type === config.disconnectType) {
          clearTimeout(timer)
          port.onMessage.removeListener(handler)
          reject(new Error((msg.reason as string) ?? `${config.deviceLabel} device disconnected`))
        }
      }

      port.onMessage.addListener(handler)
    })
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const initListeners = () => {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== config.portName) return

      // Clean up previous connection if a new port connects (e.g., bridge tab reload)
      if (bridgePort) {
        if (pingIntervalId) {
          clearInterval(pingIntervalId)
          pingIntervalId = null
        }
        if (pendingPingTimeout) {
          clearTimeout(pendingPingTimeout)
          pendingPingTimeout = null
        }
        bridgePort = null
      }

      bridgePort = port
      state = 'ready'

      port.onMessage.addListener(handleBridgeMessage)

      port.onDisconnect.addListener(() => {
        if (port === bridgePort) teardown('port disconnected')
      })

      startPingKeepAlive()
    })

    chrome.tabs.onRemoved.addListener((tabId) => {
      if (tabId === bridgeTabId) {
        bridgeTabId = null
        teardown('bridge tab closed')
      }
    })
  }

  const openBridge = async (): Promise<void> => {
    // Serialize concurrent calls — if an open is already in flight, piggyback on it
    if (openBridgePromise) return openBridgePromise

    const doOpen = async () => {
      // Already connected
      if (state === 'ready' || state === 'connected') {
        if (bridgePort) return
      }

      // Check if existing tab is still alive
      if (bridgeTabId !== null) {
        try {
          await chrome.tabs.get(bridgeTabId)
          // Tab exists — wait for port reconnection
          if (bridgePort) return
        } catch {
          bridgeTabId = null
        }
      }

      state = 'opening'

      const bridgeUrl = chrome.runtime.getURL(config.htmlFileName)
      const tab = await chrome.tabs.create({url: bridgeUrl, active: true})
      bridgeTabId = tab.id ?? null

      // Wait for the port to connect (bridge-tab.ts calls chrome.runtime.connect)
      await new Promise<void>((resolve, reject) => {
        const checkReady = setInterval(() => {
          if (state === 'ready' || state === 'connected') {
            clearInterval(checkReady)
            clearTimeout(timer)
            resolve()
          }
        }, 100)

        const timer = setTimeout(() => {
          clearInterval(checkReady)
          reject(new Error(`${config.deviceLabel} bridge tab did not connect in time`))
        }, config.openTimeout)
      })
    }

    openBridgePromise = doOpen().finally(() => {
      openBridgePromise = null
    })
    return openBridgePromise
  }

  const closeTransport = async (closeType: string, closedType: string): Promise<void> => {
    if (!bridgePort) return

    bridgePort.postMessage({type: closeType})
    try {
      await waitForResponse(closedType, 5_000)
    } catch {
      // Best effort — transport may already be closed
    }
    // Only transition to 'ready' if teardown hasn't already moved us to 'disconnected'
    if (state !== 'disconnected') {
      state = 'ready'
    }
  }

  const closeBridge = async (): Promise<void> => {
    if (bridgeTabId !== null) {
      try {
        await chrome.tabs.remove(bridgeTabId)
      } catch {
        // Tab may already be closed
      }
      bridgeTabId = null
    }

    teardown()
  }

  return {
    initListeners,
    openBridge,
    closeBridge,
    getState: () => state,
    setState: (s: BridgeState) => {
      state = s
    },
    onDisconnect: (cb: (reason?: string) => void) => {
      disconnectListeners.add(cb)
      return () => {
        disconnectListeners.delete(cb)
      }
    },
    postMessage: (msg: unknown) => {
      if (!bridgePort) throw new Error(`${config.deviceLabel} bridge not connected`)
      bridgePort.postMessage(msg)
    },
    getPort: () => bridgePort,
    waitForResponse,
    waitForRequestIdResponse,
    closeTransport,
  }
}
