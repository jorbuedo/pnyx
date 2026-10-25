/// <reference types="chrome" />
/**
 * Answers the background router's `DAPP_SUBMIT_TX` relay: the service worker has
 * no signing rail, so it forwards a dApp's `submitTx` here, where the active
 * Cardano rail broadcasts it and returns the tx hash. Extension-only; a no-op on
 * native and plain web. See `docs/EXTENSION.md`.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect} from 'react'
import {isExtension} from '../platform/extension/runtime'
import {useWalletAddress, useWalletList} from '../providers'
import {getCardanoRail} from '../services/cardano'

export function useDappSubmitHost(): void {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {getDeriveOnlyAddresses} = useWalletAddress()
  const groupId = selectedWalletGroup?.groupId ?? null

  useEffect(() => {
    if (!isExtension || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return

    const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (r: unknown) => void,
    ): boolean | undefined => {
      const m = message as {type?: unknown; signedTxHex?: unknown}
      if (m?.type !== 'DAPP_SUBMIT_TX' || typeof m.signedTxHex !== 'string') return undefined
      const signedTxHex = m.signedTxHex

      void (async () => {
        try {
          if (groupId === null) return sendResponse({error: {message: 'no wallet selected'}})
          const address = (await getDeriveOnlyAddresses()).cardano
          if (address === undefined) return sendResponse({error: {message: 'no Cardano account'}})
          const railHandle = getCardanoRail(groupId, address, undefined, {accountIndex: selectedAccountIndex})
          if (railHandle === null) return sendResponse({error: {message: 'Cardano rail unavailable'}})
          const rail = await railHandle
          const hash = await Effect.runPromise(rail.submit(signedTxHex))
          sendResponse({hash})
        } catch (e) {
          sendResponse({error: {message: e instanceof Error ? e.message : String(e)}})
        }
      })()
      return true // async response
    }

    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [groupId, getDeriveOnlyAddresses, selectedAccountIndex])
}
