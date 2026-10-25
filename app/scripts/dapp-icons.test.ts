import {describe, expect, it} from 'vitest'
import {
  collidingEntries,
  duplicateIds,
  entriesNeedingIcons,
  iconObjectKey,
  iconPublicUrl,
  iconsFromManifest,
  isRasterizable,
  largestDeclaredSize,
  manifestUrl,
  normalizedDestination,
  pngFromIco,
  resolveHref,
  selectArtwork,
} from './dapp-icons'

const PAGE = 'https://example.com/app/'

describe('resolveHref', () => {
  it('resolves a relative href against the page', () => {
    expect(resolveHref('../icon.png', PAGE)).toBe('https://example.com/icon.png')
  })

  it('keeps an absolute href', () => {
    expect(resolveHref('https://cdn.example.com/a.png', PAGE)).toBe('https://cdn.example.com/a.png')
  })

  it('refuses a data URI, which would be inlined into the config instead of published', () => {
    expect(resolveHref('data:image/png;base64,iVBORw0K', PAGE)).toBeNull()
  })

  it('returns null for an unparseable href rather than a broken URL', () => {
    expect(resolveHref('http://[', PAGE)).toBeNull()
    expect(resolveHref('   ', PAGE)).toBeNull()
  })
})

describe('largestDeclaredSize', () => {
  it('takes the longest edge across every declared pair', () => {
    expect(largestDeclaredSize('16x16 32x32 180x180')).toBe(180)
  })

  it('takes the longer edge of a non-square declaration', () => {
    expect(largestDeclaredSize('64x128')).toBe(128)
  })

  it('reports absence for "any" and for a missing attribute, never 0', () => {
    expect(largestDeclaredSize('any')).toBeNull()
    expect(largestDeclaredSize(null)).toBeNull()
  })
})

describe('selectArtwork', () => {
  it('ranks apple-touch-icon above a link icon above og:image', () => {
    const html = `
      <meta property="og:image" content="/social.png">
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="/touch.png" sizes="180x180">
    `
    expect(selectArtwork(html, PAGE).map((c) => c.kind)).toEqual(['apple-touch-icon', 'link-icon', 'og:image'])
  })

  it('prefers the larger of two same-kind candidates', () => {
    const html = `
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="icon" href="/big.png" sizes="192x192">
    `
    expect(selectArtwork(html, PAGE)[0]).toMatchObject({url: 'https://example.com/big.png', size: 192})
  })

  it('sorts an undeclared size below a declared one, so a 16px favicon does not win', () => {
    const html = `
      <link rel="icon" href="/unknown.png">
      <link rel="icon" href="/known.png" sizes="64x64">
    `
    expect(selectArtwork(html, PAGE).map((c) => c.url)).toEqual([
      'https://example.com/known.png',
      'https://example.com/unknown.png',
    ])
  })

  it('reads single-quoted and unquoted attributes', () => {
    const html = `<link rel='apple-touch-icon' href='/a.png'><link rel=icon href=/b.png>`
    expect(selectArtwork(html, PAGE).map((c) => c.url)).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.png',
    ])
  })

  it('treats rel="shortcut icon" as an icon', () => {
    expect(selectArtwork('<link rel="shortcut icon" href="/f.png">', PAGE)).toHaveLength(1)
  })

  it('accepts apple-touch-icon-precomposed', () => {
    const [c] = selectArtwork('<link rel="apple-touch-icon-precomposed" href="/p.png">', PAGE)
    expect(c?.kind).toBe('apple-touch-icon')
  })

  it('finds nothing in a page that declares nothing, rather than inventing a default', () => {
    expect(selectArtwork('<html><body>hi</body></html>', PAGE)).toEqual([])
  })
})

describe('manifestUrl', () => {
  it('resolves the manifest link', () => {
    expect(manifestUrl('<link rel="manifest" href="site.webmanifest">', PAGE)).toBe(
      'https://example.com/app/site.webmanifest',
    )
  })

  it('returns null when no manifest is declared', () => {
    expect(manifestUrl('<link rel="icon" href="/a.png">', PAGE)).toBeNull()
  })
})

describe('iconsFromManifest', () => {
  const HREF = 'https://example.com/app/site.webmanifest'

  it('resolves icon sources against the manifest, largest first', () => {
    const json = {
      icons: [
        {src: 'i-192.png', sizes: '192x192'},
        {src: 'i-512.png', sizes: '512x512'},
      ],
    }
    expect(iconsFromManifest(json, HREF)).toEqual([
      {url: 'https://example.com/app/i-512.png', kind: 'manifest', size: 512},
      {url: 'https://example.com/app/i-192.png', kind: 'manifest', size: 192},
    ])
  })

  it('skips malformed entries instead of failing the whole manifest', () => {
    const json = {icons: [{sizes: '48x48'}, 'nope', null, {src: '/ok.png', sizes: '48x48'}]}
    expect(iconsFromManifest(json, HREF).map((c) => c.url)).toEqual(['https://example.com/ok.png'])
  })

  it('returns nothing for a manifest with no icons array', () => {
    expect(iconsFromManifest({name: 'App'}, HREF)).toEqual([])
    expect(iconsFromManifest(null, HREF)).toEqual([])
    expect(iconsFromManifest('{}', HREF)).toEqual([])
  })
})

describe('isRasterizable', () => {
  it('accepts what sharp can read', () => {
    for (const u of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', 'a.svg', 'a.png?v=2', 'a.png#x']) {
      expect(isRasterizable(`https://example.com/${u}`)).toBe(true)
    }
  })

  it('rejects .ico, which needs unwrapping first', () => {
    expect(isRasterizable('https://example.com/favicon.ico')).toBe(false)
  })
})

/** Minimal ICO: `count` directory entries, each pointing at `payloads[i]`. */
const buildIco = (payloads: readonly Uint8Array[]): Uint8Array => {
  const header = 6 + payloads.length * 16
  const total = header + payloads.reduce((n, p) => n + p.length, 0)
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, payloads.length, true)
  let offset = header
  payloads.forEach((p, i) => {
    const entry = 6 + i * 16
    view.setUint32(entry + 8, p.length, true)
    view.setUint32(entry + 12, offset, true)
    bytes.set(p, offset)
    offset += p.length
  })
  return bytes
}

const png = (payload: number[]): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...payload])

describe('pngFromIco', () => {
  it('extracts the embedded PNG', () => {
    const inner = png([1, 2, 3])
    expect(pngFromIco(buildIco([inner]))).toEqual(inner)
  })

  it('picks the largest of several embedded PNGs', () => {
    const small = png([1])
    const large = png([1, 2, 3, 4, 5, 6])
    expect(pngFromIco(buildIco([small, large]))).toEqual(large)
  })

  it('returns null for a legacy BMP-only container rather than a wrong image', () => {
    expect(pngFromIco(buildIco([new Uint8Array([0x28, 0, 0, 0, 9, 9, 9, 9])]))).toBeNull()
  })

  it('returns null for a non-ICO, a truncated header, and an empty directory', () => {
    expect(pngFromIco(png([1, 2, 3]))).toBeNull()
    expect(pngFromIco(new Uint8Array([0, 0, 1]))).toBeNull()
    expect(pngFromIco(buildIco([]))).toBeNull()
  })

  it('ignores an entry whose declared size runs past the end of the buffer', () => {
    // The offset still points at real PNG magic, so only the bounds check can
    // reject this — `subarray` would silently clamp and yield a truncated image.
    const ico = buildIco([png([1, 2, 3])])
    new DataView(ico.buffer).setUint32(6 + 8, ico.length * 4, true)
    expect(pngFromIco(ico)).toBeNull()
  })

  it('ignores an entry whose offset points past the end of the buffer', () => {
    const ico = buildIco([png([1, 2, 3])])
    new DataView(ico.buffer).setUint32(6 + 12, ico.length + 100, true)
    expect(pngFromIco(ico)).toBeNull()
  })
})

describe('iconObjectKey / iconPublicUrl', () => {
  it('keys by id, so two entries sharing a host keep separate icons', () => {
    expect(iconObjectKey('minswap')).toBe('dapps/minswap.png')
    expect(iconObjectKey('minswap-staking')).toBe('dapps/minswap-staking.png')
  })

  it('joins the base URL without doubling the slash', () => {
    expect(iconPublicUrl('https://config.example.com/', 'a')).toBe('https://config.example.com/dapps/a.png')
    expect(iconPublicUrl('https://config.example.com', 'a')).toBe('https://config.example.com/dapps/a.png')
  })
})

describe('entriesNeedingIcons', () => {
  const BASE = 'https://config.example.com'
  const entries = [
    {id: 'no-logo', uri: 'https://a.example'},
    {id: 'ours', uri: 'https://b.example', logo: iconPublicUrl(BASE, 'ours')},
    {id: 'hand-set', uri: 'https://c.example', logo: 'https://c.example/icon.png'},
  ]

  it('takes entries with no logo and refreshes ones we published', () => {
    expect(entriesNeedingIcons(entries, BASE).map((e) => e.id)).toEqual(['no-logo', 'ours'])
  })

  it('leaves a hand-set first-party logo alone', () => {
    expect(entriesNeedingIcons(entries, BASE).map((e) => e.id)).not.toContain('hand-set')
  })

  it('takes everything under --all', () => {
    expect(entriesNeedingIcons(entries, BASE, true)).toHaveLength(3)
  })
})

describe('duplicateIds', () => {
  it('names every id used more than once', () => {
    const entries = [
      {id: 'a', uri: 'https://one.example'},
      {id: 'b', uri: 'https://two.example'},
      {id: 'a', uri: 'https://three.example'},
      {id: 'b', uri: 'https://four.example'},
    ]
    expect(duplicateIds(entries)).toEqual(['a', 'b'])
  })

  it('names an id repeated three times only once', () => {
    const entries = [1, 2, 3].map((n) => ({id: 'same', uri: `https://${n}.example`}))
    expect(duplicateIds(entries)).toEqual(['same'])
  })

  it('is empty for a clean list', () => {
    expect(
      duplicateIds([
        {id: 'a', uri: 'https://a.example'},
        {id: 'b', uri: 'https://b.example'},
      ]),
    ).toEqual([])
    expect(duplicateIds([])).toEqual([])
  })
})

describe('normalizedDestination', () => {
  it('discounts scheme case, www. and a trailing slash', () => {
    const one = normalizedDestination('https://www.cswap.fi/')
    expect(normalizedDestination('https://cswap.fi')).toBe(one)
    expect(normalizedDestination('HTTPS://WWW.CSWAP.FI/')).toBe(one)
  })

  it('keeps subdomains — two deployments are two destinations', () => {
    expect(normalizedDestination('https://app.liqwid.finance')).not.toBe(
      normalizedDestination('https://v2.liqwid.finance/'),
    )
  })

  it('keeps the path — a staking page is not its protocol', () => {
    expect(normalizedDestination('https://app.wingriders.com/launchpad')).not.toBe(
      normalizedDestination('https://app.wingriders.com'),
    )
  })

  it('compares an unparseable uri as written rather than dropping it', () => {
    expect(normalizedDestination('  Not A Url ')).toBe('not a url')
  })
})

describe('collidingEntries', () => {
  it('names two entries that open the same page', () => {
    // The real pair: one id from the CF source, one from AS, one URL.
    const collisions = collidingEntries([
      {id: 'cswap', uri: 'https://www.cswap.fi/', name: 'CSWAP'},
      {id: 'cswap-cswap', uri: 'https://www.cswap.fi/', name: 'CSWAP'},
    ])
    expect(collisions).toContainEqual({kind: 'url', value: 'cswap.fi', ids: ['cswap', 'cswap-cswap']})
  })

  it('names a shared display name at different URLs, without calling it a url collision', () => {
    const collisions = collidingEntries([
      {id: 'dexhunter', uri: 'https://www.dexhunter.io/', name: 'DexHunter'},
      {id: 'dexhunter-app', uri: 'https://app.dexhunter.io', name: 'DexHunter'},
    ])
    expect(collisions).toEqual([{kind: 'name', value: 'dexhunter', ids: ['dexhunter', 'dexhunter-app']}])
  })

  it('leaves distinct products on one domain alone', () => {
    expect(
      collidingEntries([
        {id: 'fluidtokens', uri: 'https://fluidtokens.com/', name: 'FluidTokens'},
        {id: 'bifrost', uri: 'https://bifrost.fluidtokens.com', name: 'Bifrost'},
        {id: 'aquarium', uri: 'https://aquarium.fluidtokens.com', name: 'Aquarium'},
      ]),
    ).toEqual([])
  })

  // Liqwid really was listed three times; only two of the rows spell the name identically, so the
  // third is a curator's judgement the check cannot make for them.
  it('catches the rows spelling a name identically and not a near-miss beside them', () => {
    const collisions = collidingEntries([
      {id: 'liqwid', uri: 'https://app.liqwid.finance', name: 'Liqwid'},
      {id: 'liqwid-v2', uri: 'https://v2.liqwid.finance/', name: 'Liqwid'},
      {id: 'liqwid-finance', uri: 'https://liqwid.finance', name: 'Liqwid Finance'},
    ])
    expect(collisions).toEqual([{kind: 'name', value: 'liqwid', ids: ['liqwid', 'liqwid-v2']}])
  })

  it('ignores a missing or blank name rather than matching entries on it', () => {
    expect(
      collidingEntries([
        {id: 'a', uri: 'https://a.example'},
        {id: 'b', uri: 'https://b.example', name: '  '},
        {id: 'c', uri: 'https://c.example'},
      ]),
    ).toEqual([])
  })

  it('is empty for a clean list', () => {
    expect(collidingEntries([])).toEqual([])
  })
})
