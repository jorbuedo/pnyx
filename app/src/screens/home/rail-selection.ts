/**
 * Persistence for what the community rail has selected.
 *
 * Selection is app state, not a route param — `/community/[id]` deep links write here and land on
 * `/home`, which reads it back on focus.
 *
 * The rail can select a **community**, **direct messages**, or **discover**, and neither of the
 * latter two is a circle. Rather than reuse the circle slot with a magic id — which would eventually
 * collide with a real circle — the stored value is tagged: `dm` for direct messages, `discover` for
 * the discover pane, anything else is a circle id. Neither sentinel is a valid circle id (ids are
 * uuid-shaped), so no existing stored value can be misread as one and no migration is needed.
 *
 * @module
 */

import {storage} from '../../platform/storage'

const SELECTED_COMMUNITY_KEY = '@pnyx/selected_community'
const DM_SENTINEL = 'dm'
const DISCOVER_SENTINEL = 'discover'
const INFO_SENTINEL = 'info'

/** What the rail currently has selected. `undefined` means "nothing chosen yet". */
export type RailSelection =
  | {readonly kind: 'dm'}
  | {readonly kind: 'discover'}
  | {readonly kind: 'info'}
  | {readonly kind: 'circle'; readonly id: string}

export const readRailSelection = (): RailSelection | undefined => {
  const value = storage.getSync(SELECTED_COMMUNITY_KEY)
  if (value === null || value.length === 0) return undefined
  if (value === DM_SENTINEL) return {kind: 'dm'}
  if (value === DISCOVER_SENTINEL) return {kind: 'discover'}
  if (value === INFO_SENTINEL) return {kind: 'info'}
  return {kind: 'circle', id: value}
}

export const writeRailSelection = (selection: RailSelection): void => {
  const SENTINELS = {dm: DM_SENTINEL, discover: DISCOVER_SENTINEL, info: INFO_SENTINEL} as const
  const value = selection.kind === 'circle' ? selection.id : SENTINELS[selection.kind]
  void storage.set(SELECTED_COMMUNITY_KEY, value)
}

/**
 * The selected circle id, or `undefined` when DMs are selected.
 *
 * Kept as a helper because most callers only care about the community case, and writing
 * `selection?.kind === 'circle' ? selection.id : undefined` at each of them invites one of them
 * getting it subtly wrong.
 */
export const selectedCircleId = (selection: RailSelection | undefined): string | undefined =>
  selection?.kind === 'circle' ? selection.id : undefined
