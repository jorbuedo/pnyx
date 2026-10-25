/**
 * Where an asset's media can actually be loaded from.
 *
 * The minter's URI (CIP-25 `image`, CIP-68 `image`) is usually `ipfs://…`, which
 * no client renders directly — it needs an HTTP gateway. So:
 *
 *  - `https://` and inline `data:` URIs are already loadable and pass straight
 *    through. A `data:` URI needs no network at all.
 *  - `ipfs://` is rewritten onto the configured gateway
 *    (`EXPO_PUBLIC_CARDANO_IPFS_GATEWAY`). The default is the public IPFS gateway;
 *    it is rate-limited and shared, so a first-party proxy is the durable answer
 *    and the env var is how it gets swapped in without touching this code.
 *  - anything else resolves to `null`, and the caller renders nothing rather than
 *    a broken frame. `http://` is refused too: media over plaintext is a
 *    downgrade we do not need to accept.
 *
 * **Detail surfaces only.** Every resolved URL is one image fetch from a gateway,
 * so this belongs on a screen showing ONE asset. A list of NFTs would fire a
 * request per row — lists keep the icon path (`useTokenIconUri`), which is
 * CDN-backed and cached.
 *
 * @module
 */

import {ipfsGatewayOverride} from '../../config/env'

/** Public IPFS gateway — overridden by env once a first-party proxy exists. */
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs'

const IPFS_GATEWAY_URL = ipfsGatewayOverride() ?? DEFAULT_IPFS_GATEWAY

/** The CID (plus any path) in an `ipfs://` URI, tolerating the `ipfs://ipfs/` form. */
const ipfsPath = (uri: string): string | null => {
  const match = /^ipfs:\/\/(?:ipfs\/)?([^?#]+)/i.exec(uri.trim())
  const cid = match?.[1]
  return cid !== undefined && cid.length > 0 ? cid : null
}

/**
 * A URL an image component can load for this asset's media, or `null` when we
 * have no way to fetch it.
 */
export const assetMediaUrl = (params: {readonly image?: string | undefined}): string | null => {
  const uri = params.image?.trim()
  if (uri === undefined || uri.length === 0) return null
  if (uri.startsWith('data:') || uri.startsWith('https://')) return uri
  const cid = ipfsPath(uri)
  return cid === null ? null : `${IPFS_GATEWAY_URL}/${cid}`
}
