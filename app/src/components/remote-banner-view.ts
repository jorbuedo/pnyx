/**
 * Pure mapping from a remote-config banner to the shape `BannerCard` renders.
 *
 * Split out of `RemoteBanners.tsx` so the rules below can be tested without a
 * React tree: which surface a banner belongs to, how its image URL resolves, and
 * — the one worth pinning — whether its CTA navigates inside the app or leaves it.
 *
 * @module
 */

import {getRemoteConfigAssetUrl, type RemoteBanner, type RemoteBannerSlot} from '@pnyx/config'
import type {RemoteBannerContent} from '../services/remote-banner-content'
import type {Banner} from './BannerCard'

/**
 * The surface a banner renders on. Absent `slot` means `'home'`, so configs
 * written before slots existed keep working rather than vanishing.
 */
export const bannerSlot = (banner: RemoteBanner): RemoteBannerSlot => banner.slot ?? 'home'

/**
 * Absolute URL for a banner image. A bare path is resolved against the config
 * bucket, so artwork can be published next to the banner it belongs to.
 */
export const remoteBannerImageUrl = (imageUrl: string | undefined): string | undefined => {
  if (!imageUrl) return undefined
  if (/^https?:\/\//.test(imageUrl)) return imageUrl
  return getRemoteConfigAssetUrl(imageUrl)
}

/**
 * How a CTA opens: a leading `/` is an in-app route, anything else leaves the
 * app through the system browser.
 *
 * There is deliberately no allowlist check. The banner and `allowedLinks` are
 * siblings in one remote-config JSON, so anyone able to publish a malicious
 * banner can publish themselves onto the allowlist in the same write — the gate
 * would be theatre. The trust boundary is who can write the bucket, not this
 * function. (`allowed-links.ts` exists for push payloads, which *do* come from
 * outside that control plane.)
 */
export const ctaActionType = (ctaLink: string): 'navigation' | 'link' =>
  // A single leading slash only. `//host/path` is protocol-relative — external
  // despite the slash — and handing it to the router produced a tappable banner
  // that navigated nowhere.
  /^\/(?!\/)/.test(ctaLink) ? 'navigation' : 'link'

/** Banners for `slot` that the user has not already dismissed. */
export const visibleBanners = (
  banners: readonly RemoteBanner[],
  slot: RemoteBannerSlot,
  dismissedIds: ReadonlySet<string>,
): readonly RemoteBanner[] =>
  banners.filter((b) => bannerSlot(b) === slot && !(b.isDismissible && dismissedIds.has(b.id)))

/**
 * The `BannerCard` props for a banner whose copy has arrived.
 *
 * Copy is a required argument rather than an optional field: a banner with no
 * resolved content must not render, and making that unrepresentable here keeps
 * the caller from filling the gap with a placeholder.
 */
export const toBannerCard = (banner: RemoteBanner, content: RemoteBannerContent): Banner => {
  const imageUrl = remoteBannerImageUrl(banner.imageUrl)
  return {
    bannerId: banner.id,
    title: content.title,
    description: content.message,
    ...(content.actionLabel === undefined ? {} : {actionLabel: content.actionLabel}),
    ...(imageUrl === undefined ? {} : {imageUrl}),
    isDismissible: banner.isDismissible,
    priorityWeight: banner.priorityWeight,
    testID: `remote-banner-${banner.id}`,
    hideChevron: true,
    ...(banner.ctaLink ? {type: ctaActionType(banner.ctaLink), destination: banner.ctaLink} : {}),
  }
}
