/**
 * Catches deep links that arrive while the profile gate is up.
 *
 * Must be mounted **above** {@link ProfileGate}. `useDeepLinkHandler` registers
 * its `Linking` listener inside the provider tree, which the gate does not
 * mount until a PIN is entered — so a warm `url` event during that window is
 * lost with no second chance (unlike a cold-start URL, which
 * `Linking.getInitialURL()` still returns afterwards).
 *
 * Parking is unconditional and harmless: once a profile is open the gate
 * consumes the buffer and re-opens the URL through the normal path, which still
 * lands on the link-action sheet and still waits for the user.
 *
 * @module
 */

import {useEffect} from 'react'
import {Linking} from 'react-native'
import {isNative} from '../platform'
import {parkDeepLink} from '../services/pending-deep-link'
import {isGateOpen} from '../services/profile/gate-state'

export function useGateDeepLinkBuffer(): void {
  useEffect(() => {
    if (!isNative) return
    const sub = Linking.addEventListener('url', ({url}) => {
      // Once the gate is open the normal handler is mounted and will take it;
      // parking as well would replay the same link twice.
      if (isGateOpen()) return
      void parkDeepLink(url)
    })
    return () => sub.remove()
  }, [])
}
