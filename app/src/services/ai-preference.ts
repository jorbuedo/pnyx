/**
 * Whether the user has opted in to on-device AI features (Phase 14 item 38).
 *
 * Separate from *capability*: a device can be perfectly able to run the model and the
 * user still not want the feature. Both must be true before anything AI-shaped
 * appears, and this is the half the user controls.
 *
 * Defaults to **off**. The model is a large download the OS performs on demand and the
 * output is generated text about the user's own transactions — neither is something to
 * switch on for someone without asking.
 *
 * @module
 */

import {logger} from '../logger'
import {storage} from '../platform/storage'

export const AI_OPT_IN_KEY = '@pnyx/ai/opt-in'

/** Read the preference. Any storage failure reads as opted out — the safe direction. */
export const isAiOptedIn = async (): Promise<boolean> => {
  try {
    return (await storage.get(AI_OPT_IN_KEY)) === 'true'
  } catch (e) {
    logger.warn('Failed to read AI opt-in', {origin: 'AiPreference', error: String(e)})
    return false
  }
}

export const setAiOptedIn = async (enabled: boolean): Promise<void> => {
  try {
    await storage.set(AI_OPT_IN_KEY, enabled ? 'true' : 'false')
  } catch (e) {
    logger.warn('Failed to persist AI opt-in', {origin: 'AiPreference', error: String(e)})
  }
}
