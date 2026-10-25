/**
 * The running name claim, for any surface that wants to show it.
 *
 * `useSyncExternalStore` rather than an effect + state: the store is the source of truth and a
 * subscriber that renders one render late would show a phase the claim has already left.
 *
 * @module
 */

import {useSyncExternalStore} from 'react'
import {type ClaimProgress, claimSnapshot, subscribeToClaim} from '../services/handle-claim-progress'

export const useClaimProgress = (): ClaimProgress | undefined =>
  useSyncExternalStore(subscribeToClaim, claimSnapshot, claimSnapshot)
