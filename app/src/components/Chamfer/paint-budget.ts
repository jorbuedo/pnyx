/**
 * How large a chamfer paint may get before it must not be drawn.
 *
 * The paint is a single `react-native-svg` layer covering the box it backs, and
 * Android rasterises that into one bitmap. `RecordingCanvas.throwIfCannotDraw`
 * kills the process when a bitmap exceeds ~100MB — an uncatchable native crash,
 * not a JS error — so a box tall enough to cross it takes the app with it. A
 * metadata card at ~58,000px asked for 231MB and did exactly that.
 *
 * The budget is deliberately under the platform's own cap: the sheen and bracket
 * paths draw into the same layer, and the cap is a property of the OS version
 * rather than a contract.
 *
 * @module
 */

const BYTES_PER_PIXEL = 4
/** Android's own limit is ~100MB; the margin covers the layers drawn over the fill. */
export const PAINT_BUDGET_BYTES = 64 * 1024 * 1024

/**
 * Whether a box of this size in points may be painted at this pixel ratio.
 *
 * A box that cannot is not drawn at all: it loses its background and chamfer,
 * which is a visual defect on a surface already far past any usable size, and
 * the alternative is the process dying.
 */
export const paintFitsBudget = (width: number, height: number, pixelRatio: number): boolean =>
  width * pixelRatio * height * pixelRatio * BYTES_PER_PIXEL <= PAINT_BUDGET_BYTES
