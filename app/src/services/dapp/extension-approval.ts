/**
 * App → background messages for the extension dApp approval flow. The background
 * router broadcasts `NAVIGATE_*`; the approval screens send the user's decision
 * back here and fetch pending sign-request details by id. See `docs/EXTENSION.md`.
 *
 * @module
 */

import type {SignOutcome, SignRequestDetails} from '../../../extension/dapp/router'
import {sendMessage} from '../../platform/extension/runtime'

/**
 * Report the connect decision for an origin. `target` is the wallet group +
 * account the user approved for — the grant is scoped to both, so an approval
 * without them is treated as a rejection by the router. `ttlMs` is the chosen
 * lifetime, `null` for "until revoked".
 */
export const sendConnectDecision = (
  origin: string,
  approved: boolean,
  target?: {groupId: string; accountIndex: number},
  ttlMs?: number | null,
): Promise<unknown> =>
  sendMessage({
    type: 'DAPP_CONNECT_DECISION',
    origin,
    approved,
    groupId: target?.groupId,
    accountIndex: target?.accountIndex,
    ttlMs,
  })

/** Report the signing outcome for a request. */
export const sendSignDecision = (requestId: string, outcome: SignOutcome): Promise<unknown> =>
  sendMessage({type: 'DAPP_SIGN_DECISION', requestId, ...outcome})

/** Fetch a pending sign request's details (tx/data + origin) by id. */
export const fetchSignRequest = (requestId: string): Promise<SignRequestDetails | null> =>
  sendMessage<SignRequestDetails | null>({type: 'DAPP_GET_SIGN_REQUEST', requestId})
