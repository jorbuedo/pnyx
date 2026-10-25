/**
 * Icons this wallet ships for tokens whose issuer no icon CDN indexes.
 *
 * The ordinary icon path is SteelSwap's CDN, then cexplorer, then initials — all of which know
 * *listed* tokens. An ADA Handle is an NFT, not a listed token, so every handle in a wallet renders
 * as a generic placeholder however many the holder has. The mark is stable, tiny, and inseparable
 * from the brand, so shipping it beats fetching it.
 *
 * ⚠️ **Keyed on the policy, and the policy alone.** Every asset minted under it is a handle; there is
 * no per-asset artwork to distinguish. Anything needing per-asset media goes through
 * `assetMediaUrl`, not here.
 *
 * @module
 */

import {ADA_HANDLE_POLICY} from '../cardano/config'

/**
 * The ADA Handle mark: the green `$`, inlined as a `data:` URI.
 *
 * Inline rather than a file under `assets/` because this is consumed as a **URI** — `useTokenIconUri`
 * hands a string to `expo-image`, and a bundled `require()` does not fit that shape. `assetMediaUrl`
 * already passes `data:` straight through, so the detail surface takes it unchanged.
 *
 * ⚠️ **Square (24×24), and it has to be.** `TokenIcon` renders every icon `contentFit: 'cover'`,
 * because a CDN token logo is square and meant to fill the disc. The mark as exported is 9×14 — tall
 * and narrow — so `cover` cropped its top and bottom away, taking exactly the parts of the `$` that
 * protrude past the S and leaving what read as a fat green S. The glyph is centred in a square box
 * with padding, so `cover` and `contain` render it alike.
 *
 * ⚠️ **Optimised with svgo**, to the same rules `bun run svg:optimize` applies to files: `viewBox`
 * kept so it scales, the baked `fill` kept because the colour IS the mark. Re-optimise any
 * replacement rather than pasting an export — and re-check it renders square.
 *
 * ⚠️ **Not theme-tinted, deliberately.** A brand mark is one colour in both themes. It renders on the
 * icon circle, which is light in both, so the green stays legible — unlike an untinted SVG dropped
 * onto a dark surface, which is the usual failure here.
 */
const ADA_HANDLE_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjMGNkMTViIiBkPSJNMTAuMTQgNC4zNTlxMC0uNDg2LjcyOC0uOTFhMy42NSAzLjY1IDAgMCAxIDEuOTE2LS40NDVxLjkxOCAwIDEuMTg4LjQyNGExLjAzIDEuMDMgMCAwIDEgLjE5LjU1di42MzZhNi41IDYuNSAwIDAgMSAzLjAwOS44OXEuMzQzLjI1NS4zNDMuNDg3YTYuNyA2LjcgMCAwIDEtLjQ3OCAyLjM3cS0uNDYgMS4yNzMtLjkgMS4yNzJhMi4zIDIuMyAwIDAgMS0uNDk4LS4xOSA1LjEgNS4xIDAgMCAwLTIuMTA3LS42MTcgMi42IDIuNiAwIDAgMC0xLjEzLjE2OC41OC41OCAwIDAgMC0uMjg3LjUzcTAgLjM0LjQyMi41My41MDEuMjE3IDEuMDMyLjMzNy43MDIuMTUgMS4zNi40NDcuNzI3LjMwNiAxLjM3Ni43NmMuNDYuMzQxLjgyNC44MDIgMS4wNTggMS4zMzRhNC4wNCA0LjA0IDAgMCAxIC40MjIgMS43NzggNi4yIDYuMiAwIDAgMS0uMTU0IDEuNTAzIDQuNiA0LjYgMCAwIDEtLjUzNiAxLjIyNyAzLjUgMy41IDAgMCAxLTEuMTMyIDEuMTQ0IDUuNCA1LjQgMCAwIDEtMS44Ljcydi4zMzhxMCAuNDg2LS43MjkuOTFhMy42NCAzLjY0IDAgMCAxLTEuOTE1LjQ0NHEtLjkxNyAwLTEuMTg3LS40MjNhMS4wMyAxLjAzIDAgMCAxLS4xOTMtLjU1di0uNjM1YTExLjYgMTEuNiAwIDAgMS0yLjE2NC0uNDAycS0xLjc2MS0uNTI3LTEuNzYtMS4xNDRhMTAuMyAxMC4zIDAgMCAxIC4zMDYtMi40NTZxLjMwOS0xLjI5LjcyOC0xLjI5LjA3NyAwIDEuNTg5LjU3MmE3LjIgNy4yIDAgMCAwIDIuMjguNTcyIDEuOTMgMS45MyAwIDAgMCAuOTk2LS4xNy42NC42NCAwIDAgMCAuMjI5LS41M3EwLS4zMzgtLjQyLS41N2EzLjYgMy42IDAgMCAwLTEuMDU1LS40MDMgOC43IDguNyAwIDAgMS0yLjczOS0xLjIwNiAzLjIgMy4yIDAgMCAxLTEuMDUxLTEuMjQ4IDQuMiA0LjIgMCAwIDEtLjQyMi0xLjkyNnEwLTMuODk2IDMuNDg0LTQuNTUyeiIvPjwvc3ZnPg=='

/**
 * Policies whose assets are ADA Handles, beyond the one {@link ADA_HANDLE_POLICY} records.
 *
 * ⚠️ **Every entry needs evidence, not a resemblance.** Putting this mark on a policy that is not
 * ADA Handle's would be a false trust signal, so an id goes in here only once its assets have been
 * checked. The check is cheap and decisive: an ADA Handle carries a CIP-68 datum with
 * `handle_type` (plus `svg_version`, `agreed_terms`, `pz_enabled`, `rarity`), and nothing else does.
 *
 *     curl -s $KOIOS/asset_info -d '{"_asset_list":[["<policy>","<assetNameHex>"]]}' | grep handle_type
 *
 * ⚠️ **Do NOT read `handle_type` at runtime to decide this.** A datum is minter-controlled, so any
 * NFT could claim it and take the brand. The unforgeable fact is the policy id — it is a script hash
 * — which is why this is an allowlist and the datum is only how the list is researched.
 *
 * Known incomplete: ADA Handle publishes no policy list we could find (their docs host does not
 * resolve, and the one testnet id in circulation, `8d18d786…`, holds no assets on preprod or
 * preview). These two are what this wallet has actually seen.
 */
const EXTRA_HANDLE_POLICIES: readonly string[] = [
  // Verified 2026-08-28 on preview: `$livedemi5ycx0` carries `handle_type = handle`.
  '6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e',
]

/** Every policy whose tokens get {@link ADA_HANDLE_ICON}, across networks. */
const HANDLE_POLICIES: ReadonlySet<string> = new Set(
  [...Object.values(ADA_HANDLE_POLICY), ...EXTRA_HANDLE_POLICIES].flatMap((policy) =>
    policy === null ? [] : [policy.toLowerCase()],
  ),
)

/**
 * A shipped icon for this asset, or `null` to fall through to the CDN path.
 *
 * ⚠️ Matches on the policy id **whatever network is selected**. The same minting script is deployed
 * on more than one network, so the id is identical there — and `ADA_HANDLE_POLICY` records `null` for
 * the testnets, which is about *handle resolution* being mainnet-only, not about whether the tokens
 * exist. A wallet holding handles on preview should still see them as handles.
 */
export const knownTokenIconUri = (assetId: string): string | null => {
  // `policy.name`; ADA is `''`/`'.'`, whose empty policy matches nothing.
  const policy = assetId.split('.')[0]
  if (policy === undefined || policy.length === 0) return null
  return HANDLE_POLICIES.has(policy.toLowerCase()) ? ADA_HANDLE_ICON : null
}

/**
 * The placeholder for an NFT nothing else will illustrate.
 *
 * ⚠️ **Shipped so a list never asks the network for one.** The icon chain ends at cexplorer, which
 * "returns an image (real or a generic placeholder) for almost everything" — so an NFT row spent two
 * CDN requests to arrive at somebody else's placeholder. An NFT's real artwork is its CIP-25/CIP-68
 * `image`, usually IPFS, and `assetMediaUrl` deliberately resolves that on **detail surfaces only**:
 * a list would fire one gateway request per row, for full-size art, to fill a 36pt circle.
 *
 * One asset for both themes rather than a light/dark pair: a mid-grey outline reads on the dark row
 * and on white alike (checked by rendering against both). Square, so `contentFit: cover` cannot crop
 * it — see ADA_HANDLE_ICON above for what that costs when it is not.
 */
const NFT_PLACEHOLDER_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDI0IDI0Ij48cmVjdCB3aWR0aD0iMTUiIGhlaWdodD0iMTMiIHg9IjQuNSIgeT0iNS41IiBzdHJva2U9IiM4YjhiYTciIHN0cm9rZS13aWR0aD0iMS42IiByeD0iMi41Ii8+PGNpcmNsZSBjeD0iOS4yNSIgY3k9IjEwIiByPSIxLjUiIGZpbGw9IiM4YjhiYTciLz48cGF0aCBzdHJva2U9IiM4YjhiYTciIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLXdpZHRoPSIxLjYiIGQ9Im01IDE2LjIgMy45LTMuNmExLjQgMS40IDAgMCAxIDEuOSAwbDIuNyAyLjUgMS43LTEuNWExLjQgMS40IDAgMCAxIDEuOSAwbDEuOSAyLjMiLz48L3N2Zz4='

/** The shipped NFT placeholder. Callers use it when they already know the asset is an NFT. */
export const nftPlaceholderIconUri = (): string => NFT_PLACEHOLDER_ICON

/**
 * The placeholder for a fungible token with no icon.
 *
 * The same glyph as the NFT mark in a circle rather than a rounded rectangle — the shape is what
 * says which kind of asset it is, so the two read as one family at a glance. It replaces the
 * initials that used to stand here: three letters of a ticker are noise in a long list, and several
 * tokens collapse to the same three.
 */
const FT_PLACEHOLDER_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgZmlsbD0ibm9uZSIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3LjciIHN0cm9rZT0iIzhiOGJhNyIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48Y2lyY2xlIGN4PSI5LjkiIGN5PSIxMC4xIiByPSIxLjI1IiBmaWxsPSIjOGI4YmE3Ii8+PHBhdGggc3Ryb2tlPSIjOGI4YmE3IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIHN0cm9rZS13aWR0aD0iMS42IiBkPSJNNi4xNSAxNC43NSA4LjcgMTIuNGExLjI1IDEuMjUgMCAwIDEgMS43IDBsMS45NSAxLjggMS4xNS0xLjA1YTEuMjUgMS4yNSAwIDAgMSAxLjcgMGwyLjEgMS45NSIvPjwvc3ZnPg=='

/** The shipped placeholder for a fungible token whose icon nothing serves. */
export const ftPlaceholderIconUri = (): string => FT_PLACEHOLDER_ICON
