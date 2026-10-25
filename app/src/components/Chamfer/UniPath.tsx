/**
 * A theme-bound SVG `Path`.
 *
 * A chamfered surface is an SVG path, so its fill and stroke land on *props*
 * rather than on a style object — which is what `withUnistyles` exists for, and
 * what keeps these surfaces on the native shadow-tree update instead of
 * re-rendering every one of them in JS on a theme switch.
 *
 * Web needs the other half of this (`UniPath.web.tsx`): there the wrapper emits
 * an HTML element inside the `<svg>`, and an SVG child of an HTML element is
 * never painted.
 *
 * @module
 */

import {Path} from 'react-native-svg'
import {withUnistyles} from 'react-native-unistyles'

export const UniPath = withUnistyles(Path)
