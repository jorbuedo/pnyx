/**
 * The identity's registration state for a UI surface.
 *
 * Thin on purpose — the rule lives in `services/identity-registration-state.ts` so it can be tested
 * without a React tree. This only gathers the inputs.
 *
 * **Why the contract address is derived here.** The durable flag is keyed on
 * `{network, contractAddress, identity}` so a template change invalidates it, which means reading it
 * needs the address. Deriving it is local hashing over `C` plus a cached verifier-key download, so this
 * is normally free. When it fails the flag reads as absent and the state degrades to `unknown` — the
 * honest answer, not a claim that the identity is unregistered.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {useEffect, useState} from 'react'
import {logger} from '../logger'
import {usePnyxSession} from '../providers'
import {identityContractAddressForPnyxId} from '../services/identity-contract'
import {isIdentityRegistered} from '../services/identity-registration-cache'
import {type IdentityRegistrationState, identityRegistrationState} from '../services/identity-registration-state'

export const useIdentityRegistrationState = (): IdentityRegistrationState => {
  const {session, identity, signInError} = usePnyxSession()
  const [cachedRegistered, setCachedRegistered] = useState(false)

  const pnyxId = identity?.pnyxId
  const network = identity?.network
  const hasSession = session !== undefined

  useEffect(() => {
    if (pnyxId === undefined || network === undefined) {
      setCachedRegistered(false)
      return
    }
    // A live session already settles the state as `active`, so the durable flag is only needed once
    // the session is gone. Returning here keeps the last value — never read in that state — and avoids
    // an `/auth/config` round trip on every signed-in visit to the tab.
    if (hasSession) return
    let active = true
    void (async () => {
      // Derived from this identity's `C`, so it needs no service round trip at all — the previous
      // version fetched `/auth/config` for an address that could only ever have named one identity's
      // contract.
      const contractAddress = await identityContractAddressForPnyxId(pnyxId)
        .then((address) => hex.encode(address))
        .catch((error: unknown) => {
          logger.warn('registration state could not derive the contract address', {
            origin: 'useIdentityRegistrationState',
            error: String(error),
          })
          return undefined
        })
      if (!active) return
      // No address means we could not look, which is not evidence of absence — the rule turns a
      // `false` here into `unknown` rather than `unregistered` unless a login was actually refused.
      setCachedRegistered(
        contractAddress !== undefined && isIdentityRegistered({identity: pnyxId, network, contractAddress}),
      )
    })()
    return () => {
      active = false
    }
    // `hasSession` is a real dependency, not a refresh hack: a session lapsing is exactly when the
    // flag becomes the deciding input, so the read has to happen on that transition.
  }, [pnyxId, network, hasSession])

  return identityRegistrationState({
    hasIdentity: identity !== undefined,
    hasSession: session !== undefined,
    cachedRegistered,
    lastFailure: signInError,
  })
}
