import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {CHAMFER_OWNED_SURFACE, chamferedSurfaceStyle} from './owned-surface'

describe('chamferedSurfaceStyle', () => {
  it('puts the owned corner after the caller style', () => {
    const composed = chamferedSurfaceStyle({padding: 8, borderRadius: 12} as never)

    expect(composed).toEqual([{padding: 8, borderRadius: 12}, CHAMFER_OWNED_SURFACE])
    expect(composed.at(-1)).toBe(CHAMFER_OWNED_SURFACE)
  })

  it('drops the falsy entries a conditional style produces', () => {
    expect(chamferedSurfaceStyle({padding: 8}, false, null, undefined)).toEqual([{padding: 8}, CHAMFER_OWNED_SURFACE])
  })

  it('keeps caller order, so the last caller style still wins over the earlier ones', () => {
    expect(chamferedSurfaceStyle({padding: 8}, {padding: 16})).toEqual([
      {padding: 8},
      {padding: 16},
      CHAMFER_OWNED_SURFACE,
    ])
  })

  it('owns every property that would reintroduce a rectangular corner', () => {
    expect(CHAMFER_OWNED_SURFACE).toEqual({
      borderRadius: 0,
      borderWidth: 0,
      overflow: 'visible',
      backgroundColor: 'transparent',
    })
  })
})

/**
 * The guard only holds while every painted surface applies it, and while no caller
 * hands one a property it owns. Both are properties of the source, not of a
 * render, so they are checked by scanning it — a new painted component that
 * exposes a `style` prop and forgets the guard fails here rather than shipping a
 * silently re-rounded corner.
 */
const APP = join(import.meta.dirname, '..', '..', '..')
/** Both trees: the Expo routes under `app/` paint surfaces too, and are easy to forget. */
const ROOTS = [join(APP, 'src'), join(APP, 'app')] as const
const OWNED = ['borderRadius', 'borderWidth', 'overflow', 'backgroundColor'] as const
/** Paints its own box, so its `style` prop reaches a painted surface. */
const PAINTED_COMPONENTS = ['Card', 'ChamferSurface'] as const

const sourceFiles = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)

    if (statSync(path).isDirectory()) return sourceFiles(path)

    return path.endsWith('.tsx') || path.endsWith('.ts') ? [path] : []
  })

const relative = (path: string) => path.slice(APP.length + 1)

/**
 * Comments have to go before the guard-usage check: a module doc that merely
 * *names* the guard would otherwise satisfy it, which is the same
 * declared-but-ignored failure the guard exists to prevent.
 */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** Extracts a top-level `key: {…}` / `key: (args) => ({…})` body from a stylesheet. */
const styleBody = (source: string, key: string): string | null => {
  const opener = new RegExp(`\\n {2}${key}:\\s*(\\([^)]*\\)\\s*=>\\s*)?\\(?\\{`).exec(source)

  if (!opener) return null

  let depth = 0

  for (let i = source.indexOf('{', opener.index + opener[0].length - 1); i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(opener.index, i + 1)
  }

  return null
}

/**
 * Surfaces that stay rounded, each for a reason that is not "nobody got to it".
 * Adding a line here is a design decision; the shape of the entry is `file → styleKey`.
 */
const ROUNDED_SURFACE_EXEMPTIONS: readonly string[] = [
  // A switch: the track and knob are the affordance, the same way a circle is.
  'src/components/Toggle.tsx → containerBackground',
  'src/components/Toggle.tsx → knob',
  // A dot. Sized from a prop, so the circle rule below cannot see it.
  'src/notices/NoticeDot.tsx → base',
  // Clips the blur target that hides the phrase — a cut cannot clip.
  'src/components/MnemonicDisplay.tsx → gridContainer',
  // Its fill is an alpha-composed literal rather than a token, so painting it
  // would need either a new token or a theme read in the screen.
  'app/settings/recovery-phrase-warn.tsx → checkItem',
]

/** Splits a stylesheet into its top-level `key: {…}` / `key: (…) => ({…})` objects. */
const styleObjects = (source: string): Array<{key: string; body: string}> => {
  const found: Array<{key: string; body: string}> = []
  const opener = /\n {2}(\w+):\s*(?:\([^)]*\)\s*=>\s*)?\(?\{/g
  let match = opener.exec(source)

  while (match !== null) {
    const start = source.indexOf('{', match.index + match[0].length - 1)
    let depth = 0

    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++
      if (source[i] === '}' && --depth === 0) {
        found.push({key: match[1] as string, body: source.slice(start, i + 1)})
        break
      }
    }

    match = opener.exec(source)
  }

  return found
}

const literal = (body: string, property: string): number | null => {
  const match = new RegExp(`${property}:\\s*(\\d+)[,\\n]`).exec(body)

  return match ? Number(match[1]) : null
}

/** The rule `SkeletonBase` uses: a radius at least half the short side is a circle. */
const isCircle = (body: string): boolean => {
  const radiusExpr = /borderRadius:\s*([^,\n}]+)/.exec(body)?.[1] ?? ''

  if (/roundedCircle|9999/.test(radiusExpr)) return true

  const width = literal(body, 'width')
  const height = literal(body, 'height')
  const radius = literal(body, 'borderRadius')
  const short = width !== null && height !== null ? Math.min(width, height) : (width ?? height)

  return radius !== null && short !== null && radius * 2 >= short
}

/** Indicators and progress tracks are too thin to read a corner treatment. */
const isHairline = (body: string): boolean => {
  const width = literal(body, 'width')
  const height = literal(body, 'height')
  const short = width !== null && height !== null ? Math.min(width, height) : (width ?? height)

  return short !== null && short <= 8
}

const files = ROOTS.flatMap(sourceFiles).map((path) => ({path, source: readFileSync(path, 'utf8')}))

describe('the chamfer guard is applied wherever a surface is painted', () => {
  it('finds the painted components (guards against a rename silently emptying this suite)', () => {
    const painters = files.filter(({source}) => /ChamferBackground|ChamferSurface/.test(source))

    expect(painters.length).toBeGreaterThan(20)
  })

  it('has every painted component that takes a style prop apply the owned corner', () => {
    const offenders = files
      .filter(({path}) => !relative(path).startsWith(join('src', 'components', 'Chamfer')))
      .map(({path, source}) => ({path, source: withoutComments(source)}))
      .filter(({source}) => /\bChamferBackground\b|\bChamferSurface\b/.test(source))
      // A component with no caller-facing style entry point has nothing to defend:
      // the box it paints is built entirely from its own stylesheet.
      .filter(({source}) => /(?:^|\n)\s{0,4}(?:readonly )?(?:style|containerStyles)\?:/.test(source))
      .filter(({source}) => !/chamferedSurfaceStyle\(/.test(source))
      .map(({path}) => relative(path))

    expect(offenders).toEqual([])
  })

  /**
   * The caller-facing rule above cannot see a component that fights its own paint
   * from its own stylesheet — which is how `Accordion` kept a rounded surface long
   * after everything around it was cut. A visible surface is a style object with a
   * corner radius AND a fill; a bare radius (a circle) or a bare fill (an inner row)
   * is not one.
   */
  it('leaves no rounded, filled surface outside the documented exemptions', () => {
    const found = files.flatMap(({path, source}) => {
      const file = relative(path)

      // Dev-only screens and the playground keep their plain styling on purpose.
      if (/dev|probe|playground/i.test(file)) return []
      // A camera preview, a blurred surface or an <Image> needs a real rectangular
      // clip, and `overflow: hidden` cannot follow a cut.
      if (/camera|scanner|blur|media/i.test(file)) return []

      return styleObjects(withoutComments(source))
        .filter(({body}) => /borderRadius:/.test(body) && /backgroundColor:/.test(body))
        .filter(({body}) => !isCircle(body) && !isHairline(body))
        .map(({key}) => `${file} → ${key}`)
    })

    expect(found.filter((entry) => !ROUNDED_SURFACE_EXEMPTIONS.includes(entry))).toEqual([])
  })

  it('has no caller hand a painted component a property that component owns', () => {
    const leaks = files.flatMap(({path, source}) => {
      const tags = PAINTED_COMPONENTS.flatMap(
        (component) => source.match(new RegExp(`<${component}\\b[\\s\\S]*?(?=>\\s*\\n|>\\s*<|/>)`, 'g')) ?? [],
      )

      return tags.flatMap((tag) => {
        const styleProp = /style=\{(\[[\s\S]*?\]|[^}]*)\}/.exec(tag)

        if (!styleProp?.[1]) return []

        const bodies = [
          ...[...styleProp[1].matchAll(/styles\.(\w+)/g)].map((match) => styleBody(source, match[1] as string)),
          /\{[\s\S]*\}/.exec(styleProp[1])?.[0] ?? null,
        ]

        return bodies.flatMap((body) =>
          body === null
            ? []
            : OWNED.filter((property) => new RegExp(`\\b${property}\\s*:`).test(body)).map(
                (property) => `${relative(path)} → ${property}`,
              ),
        )
      })
    })

    expect(leaks).toEqual([])
  })
})
