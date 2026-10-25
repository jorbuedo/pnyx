/**
 * The Cardano rail for the active wallet group.
 *
 * The implementation is a provider, not a hook — see `providers/CardanoRailProvider`
 * for why. This re-export is the import path every consumer already uses.
 *
 * @module
 */

export {type CardanoRailState, useCardanoRail} from '../providers/CardanoRailProvider'
