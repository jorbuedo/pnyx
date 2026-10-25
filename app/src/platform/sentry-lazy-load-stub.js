// Stub replacement for `@sentry/browser/.../utils/lazyLoadIntegration.js`.
//
// The original file (in `node_modules/@sentry/browser/build/npm/esm/{prod,dev}/utils/`)
// ships a static literal `'https://browser.sentry-cdn.com'` plus the textbook
// remote-script-injection pattern
//   `const s = document.createElement('script'); s.src = url; parent.appendChild(s)`
// to load Sentry integration bundles (Replay, Feedback, etc.) from its CDN at
// runtime. Chrome Web Store rejects MV3 extensions that contain that pattern
// under its "Remote Hosted Code" policy — regardless of whether anything in
// the extension actually calls it.
//
// `app/metro.config.js` redirects the import path
//   `./utils/lazyLoadIntegration` (resolved from inside @sentry/browser)
// to this file, so the CDN URL + DOM injection never enter the popup UI
// bundle that gets uploaded to CWS. See the long-form comment in
// `metro.config.js` for the full reasoning.
//
// Why a throwing stub (rather than a no-op): nothing in our code path invokes
// `lazyLoadIntegration` — we ship no Replay, no Feedback, no async
// integrations on the web/extension target (see `app/src/logger/index.ts`).
// If a future Sentry version wires up a new lazy-loaded helper that does
// reach this stub, the throw surfaces it loudly in dev so we notice and add
// a proper handler, rather than silently regressing to a CWS-blocking
// literal.
export function lazyLoadIntegration() {
  throw new Error('lazyLoadIntegration is disabled in this build (Chrome Web Store MV3 compliance).')
}
