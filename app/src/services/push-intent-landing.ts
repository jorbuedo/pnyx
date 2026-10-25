/**
 * Maps a {@link PendingPushIntent} kind onto the route `RootIndex`
 * redirects to after the cold-start unlock. The card surfaces are gone —
 * legacy card intents land on the home screen.
 *
 * @module
 */

import type {PendingPushIntent} from './pending-push-intent'

export type PushIntentLanding = '/community' | '/menu'

export const landingForPushIntent = (intent: PendingPushIntent): PushIntentLanding => {
  switch (intent.kind) {
    case 'card-3ds':
    case 'card-activity':
    case 'card':
      return '/community'
    case 'settings':
      return '/menu'
  }
}
