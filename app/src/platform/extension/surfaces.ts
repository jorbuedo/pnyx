/// <reference types="chrome" />
/**
 * Browser-extension display surfaces — side panel, fullscreen tab, transient popups.
 *
 * Two wallet display modes: the side panel (opened from the toolbar action) and a
 * wider fullscreen tab (triggered from inside the side panel). Per-request popup
 * windows for dApp approvals (`chrome.windows.create({type: 'popup'})`) are a
 * transient surface, not a wallet display mode — the background opens those (see
 * `extension/dapp/approval-surface.ts`) and `closePopup` dismisses them.
 *
 * @module
 */

import {logger} from '../../logger'
import {
  bridgeRelay,
  getCurrentWindowId,
  hasChromeRuntime,
  isExtension,
  isExtensionDevIframe,
  sendMessage,
} from './runtime'

type SidePanelResponse = {
  type: string
  payload?: {
    message?: string
  }
}

/**
 * Open the extension in the Chrome Side Panel.
 *
 * In production, sends OPEN_SIDE_PANEL to the background script which calls
 * chrome.sidePanel.open(). In dev iframe, relays through the postMessage bridge.
 */
/** A dev-iframe relay is fire-and-forget, but a failed one means the surface never opened. */
const relay = (type: string): void => {
  bridgeRelay({type}, true).catch((e) => {
    logger.warn('Extension surface relay failed', {origin: 'ExtensionSurfaces', relayType: type, error: String(e)})
  })
}

export const openSidePanel = (): void => {
  if (hasChromeRuntime) {
    chrome.runtime.sendMessage({type: 'OPEN_SIDE_PANEL'})
    return
  }

  if (isExtensionDevIframe) {
    relay('PNYX_OPEN_SIDE_PANEL')
  }
}

/**
 * Open the side panel for the current window directly from a user gesture.
 */
export const openCurrentWindowSidePanel = async (): Promise<void> => {
  if (hasChromeRuntime && typeof chrome.sidePanel?.open === 'function') {
    const windowId = await getCurrentWindowId()
    await chrome.sidePanel.open({windowId})
    return
  }

  if (!isExtension) {
    throw new Error('Side panel is unavailable outside the extension runtime')
  }

  const response = await sendMessage<SidePanelResponse>({type: 'OPEN_SIDE_PANEL'})
  if (response?.type === 'ERROR') {
    throw new Error(response.payload?.message ?? 'Failed to open side panel')
  }
}

/**
 * Open the extension in a new fullscreen tab and close the side panel.
 */
export const openFullscreen = async (): Promise<void> => {
  await sendMessage({type: 'OPEN_FULLSCREEN'})
  sendMessage({type: 'CLOSE_SIDE_PANEL'}).catch((e) => {
    logger.warn('Failed to close the side panel after going fullscreen', {
      origin: 'ExtensionSurfaces',
      error: String(e),
    })
  })
}

/**
 * Open the extension in a new fullscreen tab at a specific route.
 */
export const openFullscreenRoute = async (route: string): Promise<void> => {
  await sendMessage({type: 'OPEN_FULLSCREEN', route})
}

/**
 * Close the side panel for the current window and open the fullscreen route.
 */
export const handoffSocialToFullscreen = async (route: string): Promise<void> => {
  // windowId is optional — in dev mode chrome.windows is unavailable in the iframe.
  // The background handler will skip closing the side panel if windowId is null.
  let windowId: number | undefined
  try {
    windowId = await getCurrentWindowId()
  } catch (e: unknown) {
    // Proceed without windowId — the tab still opens, the side panel just will not auto-close.
    logger.debug('Current window id unavailable; the side panel will not auto-close', {
      origin: 'extension/surfaces',
      error: String(e),
    })
  }

  const response = await sendMessage<{type: string; payload?: {message?: string}}>({
    type: 'HANDOFF_SOCIAL_TO_FULLSCREEN',
    payload: {route, windowId},
  })

  if (response?.type === 'ERROR') {
    throw new Error(response.payload?.message ?? 'Failed to hand off to fullscreen')
  }
}

/**
 * Close the fullscreen tab.
 *
 * In production, calls window.close() directly.
 * In dev iframe, relays PNYX_POPUP_CLOSE through the bridge so
 * the parent page closes itself.
 */
export const closeFullscreen = (): void => {
  if (isExtensionDevIframe) {
    relay('PNYX_POPUP_CLOSE')
    return
  }

  window.close()
}

/**
 * Close a transient popup window (per-request dApp approval, device
 * permission tab, etc.). The wallet's main side-panel surface is left
 * alone — `window.close()` is called from inside the per-request HTML
 * document, which is hosted in a `chrome.windows.create({type:'popup'})`
 * window opened by the background script.
 *
 * In production, calls window.close() directly.
 * In dev iframe, relays PNYX_POPUP_CLOSE through the bridge so the
 * parent page (sidepanel.html / index.html in dev) calls window.close().
 */
export const closePopup = (): void => {
  if (isExtensionDevIframe) {
    relay('PNYX_POPUP_CLOSE')
    return
  }

  if (isExtension) {
    window.close()
  }
}
