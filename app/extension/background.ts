/// <reference types="chrome" />
/**
 * Extension background service worker.
 *
 * One `onMessage` switch over three concerns, tried in order: hardware-wallet
 * BLE routing (`hw-messages.ts`), the dApp CIP-30 flow (`dapp/`), and the
 * display-surface handlers the app-bundle client
 * (`src/platform/extension/surfaces.ts`) speaks. See `docs/EXTENSION.md`.
 *
 * @module
 */

import {ApiErrorCode, SESSION_MAX_AGE_MS, WireError} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import {deliverToApprovalSurface, initApprovalSurface} from './dapp/approval-surface'
import {type ConnectDecision, DAPP_SNAPSHOT_KEY, type DappSnapshot} from './dapp/protocol'
import {createDappRouter} from './dapp/router'
import {makeSessionPort} from './dapp/session-port'
import {makeChromeSessionStore} from './dapp/session-store'
import {handleHardwareMessage, initHardwareBridges} from './hw-messages'

const FULLSCREEN_PARAM = 'fullscreen=true'

/** Build an in-extension URL for the app shell, optionally at a hash route. */
const shellUrl = (params: string, route?: string): string => {
  const base = chrome.runtime.getURL(`index.html?${params}`)
  return route ? `${base}#${route}` : base
}

/** Open (or focus) a fullscreen wallet tab, optionally at a specific route. */
const openFullscreenTab = async (route?: string): Promise<void> => {
  await chrome.tabs.create({url: shellUrl(FULLSCREEN_PARAM, route)})
}

/** Open the side panel for a given window, when the API is available. */
const openSidePanelForWindow = async (windowId: number | undefined): Promise<void> => {
  if (windowId === undefined || typeof chrome.sidePanel?.open !== 'function') return
  await chrome.sidePanel.open({windowId})
}

type SurfaceMessage =
  | {type: 'OPEN_SIDE_PANEL'}
  | {type: 'CLOSE_SIDE_PANEL'}
  | {type: 'OPEN_FULLSCREEN'; route?: string}
  | {type: 'HANDOFF_SOCIAL_TO_FULLSCREEN'; payload: {route: string; windowId?: number}}

const isSurfaceMessage = (m: unknown): m is SurfaceMessage =>
  typeof m === 'object' && m !== null && typeof (m as {type?: unknown}).type === 'string'

// The toolbar action opens the side panel directly.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {})
})
void chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {})

// Port/tab/window listeners must be registered synchronously on first load.
initHardwareBridges()
initApprovalSurface()

// dApp CIP-30 router: answers reads from the app-published snapshot; connect/sign
// broadcast to the app and await its decision. See docs/EXTENSION.md.
const loadSnapshot = (): Effect.Effect<DappSnapshot | null> =>
  Effect.promise(
    () =>
      new Promise<DappSnapshot | null>((resolve) => {
        chrome.storage.local.get(DAPP_SNAPSHOT_KEY, (r) => {
          const v = r[DAPP_SNAPSHOT_KEY]
          resolve(v != null && typeof v === 'object' ? (v as DappSnapshot) : null)
        })
      }),
  )

const dappRouter = createDappRouter({
  loadSnapshot,
  sessions: makeSessionPort(makeChromeSessionStore()),
  broadcast: (message) => {
    // Opens a popup when no wallet surface is listening, so an approval never
    // sits undelivered until the router's decision timeout.
    void deliverToApprovalSurface(message)
  },
  submitTx: (signedTxHex) =>
    Effect.async<string, WireError>((resume) => {
      chrome.runtime.sendMessage(
        {type: 'DAPP_SUBMIT_TX', signedTxHex},
        (resp: {hash?: string; error?: {message?: string}} | undefined) => {
          if (chrome.runtime.lastError || !resp || resp.error || typeof resp.hash !== 'string') {
            resume(
              Effect.fail(
                new WireError({
                  code: ApiErrorCode.InternalError,
                  message: resp?.error?.message ?? chrome.runtime.lastError?.message ?? 'submit unavailable',
                }),
              ),
            )
            return
          }
          resume(Effect.succeed(resp.hash))
        },
      )
    }),
})

/**
 * The origin Chrome vouches for on a content-script message. `sender.origin` is
 * the page's own origin; `sender.url` is the fallback for older Chrome builds.
 * Never read the origin out of the message payload — the page controls that.
 */
const senderOrigin = (sender: chrome.runtime.MessageSender): string | undefined => {
  if (typeof sender.origin === 'string' && sender.origin !== '') return sender.origin
  return sender.url
}

/**
 * Route dApp connector messages. Returns `true` (async response) when handled,
 * or `undefined` when the message is not ours.
 */
const handleDappMessage = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): true | undefined => {
  if (typeof message !== 'object' || message === null) return undefined
  const m = message as {type?: unknown}
  switch (m.type) {
    case 'DAPP_REQUEST': {
      const payload = (message as {payload: Parameters<typeof dappRouter.handle>[0]}).payload
      const origin = senderOrigin(sender)
      if (origin === undefined) {
        sendResponse({
          id: payload?.id,
          error: {code: ApiErrorCode.Refused, message: 'request origin could not be verified'},
        })
        return true
      }
      dappRouter
        .handle(payload, origin)
        .then(sendResponse, (e) =>
          sendResponse({id: undefined, error: {code: ApiErrorCode.InternalError, message: String(e)}}),
        )
      return true
    }
    case 'DAPP_CONNECT_DECISION': {
      const d = message as ConnectDecision
      // A grant is scoped to a wallet group + account; without both there is nothing to key it to.
      dappRouter.resolveConnect(
        d.origin,
        d.approved && typeof d.groupId === 'string' && typeof d.accountIndex === 'number'
          ? {
              approved: true,
              groupId: d.groupId,
              accountIndex: d.accountIndex,
              ttlMs: d.ttlMs === null ? null : (d.ttlMs ?? SESSION_MAX_AGE_MS),
            }
          : {approved: false},
      )
      sendResponse({type: 'OK'})
      return true
    }
    case 'DAPP_SIGN_DECISION': {
      const d = message as {requestId: string; result?: unknown; error?: {code: number; message: string}}
      dappRouter.resolveSign(d.requestId, d.error ? {error: d.error} : {result: d.result})
      sendResponse({type: 'OK'})
      return true
    }
    case 'DAPP_GET_SIGN_REQUEST': {
      const d = message as {requestId: string}
      sendResponse(dappRouter.getSignRequest(d.requestId))
      return true
    }
    default:
      return undefined
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Hardware-wallet + device-permission messages route to the BLE bridge managers.
  const handledByHardware = handleHardwareMessage(message, sendResponse)
  if (handledByHardware !== undefined) return handledByHardware

  const handledByDapp = handleDappMessage(message, sender, sendResponse)
  if (handledByDapp !== undefined) return handledByDapp

  if (!isSurfaceMessage(message)) return undefined

  switch (message.type) {
    case 'OPEN_SIDE_PANEL': {
      void openSidePanelForWindow(sender.tab?.windowId).then(
        () => sendResponse({type: 'OK'}),
        (e) => sendResponse({type: 'ERROR', payload: {message: String(e)}}),
      )
      return true
    }
    case 'CLOSE_SIDE_PANEL': {
      // No programmatic close API; the panel document closes itself.
      sendResponse({type: 'OK'})
      return undefined
    }
    case 'OPEN_FULLSCREEN': {
      void openFullscreenTab(message.route).then(
        () => sendResponse({type: 'OK'}),
        (e) => sendResponse({type: 'ERROR', payload: {message: String(e)}}),
      )
      return true
    }
    case 'HANDOFF_SOCIAL_TO_FULLSCREEN': {
      void openFullscreenTab(message.payload.route).then(
        () => sendResponse({type: 'OK'}),
        (e) => sendResponse({type: 'ERROR', payload: {message: String(e)}}),
      )
      return true
    }
    default:
      return undefined
  }
})
