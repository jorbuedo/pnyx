/// <reference types="chrome" />
/**
 * Content script (isolated world).
 *
 * 1. Injects the CIP-30 provider into the page's main world.
 * 2. Relays the provider's `DappMessage`s to the background and posts the
 *    `WalletResponse` back to the page.
 *
 * Flow: dApp → provider (`window.postMessage {__pnyxDappRequest}`) →
 * content-script (`chrome.runtime`) → background → content-script →
 * provider (`window.postMessage {__pnyxDappResponse}`) → dApp.
 * See `docs/EXTENSION.md`.
 *
 * @module
 */

// Skip the extension's own dev iframe (localhost embedded in chrome-extension://),
// which matches <all_urls> but must not receive a provider or relay.
const isExtensionOwnDevIframe = (() => {
  if (window === window.top) return false
  if (location.hostname !== 'localhost') return false
  try {
    // Cross-origin access throws when the parent is chrome-extension:// (the dev iframe host).
    void parent.location.protocol
    return false
  } catch {
    return true
  }
})()

if (!isExtensionOwnDevIframe) {
  // 1. Inject the provider into the main world. A chrome-extension:// <script src>
  //    (web_accessible_resource) is allowed under a strict page CSP, unlike inline injection.
  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('content/cardano-provider.js')
  script.onload = () => script.remove()
  ;(document.head || document.documentElement).appendChild(script)

  // 2. Relay provider requests → background, and background responses → provider.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as {__pnyxDappRequest?: {id?: unknown}} | null
    if (!data || typeof data !== 'object' || data.__pnyxDappRequest == null) return

    const message = data.__pnyxDappRequest
    const id = typeof message.id === 'string' ? message.id : undefined

    chrome.runtime.sendMessage({type: 'DAPP_REQUEST', payload: message}, (response) => {
      if (chrome.runtime.lastError || !response) {
        // No handler / port closed — reject the pending dApp call cleanly.
        window.postMessage(
          {
            __pnyxDappResponse: {
              id,
              error: {code: -1, message: chrome.runtime.lastError?.message ?? 'wallet unavailable'},
            },
          },
          window.location.origin,
        )
        return
      }
      // `response` is a WalletResponse ({id, result?, error?}).
      window.postMessage({__pnyxDappResponse: response}, window.location.origin)
    })
  })
}
