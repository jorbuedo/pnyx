/**
 * The CIP-30 `api.icon` we advertise to dApps.
 *
 * dApps drop this straight into an `<img src>`, and the injected provider runs
 * on the dApp's origin with no origin of our own to serve from, so a
 * self-contained `data:` URI is the only form that can work.
 *
 * The markup below is a byte-for-byte copy of
 * `app/assets/icons/PnyxLogo.svg`. It is duplicated rather than read
 * from that file because neither consumer can read it: the app ships SVGs as
 * opaque Metro asset references (`UniIcon.map.ts`), and the extension provider
 * is a JS string baked at build time. `wallet-icon.test.ts` asserts this copy
 * still equals the asset, so the two cannot drift silently.
 *
 * @module
 */

import {base64, utf8} from '@pnyx/crypto'

/** Copy of `assets/icons/PnyxLogo.svg` — the amphitheater logomark in `primary600`. */
export const PNYX_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 174 175"><path stroke="#5443D6" stroke-width="16.045" d="M147.5 36.734a78.978 78.978 0 1 1-121 0"/><path stroke="#5443D6" stroke-miterlimit="10" stroke-width="12" d="M16.045 87.5h18a52.955 52.955 0 0 0 105.91 0h-24a28.955 28.955 0 0 1-57.91 0v-6"/><path fill="#5443D6" d="M53.049 53.549h16.334v16.334H53.049zm25.784 0h16.334v16.334H78.833zm25.784 0h16.334v16.334h-16.334z"/></svg>'

/**
 * Base64 rather than percent-encoded utf8: the URI is embedded in a JS string
 * inside the injected script, and base64 has no characters that need escaping
 * at any of those layers.
 */
export const PNYX_WALLET_ICON_DATA_URI = `data:image/svg+xml;base64,${base64.encode(utf8.encode(PNYX_LOGO_SVG))}`
