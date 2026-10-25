/**
 * Artwork resolution for the remote-config dApp discover tiles.
 *
 * `dapps.recommended[].logo` must be a first-party raster URL: `discoverIconUri`
 * renders nothing when it is absent, and RN's core `<Image>` decodes neither
 * `.ico` nor `.svg`. This module holds the pure half of the job that produces
 * those rasters — candidate selection and container parsing — so it can be
 * tested without a network.
 *
 * **Why this runs at curation time and not on device.** Every icon is fetched
 * from the dApp's own origin, once, by whoever curates the list; the result is
 * republished from our bucket. No device ever calls a third party to decorate a
 * tile. The predecessor did — `discoverIconUri` resolved missing logos through
 * Google's favicon service, which handed Google the promoted list and, through
 * which tiles a client requested, a read on what each user was browsing for.
 * That was removed in `f231c567`; the empty icon slot it left behind is what
 * this job fills.
 *
 * @module
 */

/** Where a candidate was found. Ordered best-first — see {@link KIND_RANK}. */
export type ArtworkKind = 'apple-touch-icon' | 'manifest' | 'link-icon' | 'favicon.ico' | 'og:image'

export type ArtworkCandidate = {
  readonly url: string
  readonly kind: ArtworkKind
  /** Longest edge the source declares, or `null` when it declares none. */
  readonly size: number | null
}

/**
 * Preference order. `og:image` is last and deliberately so: it is usually a wide
 * social banner, and a wide source centre-cropped to a square tile looks like a
 * mistake. A run that falls through to it should be reviewed by hand, not trusted.
 */
const KIND_RANK: Record<ArtworkKind, number> = {
  'apple-touch-icon': 0,
  manifest: 1,
  'link-icon': 2,
  'favicon.ico': 3,
  'og:image': 4,
}

/** Formats `sharp` can rasterize. `.ico` is handled by {@link pngFromIco} first. */
const RASTERIZABLE = /\.(png|jpe?g|webp|avif|gif|svg)(\?|#|$)/i

export const isRasterizable = (url: string): boolean => RASTERIZABLE.test(url)

/**
 * Absolute URL for `href` against `base`, or `null` when either is unparseable.
 *
 * `data:` URIs are refused: an inline icon would be embedded in the config JSON
 * rather than published as an object, which is not what the caller is building.
 */
export const resolveHref = (href: string, base: string): string | null => {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('data:')) return null
  try {
    return new URL(trimmed, base).toString()
  } catch {
    return null
  }
}

/** Longest edge in a `sizes` attribute (`"any"`, `"48x48"`, `"16x16 32x32"`). */
export const largestDeclaredSize = (sizes: string | null): number | null => {
  if (!sizes) return null
  const edges = [...sizes.matchAll(/(\d+)\s*[x×]\s*(\d+)/gi)].map((m) => Math.max(Number(m[1]), Number(m[2])))
  return edges.length === 0 ? null : Math.max(...edges)
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? null
}

const relTokens = (tag: string): string[] => (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Every artwork candidate a page offers, best-first.
 *
 * Ranking is by {@link KIND_RANK}, then by declared size descending — a source
 * that declares nothing sorts below one that declares a size, because an
 * undeclared favicon is usually 16px and upscaling it produces a blurry tile.
 */
export const selectArtwork = (html: string, pageUrl: string): readonly ArtworkCandidate[] => {
  const out: ArtworkCandidate[] = []
  const push = (href: string | null, kind: ArtworkKind, size: number | null) => {
    if (!href) return
    const url = resolveHref(href, pageUrl)
    if (url) out.push({url, kind, size})
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rels = relTokens(tag)
    const href = attr(tag, 'href')
    const size = largestDeclaredSize(attr(tag, 'sizes'))
    if (rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed')) {
      push(href, 'apple-touch-icon', size)
    } else if (rels.includes('icon') || rels.includes('shortcut')) {
      push(href, 'link-icon', size)
    }
  }

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase()
    if (key === 'og:image' || key === 'og:image:secure_url' || key === 'twitter:image') {
      push(attr(tag, 'content'), 'og:image', null)
    }
  }

  return [...out].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (b.size ?? 0) - (a.size ?? 0))
}

/** `<link rel="manifest">` target, or `null`. Fetched separately by the runner. */
export const manifestUrl = (html: string, pageUrl: string): string | null => {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (relTokens(tag).includes('manifest')) return resolveHref(attr(tag, 'href') ?? '', pageUrl)
  }
  return null
}

/**
 * Icons declared by a web app manifest. These are the best source after
 * `apple-touch-icon`: a PWA manifest usually carries a 192px or 512px square
 * built for exactly this purpose.
 */
export const iconsFromManifest = (json: unknown, manifestHref: string): readonly ArtworkCandidate[] => {
  if (typeof json !== 'object' || json === null) return []
  const icons = (json as {icons?: unknown}).icons
  if (!Array.isArray(icons)) return []
  const out: ArtworkCandidate[] = []
  for (const icon of icons) {
    if (typeof icon !== 'object' || icon === null) continue
    const {src, sizes} = icon as {src?: unknown; sizes?: unknown}
    if (typeof src !== 'string') continue
    const url = resolveHref(src, manifestHref)
    if (url) out.push({url, kind: 'manifest', size: largestDeclaredSize(typeof sizes === 'string' ? sizes : null)})
  }
  return [...out].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The largest PNG embedded in an ICO container, or `null`.
 *
 * `sharp` cannot read ICO, and most modern favicons are a PNG in an ICO wrapper,
 * so unwrapping is enough to use them. A container holding only the legacy BMP
 * encoding returns `null` — the runner reports that as unresolved rather than
 * guessing, because a wrong icon is worse than a missing one.
 */
export const pngFromIco = (bytes: Uint8Array): Uint8Array | null => {
  if (bytes.length < 6) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null
  const count = view.getUint16(4, true)
  if (count === 0 || bytes.length < 6 + count * 16) return null

  let best: Uint8Array | null = null
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const size = view.getUint32(entry + 8, true)
    const offset = view.getUint32(entry + 12, true)
    if (size === 0 || offset + size > bytes.length) continue
    const image = bytes.subarray(offset, offset + size)
    if (image.length < PNG_MAGIC.length) continue
    if (!PNG_MAGIC.every((b, n) => image[n] === b)) continue
    if (!best || image.length > best.length) best = image
  }
  return best
}

export type RecommendedEntry = {
  readonly id: string
  readonly uri: string
  readonly logo?: string
  /** Display name. Optional here only because the icon work never needs it — see {@link collidingEntries}. */
  readonly name?: string
}

/**
 * Object key an entry's icon is published under, inside the config bucket.
 *
 * Keyed by `id`, not by host: the id is what a favourite is remembered by, and
 * two entries may legitimately share a host (a protocol and its staking page).
 */
export const iconObjectKey = (id: string): string => `dapps/${id}.png`

/** Public URL the same object is served from, for writing back into `logo`. */
export const iconPublicUrl = (baseUrl: string, id: string): string =>
  `${baseUrl.replace(/\/$/, '')}/${iconObjectKey(id)}`

/**
 * Ids appearing more than once, which a caller must treat as fatal.
 *
 * `id` keys both the icon object and the favourite a user sets, so two entries
 * sharing one means the second's artwork overwrites the first's and starring
 * either stars both. Neither failure is visible in the grid — the tile just
 * shows the wrong picture — so this is refused at curation time rather than
 * shipped.
 */
export const duplicateIds = (entries: readonly RecommendedEntry[]): readonly string[] => {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const {id} of entries) {
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  return [...dupes].sort()
}

/**
 * A dApp listed twice.
 *
 * ⚠️ **Unique ids are not enough.** The published list was assembled by merging several ecosystem
 * directories, and each one names the same dApp differently: `cswap` and `cswap-cswap` pointed at
 * one URL, and Liqwid appeared three times — `app.`, `v2.` and the bare domain — as three rows all
 * labelled "Liqwid". Every id was unique, so {@link duplicateIds} passed and 195 entries reached
 * devices with eleven of them redundant.
 *
 * Two signals, deliberately separated because only one of them is always wrong:
 *
 * - `url` — the same destination after case, `www.` and a trailing slash are discounted. Two rows
 *   that open the same page can never both be right.
 * - `name` — the same case-folded display name at different URLs. Usually a marketing site beside
 *   its app, but sometimes two genuine products (a protocol and its launchpad), so it is a question
 *   for the curator rather than a verdict.
 *
 * Deliberately *not* a signal: a shared registrable domain. FluidTokens, Bifrost and Aquarium are
 * three products on one domain and all three belong on the list.
 */
export type EntryCollision = {
  readonly kind: 'url' | 'name'
  /** The normalised URL or case-folded name the entries share. */
  readonly value: string
  /** Ids sharing it, in the order they appear in the list. */
  readonly ids: readonly string[]
}

/**
 * The destination an entry points at, discounting what never distinguishes two dApps: scheme case,
 * a `www.` prefix, and a trailing slash. Subdomains are kept — `app.liqwid.finance` and
 * `v2.liqwid.finance` are different deployments, and only a curator can say whether both belong.
 *
 * An unparseable `uri` is compared as written rather than dropped: the entry is broken either way,
 * and a second copy of a broken entry is still worth naming.
 */
export const normalizedDestination = (uri: string): string => {
  try {
    const url = new URL(uri)
    const host = url.host.toLowerCase().replace(/^www\./, '')
    const path = url.pathname.replace(/\/+$/, '')
    return `${host}${path}${url.search}`
  } catch {
    return uri.trim().toLowerCase()
  }
}

/** Every URL and name shared by more than one entry — see {@link EntryCollision}. */
export const collidingEntries = (entries: readonly RecommendedEntry[]): readonly EntryCollision[] => {
  const byUrl = new Map<string, string[]>()
  const byName = new Map<string, string[]>()
  for (const entry of entries) {
    const url = normalizedDestination(entry.uri)
    byUrl.set(url, [...(byUrl.get(url) ?? []), entry.id])
    const name = entry.name?.trim().toLowerCase()
    if (name !== undefined && name !== '') byName.set(name, [...(byName.get(name) ?? []), entry.id])
  }
  const collisions = (kind: 'url' | 'name', index: Map<string, string[]>): EntryCollision[] =>
    [...index.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([value, ids]) => ({kind, value, ids}))
      .sort((a, b) => a.value.localeCompare(b.value))
  return [...collisions('url', byUrl), ...collisions('name', byName)]
}

/**
 * Entries this run should fetch artwork for.
 *
 * An entry whose `logo` already points at the bucket is refreshed; one pointing
 * anywhere else is left alone, because a hand-set first-party URL — the way
 * `glacier-redeem` carries its own `icon.png` — is a curation decision the job
 * must not overwrite. `--all` overrides that for a deliberate re-run.
 */
export const entriesNeedingIcons = (
  entries: readonly RecommendedEntry[],
  baseUrl: string,
  all = false,
): readonly RecommendedEntry[] => entries.filter((e) => all || !e.logo || e.logo === iconPublicUrl(baseUrl, e.id))
