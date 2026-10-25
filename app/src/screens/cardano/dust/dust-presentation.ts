/**
 * How a registration state and a destination owner look on screen.
 *
 * Pure, so the mapping is testable and lives in one place rather than in JSX branches: the
 * pill's colour is a *claim about severity*, and getting it wrong (amber on a healthy
 * wallet, or neutral on a blocked one) is the kind of thing that quietly misinforms.
 *
 * @module
 */

import type {TagVariant} from '../../../components/Tag'
import type {DestinationOwner, RegistrationState} from '../../../services/midnight-dust'

export type StatusPill = {
  /** i18n key under `midnightDust.pill.*`. */
  readonly labelKey: string
  readonly variant: TagVariant
}

/**
 * `MultiRegistered` is the only error: the network ignores a multiply-registered account
 * entirely, so DUST is genuinely stopped. `NoGeneration` is amber — something is off but
 * nothing is broken and some causes need no action at all. `Unregistered` is neutral rather
 * than alarming: never having registered is a normal starting state, not a fault.
 */
export const statusPill = (state: RegistrationState): StatusPill => {
  switch (state) {
    case 'HealthyActive':
      return {labelKey: 'active', variant: 'success'}
    case 'MultiRegistered':
      return {labelKey: 'blocked', variant: 'error'}
    case 'NoGeneration':
      return {labelKey: 'notGenerating', variant: 'warning'}
    case 'Unregistered':
      return {labelKey: 'notRegistered', variant: 'secondary'}
  }
}

/**
 * i18n key under `midnightDust.owner.*` for whose address a registration points at, plus
 * the interpolation it needs.
 */
export const destinationLabel = (owner: DestinationOwner): {readonly key: string; readonly name?: string} => {
  switch (owner.kind) {
    case 'self':
      return {key: 'self'}
    case 'ownWallet':
      return {key: 'ownWallet', name: owner.walletName}
    case 'pnyx':
      return {key: 'pnyx'}
    case 'external':
      return {key: 'external'}
    case 'unknown':
      return {key: 'unknown'}
  }
}
