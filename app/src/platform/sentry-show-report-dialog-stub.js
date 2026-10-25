// Stub replacement for `@sentry/browser/.../report-dialog.js`.
//
// The original file (in `node_modules/@sentry/browser/build/npm/esm/{prod,dev}/`)
// builds a `<script>` element, assigns `script.src = getReportDialogEndpoint(...)`
// (a remote URL derived from the configured DSN), and appends it to the
// extension's document. That is the textbook MV3 "Remote Hosted Code"
// pattern — `<script src=external>` injection into the extension's own origin.
//
// `app/metro.config.js` redirects the import path
//   `./report-dialog` (resolved from inside @sentry/browser)
// to this file, so the createElement('script') + DOM appendChild graph never
// enters the popup UI bundle that gets uploaded to CWS.
//
// Dev/preview throws; prod is a silent no-op. Nothing in our code path invokes
// `Sentry.showReportDialog` — we don't surface the Sentry feedback dialog UI
// anywhere. If a future Sentry version wires a new call site that reaches this
// stub, the dev throw surfaces it loudly so we add a proper handler before the
// next bundle ships. In prod we swallow it: an unexpected throw here would
// otherwise reach the user (and Sentry breadcrumbs) for what is, by design,
// a disabled feature. The RHC sweep run by `bun run mozilla-linter` still
// catches the URL-injection literal in any bundle that regresses, so the
// prod silence is bounded by CI, not invisible.
//
// `getReportDialogEndpoint` lives upstream in `@sentry/core` and is an inert
// URL builder (returns a string, no DOM mutation). It is not re-exported here
// and does not need a separate stub.
export function showReportDialog() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('showReportDialog is disabled in this build (Chrome Web Store MV3 compliance).')
  }
}
