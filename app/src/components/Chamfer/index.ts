/**
 * Chamfered-corner surfaces.
 *
 * @module
 */

export type {ChamferBrackets, ChamferPaintProps, ChamferSize, ChamferSurfaceProps} from './ChamferSurface'
export {ChamferBackground, ChamferSurface, HIGHLIGHT_BRACKETS} from './ChamferSurface'
export type {ChamferCorners, ChamferCut, ChamferPathInput} from './chamfer-path'
export {chamferBracketPaths, chamferPath, chamferSizeForHeight, clampCorners, cornersForCut} from './chamfer-path'
export type {ChamferedStyle, ChamferOwnedProperty} from './owned-surface'
export {CHAMFER_OWNED_SURFACE, chamferedSurfaceStyle} from './owned-surface'
