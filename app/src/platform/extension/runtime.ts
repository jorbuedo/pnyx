/// <reference types="chrome" />
/**
 * Browser-extension client runtime — context detection + messaging.
 *
 * The app-side half of the `chrome.runtime` protocol the background service
 * worker answers (`app/extension/`). Live when the app bundle runs
 * inside the extension (side panel, fullscreen tab, or approval popup); every
 * predicate here is `false` on native and on the plain web target, so the
 * `chrome.*` branches are inert there. See `docs/EXTENSION.md`.
 *
 * In dev the wallet can be hosted in a cross-origin iframe (chrome.runtime
 * absent), so a postMessage bridge in the parent page relays messages to the
 * background worker; that bridge lives in the `isExtensionDevIframe` branches
 * below.
 *
 * @module
 */

import {logger} from '../../logger'
import {platformIsWeb} from '../detect'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const hasChromeRuntime = platformIsWeb && typeof chrome !== 'undefined' && !!chrome?.runtime?.id

/**
 * Detect dev-mode iframe: we are in a cross-origin iframe and chrome.runtime
 * is not available. The parent page (sidepanel.html / index.html in dev) has
 * the bridge script.
 */
const detectExtensionDevIframe = (): boolean => {
  if (!platformIsWeb) return false
  if (hasChromeRuntime) return false
  if (typeof window === 'undefined' || typeof parent === 'undefined') return false
  try {
    // If we can read parent.location.origin without error, we are same-origin -> not an iframe bridge scenario.
    // A cross-origin access throws a DOMException.
    void parent.location.origin
    return false
  } catch (e: unknown) {
    // The throw IS the detection: a cross-origin parent raises a DOMException. Logged so a
    // different failure here is not silently read as "we are in a cross-origin iframe".
    logger.debug('parent.location.origin threw; treating this as a cross-origin iframe', {
      origin: 'extension/runtime',
      error: String(e),
    })
    return true
  }
}

/**
 * Whether we are running inside the dev-mode popup iframe (localhost in chrome-extension:// parent).
 */
export const isExtensionDevIframe = detectExtensionDevIframe()

/**
 * Check if the app is running as a browser extension (production or dev iframe).
 */
export const isExtension = hasChromeRuntime || isExtensionDevIframe

/**
 * Check if running in the Chrome Side Panel (sidepanel=true URL param).
 */
export const isExtensionSidePanel =
  isExtension && platformIsWeb && typeof window !== 'undefined' && window.location.search.includes('sidepanel=true')

/**
 * Check if running in extension fullscreen tab (?fullscreen=true URL param).
 */
export const isExtensionFullscreen =
  isExtension && platformIsWeb && typeof window !== 'undefined' && window.location.search.includes('fullscreen=true')

/**
 * Check if running in a transient approval popup window (?popup=true), which the
 * background opens for a dApp connect/sign when no wallet surface is listening.
 * Such a window has no history to return to — it closes once the user decides.
 */
export const isExtensionApprovalPopup =
  isExtension && platformIsWeb && typeof window !== 'undefined' && window.location.search.includes('popup=true')

// ---------------------------------------------------------------------------
// Dev-iframe postMessage bridge (only active when isExtensionDevIframe)
// ---------------------------------------------------------------------------

type BridgeRequest = {
  type: 'PNYX_BRIDGE_REQUEST'
  id: string
  message: unknown
  fireAndForget?: boolean
}

type BridgeResponse = {
  type: 'PNYX_BRIDGE_RESPONSE'
  id: string
  response?: unknown
  error?: string
}

type BridgeBroadcast = {
  type: 'PNYX_BRIDGE_BROADCAST'
  message: unknown
}

type BridgeReady = {
  type: 'PNYX_BRIDGE_READY'
}

type BridgeMessage = BridgeResponse | BridgeBroadcast | {type: 'PNYX_BRIDGE_ACK'}

let bridgeReady = false
const pendingQueue: Array<() => void> = []
const pendingRequests = new Map<string, {resolve: (v: unknown) => void; reject: (e: Error) => void}>()
const broadcastListeners = new Set<(message: unknown) => void>()

let bridgeNextId = 0

const generateBridgeId = (): string => `bridge_${Date.now()}_${bridgeNextId++}`

/**
 * Handle messages from the parent (bridge) window.
 */
const handleBridgeMessage = (event: MessageEvent): void => {
  // Only accept messages from our parent
  if (event.source !== parent) return
  const data = event.data as BridgeMessage | undefined
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return

  switch (data.type) {
    case 'PNYX_BRIDGE_ACK': {
      bridgeReady = true
      // Flush queued messages
      for (const send of pendingQueue) {
        send()
      }
      pendingQueue.length = 0
      break
    }
    case 'PNYX_BRIDGE_RESPONSE': {
      const pending = pendingRequests.get(data.id)
      if (pending) {
        pendingRequests.delete(data.id)
        if (data.error) {
          pending.reject(new Error(data.error))
        } else {
          pending.resolve(data.response)
        }
      }
      break
    }
    case 'PNYX_BRIDGE_BROADCAST': {
      for (const listener of broadcastListeners) {
        try {
          listener(data.message)
        } catch (e: unknown) {
          // One listener must not stop the others, but a listener that throws every broadcast
          // is a feature quietly not working.
          logger.warn('Broadcast listener threw; the remaining listeners still run', {
            origin: 'extension/runtime',
            error: String(e),
          })
        }
      }
      break
    }
  }
}

// Initialize bridge if in dev iframe
if (isExtensionDevIframe) {
  window.addEventListener('message', handleBridgeMessage)

  // Signal readiness to parent
  const readyMsg: BridgeReady = {type: 'PNYX_BRIDGE_READY'}
  parent.postMessage(readyMsg, '*')
}

/**
 * Relay a request to the parent bridge window, queuing until the bridge is
 * ready. Internal to the extension client; `surfaces.ts` uses it for the
 * dev-iframe close/open relays.
 */
export const bridgeRelay = (message: unknown, fireAndForget: boolean): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const id = generateBridgeId()

    if (!fireAndForget) {
      pendingRequests.set(id, {resolve, reject})
    }

    const request: BridgeRequest = {
      type: 'PNYX_BRIDGE_REQUEST',
      id,
      message,
      ...(fireAndForget && {fireAndForget}),
    }

    const doSend = () => {
      parent.postMessage(request, '*')
      if (fireAndForget) {
        resolve(undefined)
      }
    }

    if (bridgeReady) {
      doSend()
    } else {
      pendingQueue.push(doSend)
    }
  })
}

// ---------------------------------------------------------------------------
// Messaging primitives
// ---------------------------------------------------------------------------

/**
 * Get the current browser window id for the active extension surface.
 */
export const getCurrentWindowId = async (): Promise<number> => {
  if (!hasChromeRuntime || typeof chrome.windows?.getCurrent !== 'function') {
    throw new Error('Current window id is unavailable outside the extension runtime')
  }

  return new Promise((resolve, reject) => {
    chrome.windows.getCurrent((win) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (win?.id == null) {
        reject(new Error('No current window id available'))
        return
      }
      resolve(win.id)
    })
  })
}

/**
 * Get the extension's URL for a given path.
 */
export const getExtensionURL = (path: string): string => {
  if (hasChromeRuntime) {
    return chrome.runtime.getURL(path)
  }
  return path
}

/**
 * Send a message to the background script and wait for a response.
 *
 * In production, uses chrome.runtime.sendMessage directly.
 * In dev iframe, relays through the postMessage bridge in the parent page
 * (sidepanel.html / index.html in dev).
 */
export const sendMessage = async <T = unknown>(message: unknown): Promise<T> => {
  if (isExtensionDevIframe) {
    return bridgeRelay(message, false) as Promise<T>
  }

  if (!hasChromeRuntime) {
    throw new Error('Not running in extension context')
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response)
      }
    })
  })
}

/**
 * Send a fire-and-forget message to the background script (no response expected).
 *
 * Used for approval/rejection messages where we immediately close the popup.
 */
export const sendMessageFireAndForget = (message: unknown): void => {
  if (isExtensionDevIframe) {
    bridgeRelay(message, true).catch((e) => {
      // Fire-and-forget by design, but these carry approvals — a lost one is a silent no-op.
      logger.warn('Fire-and-forget bridge message failed', {origin: 'ExtensionRuntime', error: String(e)})
    })
    return
  }

  if (hasChromeRuntime) {
    chrome.runtime.sendMessage(message)
  }
}

/**
 * Listen for broadcast messages from the background script.
 *
 * In production, uses chrome.runtime.onMessage.
 * In dev iframe, uses the bridge broadcast channel.
 *
 * @returns Cleanup function to remove the listener.
 */
export const addBroadcastListener = (handler: (message: unknown) => void): (() => void) => {
  if (isExtensionDevIframe) {
    broadcastListeners.add(handler)
    return () => {
      broadcastListeners.delete(handler)
    }
  }

  if (hasChromeRuntime && chrome.runtime.onMessage) {
    // Must NOT return true: that promises an async sendResponse this listener
    // never makes, which leaves the sender's callback pending forever with no
    // lastError. Returning undefined lets a listener that does answer (e.g.
    // useDappSubmitHost) own the channel.
    const wrappedHandler = (message: unknown) => {
      handler(message)
      return undefined
    }
    chrome.runtime.onMessage.addListener(wrappedHandler)
    return () => {
      chrome.runtime.onMessage.removeListener(wrappedHandler)
    }
  }

  // Not in extension context - no-op
  return () => {}
}
