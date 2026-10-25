/// <reference types="chrome" />
/**
 * Delivers the router's approval navigations to an app context.
 *
 * Reads are answered inside the service worker, but `enable` / `signTx` /
 * `signData` need the app UI. If a wallet surface is already listening (side
 * panel or a fullscreen tab) the broadcast reaches it directly. Otherwise a
 * popup window is opened and the broadcast retried until the app shell has
 * mounted its listeners — `chrome.sidePanel.open()` cannot be used here because
 * it requires a user gesture, and a dApp request is not one.
 *
 * @module
 */

import type {NavigateMessage} from './protocol'

const POPUP_WIDTH = 400
const POPUP_HEIGHT = 640
const RETRY_INTERVAL_MS = 250
/** How long to keep retrying while the popup's app shell boots. */
const MOUNT_TIMEOUT_MS = 30_000
/** Guard against a listener that returns `true` and never calls sendResponse. */
const DELIVER_TIMEOUT_MS = 2_000

let approvalWindowId: number | null = null

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Try to hand the message to a listening app context. Resolves false when no
 * receiver exists (`chrome.runtime.sendMessage` rejects) or it doesn't answer.
 */
const deliver = (message: NavigateMessage): Promise<boolean> =>
  Promise.race([
    chrome.runtime.sendMessage(message).then(
      () => true,
      () => false,
    ),
    sleep(DELIVER_TIMEOUT_MS).then(() => false),
  ])

/** Open (or focus) the transient approval popup hosting the app shell. */
const openApprovalWindow = async (): Promise<void> => {
  if (approvalWindowId !== null) {
    try {
      await chrome.windows.update(approvalWindowId, {focused: true})
      return
    } catch {
      approvalWindowId = null
    }
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html?popup=true'),
    type: 'popup',
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    focused: true,
  })
  approvalWindowId = created.id ?? null
}

/**
 * Register the window-lifecycle listener. Must run synchronously at background
 * load so Chrome keeps the service worker's listeners registered.
 */
export const initApprovalSurface = (): void => {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === approvalWindowId) approvalWindowId = null
  })
}

/**
 * Deliver an approval navigation, opening a popup when no surface is listening.
 * Returns once the message has been handed to the app, or when the mount window
 * elapses — the router's own decision timeout covers the give-up case.
 */
export const deliverToApprovalSurface = async (message: NavigateMessage): Promise<void> => {
  if (await deliver(message)) return

  await openApprovalWindow()

  const deadline = Date.now() + MOUNT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(RETRY_INTERVAL_MS)
    if (await deliver(message)) return
  }
}
