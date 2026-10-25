/**
 * The single character that stands for a community, for a surface that must draw *something*.
 *
 * ⚠️ **The fallback initial is furniture, not information** — it repeats the first letter of a name
 * printed beside it. It exists for the rail, where the glyph is the only content a disc has and an
 * empty one would be a community with no face at all. A surface that can render nothing — discover's
 * list, where the name is right there — reads `displayChar` directly and shows nothing when a
 * founder has chosen nothing.
 *
 * ⚠️ **Not upper-cased when it is chosen.** An emoji has no case, and upper-casing a script that
 * does have one would silently change the character its founder picked. The fallback initial *is*
 * upper-cased, because that one is ours to choose.
 *
 * @module
 */

export const circleGlyph = (circle: {readonly name: string; readonly displayChar?: string}): string =>
  circle.displayChar ?? circle.name.slice(0, 1).toUpperCase()
