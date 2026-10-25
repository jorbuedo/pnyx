const path = require('node:path')
const {getSentryExpoConfig} = require('@sentry/react-native/metro')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '..')
const packagesRoot = path.resolve(monorepoRoot, 'packages')

// The evolution-sdk working tree is a git submodule under vendor/, not a sibling checkout, so every
// reference to it is guarded: a clone without it bundles exactly as before.
const forkPackagesRoot = path.resolve(monorepoRoot, 'vendor', 'evolution-sdk', 'packages')
const evolutionRoot = path.resolve(forkPackagesRoot, 'evolution')
const hasEvolution = require('node:fs').existsSync(evolutionRoot)
// The lifted packages the app consumes, each added as the step that migrates onto it lands. A
// package absent from this list is not resolvable from the app at all, however green its harness is.
const liftedForkPackages = [
  'review',
  'backup-keys',
  'cip30',
  'hardware-cardano',
  'plan',
  'canonical',
  'cip113',
  'cip139',
  'cips',
  'dijkstra',
]

const config = getSentryExpoConfig(projectRoot)

// Add 'browser' to condition names so packages like axios resolve browser builds
// instead of Node.js builds (which require 'url', 'http', 'https')
config.resolver.conditionNames = [...(config.resolver.conditionNames || ['import', 'require']), 'browser']

// Add 'md' to asset extensions for loading markdown files (legal texts).
// 'wasm' is served as an asset for the web Midnight ledger bootstrap
// (src/platform/midnight-ledger.web.ts fetches + instantiates it at runtime).
config.resolver.assetExts = [...config.resolver.assetExts, 'md', 'wasm']

// Watch monorepo packages for changes
config.watchFolders = hasEvolution
  ? [monorepoRoot, evolutionRoot, ...liftedForkPackages.map((name) => path.join(forkPackagesRoot, name))]
  : [monorepoRoot]

// Resolve node_modules from both app and monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// Packages that need to be deduplicated
const deduplicatedPackages = [
  'react',
  'react-dom',
  'react-native',
  'react-native-safe-area-context',
  'react-native-unistyles',
  'react-native-nitro-modules',
]

// Force single versions of React and Unistyles packages to avoid duplication
// Check app's node_modules first, then fall back to monorepo root (bun hoisting varies)
const fs = require('node:fs')

config.resolver.extraNodeModules = {}
for (const pkg of deduplicatedPackages) {
  const appPath = path.resolve(projectRoot, 'node_modules', pkg)
  const rootPath = path.resolve(monorepoRoot, 'node_modules', pkg)
  config.resolver.extraNodeModules[pkg] = fs.existsSync(appPath) ? appPath : rootPath
}

// Block duplicate copies - only block locations we're NOT using.
// The resolveRequest overrides (below) handle `require('react-native')` etc., but
// they do NOT catch internal relative requires within a wrong copy. If any file from
// a duplicate .bun copy enters the bundle, its `require('../Renderer/shims/ReactFabric')`
// resolves within the same duplicate tree. blockList is the safety net that prevents
// Metro from including ANY file from the wrong copy, regardless of resolution path.
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const blockPatterns = []
for (const pkg of deduplicatedPackages) {
  const appPath = path.resolve(projectRoot, 'node_modules', pkg)
  const pkgInApp = fs.existsSync(appPath)
  if (pkgInApp) {
    // Block from monorepo root's direct node_modules
    blockPatterns.push(new RegExp(`${escapeRegExp(monorepoRoot)}/node_modules/${escapeRegExp(pkg)}/.*`))
    // Block duplicate copies inside bun's .bun cache. Bun creates multiple
    // virtual copies of packages with peer dependencies (different content hashes).
    // Only the copy the app symlinks to should be loaded; block all others.
    const realAppPkgPath = fs.realpathSync(appPath)
    const bunCacheDir = path.resolve(monorepoRoot, 'node_modules', '.bun')
    if (fs.existsSync(bunCacheDir)) {
      // Block the .bun hoisted copy (.bun/node_modules/<pkg>) if it differs from the app's
      const bunHoisted = path.join(bunCacheDir, 'node_modules', pkg)
      if (fs.existsSync(bunHoisted) && fs.realpathSync(bunHoisted) !== realAppPkgPath) {
        blockPatterns.push(new RegExp(`${escapeRegExp(fs.realpathSync(bunHoisted))}/.*`))
      }
      // Block any .bun/<pkg>@<version>+<hash>/node_modules/<pkg> that isn't the app's copy
      // Bun replaces '/' with '+' in directory names for scoped packages
      // e.g. @scope/pkg-name → @scope+pkg-name@6.36.0+hash
      const bunDirPrefix = pkg.replace('/', '+')
      for (const entry of fs.readdirSync(bunCacheDir)) {
        if (!entry.startsWith(`${bunDirPrefix}@`)) continue
        const candidate = path.join(bunCacheDir, entry, 'node_modules', pkg)
        if (fs.existsSync(candidate) && fs.realpathSync(candidate) !== realAppPkgPath) {
          blockPatterns.push(new RegExp(`${escapeRegExp(candidate)}/.*`))
        }
      }
    }
  }
  // Always block from packages/**/node_modules (nested deps)
  blockPatterns.push(new RegExp(`${escapeRegExp(packagesRoot)}/.*/node_modules/${escapeRegExp(pkg)}/.*`))
}
// Build outputs inside the watched monorepo. Cargo constantly creates and deletes temp files
// under `rust/target/` (9+ GB of them), and when one vanishes mid-crawl Metro's file map throws
// ENOENT and takes the whole dev server down — observed 2026-08-02 while rebuilding the native
// library alongside a running web target. None of this is ever imported, so excluding it also
// spares the crawl.
blockPatterns.push(
  new RegExp(`${escapeRegExp(packagesRoot)}/[^/]+/rust/target/.*`),
  new RegExp(`${escapeRegExp(monorepoRoot)}/(?:[^/]+/)*android/(?:build|\\.gradle|\\.cxx)/.*`),
  new RegExp(`${escapeRegExp(monorepoRoot)}/(?:[^/]+/)*ios/Pods/.*`),
)

config.resolver.blockList = blockPatterns

// Map workspace package names to their source directories for HMR
const workspacePackages = {
  '@pnyx/blockstore-native': path.join(packagesRoot, 'blockstore-native'),
  '@pnyx/contract-client': path.join(packagesRoot, 'contract-client'),
  '@pnyx/cardano-core': path.join(packagesRoot, 'cardano-core'),
  '@pnyx/crypto': path.join(packagesRoot, 'crypto'),
  '@pnyx/config': path.join(packagesRoot, 'config'),
  '@pnyx/identicon': path.join(packagesRoot, 'identicon'),
  '@pnyx/links': path.join(packagesRoot, 'links'),
  '@pnyx/logger': path.join(packagesRoot, 'logger'),
  '@pnyx/midnight-native': path.join(packagesRoot, 'midnight-native'),
  '@pnyx/migrations': path.join(packagesRoot, 'migrations'),
  '@pnyx/passkey-native': path.join(packagesRoot, 'passkey-native'),
  '@pnyx/signer': path.join(packagesRoot, 'signer'),
  '@pnyx/storage': path.join(packagesRoot, 'storage'),
  '@pnyx/store': path.join(packagesRoot, 'store'),
  '@pnyx/ur': path.join(packagesRoot, 'ur'),
  '@pnyx/wallet': path.join(packagesRoot, 'wallet'),
}

if (hasEvolution) {
  workspacePackages['@evolution-sdk/evolution'] = path.join(evolutionRoot, 'src')
  for (const name of liftedForkPackages) {
    workspacePackages[`@evolution-sdk/${name}`] = path.join(forkPackagesRoot, name, 'src')
  }
}

// Try to resolve a file with multiple extensions, respecting platform-specific files
const tryResolveFile = (basePath, platform) => {
  const fs = require('node:fs')
  // Platform-specific extensions should be tried first on React Native
  const isNative = platform === 'android' || platform === 'ios'
  const extensions = isNative
    ? ['.native.tsx', '.native.ts', '.tsx', '.ts', '.native.js', '.native.jsx', '.js', '.jsx']
    : ['.tsx', '.ts', '.js', '.jsx']
  // Try with extensions
  for (const ext of extensions) {
    if (fs.existsSync(basePath + ext)) return basePath + ext
  }
  // Try as directory with index
  for (const ext of extensions) {
    const indexPath = path.join(basePath, `index${ext}`)
    if (fs.existsSync(indexPath)) return indexPath
  }
  return null
}

// Check if a path is inside any workspace package
const getWorkspaceRoot = (filePath) => {
  for (const [, pkgPath] of Object.entries(workspacePackages)) {
    if (filePath.startsWith(pkgPath)) {
      return pkgPath
    }
  }
  return null
}

// Custom resolver to redirect workspace packages to source files
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // On native platforms, resolve `crypto` to react-native-quick-crypto for full
  // Web Crypto API support (crypto.subtle.digest etc.).
  // On web, crypto-browserify is used via extraNodeModules (browser has native crypto.subtle).
  if (moduleName === 'crypto' && (platform === 'ios' || platform === 'android')) {
    return context.resolveRequest(context, 'react-native-quick-crypto', platform)
  }

  // Shim Node.js modules that don't exist in React Native or browsers.
  // `ws` is a Node.js WebSocket library some transitive deps still import;
  // both React Native and browsers have a native WebSocket global.
  if (moduleName === 'ws') {
    return {
      filePath: path.join(projectRoot, 'src', 'platform', 'ws-shim.js'),
      type: 'sourceFile',
    }
  }

  // -------------------------------------------------------------------------
  // Chrome Web Store MV3 "Remote Hosted Code" compliance — stub Sentry's
  // `lazyLoadIntegration` helper.
  //
  // The problem:
  //   `@sentry/browser`'s file at
  //     node_modules/@sentry/browser/build/npm/esm/{prod,dev}/utils/lazyLoadIntegration.js
  //   contains two things the CWS MV3 review process rejects as Remote
  //   Hosted Code (RHC):
  //     1. The string literal `'https://browser.sentry-cdn.com'`.
  //     2. The classic remote-script-injection pattern:
  //        `const s = document.createElement('script'); s.src = url; parent.appendChild(s)`.
  //   Together these let Sentry pull integration bundles (Replay, Feedback,
  //   etc.) from its CDN into the extension's own origin at runtime — which
  //   CWS forbids for MV3 items, regardless of whether we actually call it.
  //
  // Why we can't just stop importing it:
  //   - `@sentry/browser/.../index.js` does `export { lazyLoadIntegration } from './utils/lazyLoadIntegration.js'`.
  //   - `@sentry/react/.../index.js` does `export * from '@sentry/browser'`.
  //   - We import `@sentry/react` (web/extension) and `@sentry/react-native`
  //     (native, which also transitively pulls `@sentry/browser`).
  //   So the file is statically reachable through the module graph no matter
  //   which Sentry surface we touch. parcel + terser (used by ctrl-extension,
  //   the CWS-accepted reference) tree-shakes it away because nothing calls
  //   it; Metro's bundler does NOT, so the literal + injection pattern stay
  //   in the popup UI bundle and CWS rejects the submission.
  //
  // What this resolver does:
  //   When any file inside `node_modules/@sentry/browser/` asks for
  //   `./utils/lazyLoadIntegration` (with or without `.js`), redirect Metro
  //   to `app/src/platform/sentry-lazy-load-stub.js`. The stub
  //   exposes a single named export `lazyLoadIntegration` that throws if
  //   anything ever calls it — fail-fast guard, never invoked in practice
  //   because we don't ship Replay, Feedback, or any other lazy-loaded
  //   integration (see `app/src/logger/index.ts` web init).
  //
  // Why this is safe:
  //   - The named-export shape is preserved, so `export { lazyLoadIntegration }`
  //     from `@sentry/browser`'s index still resolves and the rest of the
  //     SDK doesn't crash at module-eval time.
  //   - Nothing in our code path calls `lazyLoadIntegration`. The only
  //     consumer in the bundle is `feedbackAsyncIntegration`'s factory,
  //     which captures the stub but is also never invoked.
  //   - If a future Sentry version makes any new helper reach this file,
  //     the throw surfaces it loudly in dev rather than silently regressing
  //     to a CWS-blocking literal.
  //
  // See `_context.md` → "Sentry SDK swap alone was insufficient — Metro
  // alias needed" for the full investigation trail.
  // -------------------------------------------------------------------------
  if (
    (moduleName === './utils/lazyLoadIntegration' || moduleName === './utils/lazyLoadIntegration.js') &&
    context.originModulePath &&
    context.originModulePath.includes(`${path.sep}@sentry${path.sep}browser${path.sep}`)
  ) {
    return {
      filePath: path.join(projectRoot, 'src', 'platform', 'sentry-lazy-load-stub.js'),
      type: 'sourceFile',
    }
  }

  // -------------------------------------------------------------------------
  // The compactc-generated contract drivers (`contract/managed/*/contract/index.js`) are plain JS
  // that Hermes runs today. Their runtime is not: `@midnight-ntwrk/compact-runtime` depends on
  // `@midnight-ntwrk/onchain-runtime-v3`, a wasm-bindgen package, and this app is on legacy
  // Hermes V0 where `typeof WebAssembly === 'undefined'`. `@pnyx/compact-hermes` serves those
  // leaves from the same Rust crates the proving rail already links.
  //
  // ⚠️ **Scoped to requests from compact-runtime, deliberately.** `@midnight-ntwrk/midnight-js-protocol`
  // depends on the same package, and swapping it there would hand a server-side ledger path a shim
  // that refuses the zswap surface by design. Narrow alias, one consumer.
  //
  // This is item 32's "replace only the WASM runtime": compact-runtime's own 27 pure-JS symbols
  // stay upstream and unmodified — nothing here is patched or vendored.
  // -------------------------------------------------------------------------
  if (
    moduleName === '@midnight-ntwrk/onchain-runtime-v3' &&
    context.originModulePath &&
    context.originModulePath.includes(`${path.sep}@midnight-ntwrk${path.sep}compact-runtime${path.sep}`)
  ) {
    return context.resolveRequest(context, '@pnyx/compact-hermes', platform)
  }

  // -------------------------------------------------------------------------
  // @pnyx/hardware dynamically imports its Trezor USB / native / Web-BLE-bridge
  // transports on extension/web connect branches (`./index.js/trezor-native…`,
  // `…/trezor-web-ble`, `…/trezor-native/usb/usb-device-api`). Those transports
  // never run on mobile (the device connects over BLE), but Metro tries to
  // resolve each dynamic-import literal at bundle time and the built specifiers
  // are malformed. Redirect them all to a fail-fast stub so the native bundle
  // resolves; the stub throws only if one is ever invoked (it isn't on mobile).
  // -------------------------------------------------------------------------
  if (moduleName.includes('index.js/trezor')) {
    return {
      filePath: path.join(projectRoot, 'src', 'platform', 'trezor-native-adapter-stub.js'),
      type: 'sourceFile',
    }
  }

  // -------------------------------------------------------------------------
  // Chrome Web Store MV3 "Remote Hosted Code" compliance — stub Sentry's
  // `showReportDialog` helper.
  //
  // The original `@sentry/browser/.../report-dialog.js` builds a `<script>`
  // element, sets `script.src = getReportDialogEndpoint(dsn, options)` (a
  // remote URL derived from the configured DSN), and appends it to the
  // extension document. Textbook MV3 RHC pattern.
  //
  // The URL is dynamic (no static CDN literal in the bundle), so the CWS
  // scanner does not flag this today — other published extensions ship the
  // same pattern and pass review. This stub is defense-in-depth: if CWS bots
  // tighten or `@sentry/react` ever changes how the URL is built, the
  // injection site is already gone from the bundle.
  //
  // We don't surface `Sentry.showReportDialog` anywhere in the app, so the
  // throwing stub is safe.
  //
  // `getReportDialogEndpoint` lives upstream in `@sentry/core` and is just a
  // URL builder (returns a string, no DOM mutation). No separate alias
  // needed — after this stub kicks in, the builder is unreachable.
  //
  // Scoped to web/extension builds: `@sentry/browser` is transitively pulled
  // by `@sentry/react-native` on iOS/Android too, but only the popup chunk
  // ships to CWS. Keeping native on the upstream file avoids divergence in
  // bundles that aren't subject to RHC review.
  //
  // Asymmetry vs the `lazyLoadIntegration` stub above: that one runs on all
  // platforms because the upstream file contains a STATIC CDN literal
  // (`'https://browser.sentry-cdn.com'`) — removing it everywhere keeps
  // native sourcemaps / crash dumps free of the string too, defense-in-depth.
  // `report-dialog.js` has no static literal (the URL is built at runtime
  // from the DSN), so the only RHC concern is the DOM injection itself,
  // which can't fire on React Native (no `document`). Hence: native runs
  // upstream unchanged, web gets the stub.
  // -------------------------------------------------------------------------
  if (
    platform === 'web' &&
    (moduleName === './report-dialog' || moduleName === './report-dialog.js') &&
    context.originModulePath &&
    context.originModulePath.includes(`${path.sep}@sentry${path.sep}browser${path.sep}`)
  ) {
    return {
      filePath: path.join(projectRoot, 'src', 'platform', 'sentry-show-report-dialog-stub.js'),
      type: 'sourceFile',
    }
  }

  // Handle react-native-unistyles/components/native/* imports for WEB ONLY.
  // Metro doesn't fully support package.json exports subpath patterns on web.
  // Native platforms (iOS/Android) resolve these through the native Nitro binding
  // without needing this shim — applying it on native breaks flex layout because
  // the JS shim wraps RN components in Unistyles-aware versions with different defaults.
  if (platform === 'web' && moduleName.startsWith('react-native-unistyles/components/native/')) {
    const component = moduleName.replace('react-native-unistyles/components/native/', '')
    // Use the deduplicated path from extraNodeModules instead of hardcoding projectRoot
    const unistylesBase = config.resolver.extraNodeModules['react-native-unistyles']
    const filePath = path.join(unistylesBase, 'lib/module/components/native', `${component}.js`)
    return {filePath, type: 'sourceFile'}
  }

  // Force React to resolve from the app's node_modules. Metro can otherwise
  // pick a second workspace copy for JSX runtime imports.
  if (moduleName === 'react' || moduleName === 'react/jsx-runtime' || moduleName === 'react/jsx-dev-runtime') {
    return context.resolveRequest(
      {...context, originModulePath: path.join(projectRoot, 'app', '_layout.tsx')},
      moduleName,
      platform,
    )
  }

  // evolution-sdk carries its own pnpm tree, so a bare `effect` import from inside it resolves to
  // that copy instead of ours. Two Effect runtimes in one bundle do not share Context tags or
  // Layer memoization, so the services a layer provides are invisible to the fibers that need them.
  // Scoped to `effect` alone: @noble/@scure differ only by minor there, which costs bytes not bugs.
  if (hasEvolution && (moduleName === 'effect' || moduleName.startsWith('effect/'))) {
    // ⚠️ `forkPackagesRoot`, not `evolutionRoot`. The guard used to cover only
    // `packages/evolution`, so every LIFTED package (review, plan, cip113, …)
    // was left to node resolution — which walks up into the fork's own pnpm tree and finds a
    // different Effect. It happened to work only because a `bun install` from this repo had
    // symlinked each package's `effect` back here, and a plain `pnpm install` in the fork silently
    // undoes that for all of them at once.
    if (context.originModulePath?.startsWith(forkPackagesRoot)) {
      return context.resolveRequest(
        {...context, originModulePath: path.join(projectRoot, 'app', '_layout.tsx')},
        moduleName,
        platform,
      )
    }
  }

  // Force native runtime dependencies to resolve from the app's node_modules.
  // This prevents workspace packages from pulling their own Bun store instance
  // of React Native, which breaks RN globals.
  const forceFromAppPackages = ['react-native', 'react-native-nitro-modules']
  if (forceFromAppPackages.some((pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`))) {
    return context.resolveRequest(
      {...context, originModulePath: path.join(projectRoot, 'app', '_layout.tsx')},
      moduleName,
      platform,
    )
  }

  // @midnight-ntwrk/ledger-v8 on web: the package's browser entry loads its
  // WASM via a webpack-style static `import ... from './*.wasm'` that Metro
  // cannot bundle. Resolve the package — and the wasm-bindgen snippets'
  // `#self` self-reference — to the JS bindings module instead; the .wasm is
  // bundled as a Metro asset and instantiated at startup by
  // src/platform/midnight-ledger.web.ts. Native never imports this package
  // (curve backend resolves to @pnyx/midnight-native).
  if (platform === 'web') {
    const ledgerAppPath = path.join(projectRoot, 'node_modules', '@midnight-ntwrk', 'ledger-v8')
    const ledgerRoot = fs.existsSync(ledgerAppPath)
      ? ledgerAppPath
      : path.join(monorepoRoot, 'node_modules', '@midnight-ntwrk', 'ledger-v8')
    if (
      moduleName === '@midnight-ntwrk/ledger-v8' ||
      (moduleName === '#self' && context.originModulePath?.startsWith(ledgerRoot))
    ) {
      return {filePath: path.join(ledgerRoot, 'midnight_ledger_wasm_bg.js'), type: 'sourceFile'}
    }
    // Subpath imports (bindings, snippets, the .wasm asset) aren't listed in
    // the package's `exports` map — resolve them as plain files.
    if (moduleName.startsWith('@midnight-ntwrk/ledger-v8/')) {
      const target = path.join(ledgerRoot, moduleName.slice('@midnight-ntwrk/ledger-v8/'.length))
      return context.resolveRequest(context, target, platform)
    }
  }

  // Force @sinclair/typebox to use CJS build instead of ESM
  // The ESM build exports `var Object = _Object` and `var Promise = ...` which shadow
  // globals when Metro transforms ESM→CJS, breaking Object.defineProperty calls
  if (moduleName === '@sinclair/typebox' || moduleName.startsWith('@sinclair/typebox/')) {
    return context.resolveRequest({...context, unstable_conditionNames: ['require']}, moduleName, platform)
  }

  // Check if this is a workspace package import
  for (const [pkgName, pkgPath] of Object.entries(workspacePackages)) {
    if (moduleName === pkgName) {
      // Redirect to source index
      const resolved = tryResolveFile(path.join(pkgPath, 'index'), platform)
      if (resolved) {
        return {filePath: resolved, type: 'sourceFile'}
      }
    }
    // Handle subpath imports like @pnyx/wallet/types
    if (moduleName.startsWith(`${pkgName}/`)) {
      const subpath = moduleName.slice(pkgName.length + 1)
      const resolved = tryResolveFile(path.join(pkgPath, subpath), platform)
      if (resolved) {
        return {filePath: resolved, type: 'sourceFile'}
      }
    }
  }

  // Handle relative .js imports within workspace packages (NodeNext resolution)
  // When importing './foo.js' in a workspace package, resolve to './foo.ts' or './foo.tsx'
  if (moduleName.endsWith('.js') && context.originModulePath) {
    const workspaceRoot = getWorkspaceRoot(context.originModulePath)
    if (workspaceRoot) {
      const dir = path.dirname(context.originModulePath)
      const baseModuleName = moduleName.slice(0, -3) // Remove .js
      const fullPath = path.resolve(dir, baseModuleName)
      const resolved = tryResolveFile(fullPath, platform)
      if (resolved) {
        return {filePath: resolved, type: 'sourceFile'}
      }
    }
  }

  // Fall back to default resolution
  return context.resolveRequest(context, moduleName, platform)
}

// Polyfill Node.js standard library modules for React Native
// Many npm packages (axios, micro-ftch, readable-stream, cipher-base) use Node.js APIs
// Resolve from app's node_modules first, then monorepo root (bun hoists most packages)
const emptyModule = path.resolve(projectRoot, 'src/platform/empty-module.js')
const resolvePolyfill = (pkg) => {
  const appPath = path.resolve(projectRoot, 'node_modules', pkg)
  return fs.existsSync(appPath) ? appPath : path.resolve(monorepoRoot, 'node_modules', pkg)
}
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  // Real polyfills
  process: resolvePolyfill('process'),
  stream: resolvePolyfill('stream-browserify'),
  buffer: resolvePolyfill('buffer'),
  crypto: resolvePolyfill('crypto-browserify'),
  url: resolvePolyfill('url'),
  http: resolvePolyfill('stream-http'),
  https: resolvePolyfill('https-browserify'),
  os: resolvePolyfill('os-browserify'),
  zlib: path.resolve(projectRoot, 'src/platform/zlib-shim.js'),
  path: resolvePolyfill('path-browserify'),
  events: resolvePolyfill('events'),
  assert: resolvePolyfill('assert'),
  string_decoder: resolvePolyfill('string_decoder'),
  // Empty shims for modules that can't be polyfilled but are parsed
  net: emptyModule,
  tls: emptyModule,
  fs: emptyModule,
  dns: emptyModule,
  child_process: emptyModule,
  dgram: emptyModule,
}

// Configure transformer to handle workspace packages properly
config.transformer = {
  ...config.transformer,
  minifierConfig: {
    // Ensure minifier supports modern syntax
    ecma: 2020,
    module: true,
    mangle: {
      toplevel: false,
    },
    compress: {
      // Disable problematic optimizations
      reduce_funcs: false,
    },
    output: {
      // Keep it readable for debugging
      comments: false,
    },
  },
}

// API proxy moved to standalone server (scripts/dev-proxy.ts) to avoid
// Metro event loop starvation. Run via `bun scripts/run.ts web`.

// Disable source maps — Metro's //# sourceMappingURL comment causes Chrome
// DevTools to fetch and parse a massive source map, progressively freezing
// the inspector when used in extension pages.
config.serializer = {
  ...config.serializer,
  sourceMapUrl: null,
  symbolicate: false,
}

// Strip //# sourceMappingURL from bundle responses. The serializer config
// above handles the initial bundle, but HMR updates (hmrJSBundle.js) inject
// their own sourceMappingURL unconditionally — only middleware can catch those.
// enhanceMiddleware is deprecated but has no replacement for response
// interception; Expo itself still uses it internally.
const originalMiddleware = config.server.enhanceMiddleware
config.server.enhanceMiddleware = (middleware, server) => {
  const base = originalMiddleware ? originalMiddleware(middleware, server) : middleware
  return (req, res, next) => {
    if (req.url?.includes('.bundle')) {
      const originalEnd = res.end.bind(res)
      const chunks = []

      res.write = (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
      }
      res.end = (chunk, ...args) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        let body = Buffer.concat(chunks).toString('utf-8')
        body = body.replace(/\/\/# sourceMappingURL=[^\n]*/g, '')
        originalEnd(body, ...args)
      }
    }
    return base(req, res, next)
  }
}

/**
 * Make `EXPO_PUBLIC_*` values part of Metro's cache key.
 *
 * Expo's babel plugin inlines them at transform time, but Metro's cache key is derived from the
 * source graph and **not** from those values — so changing one and rebuilding silently reuses the
 * transform holding the *previous* value. It cost a wrong preview APK: the build was told to use the
 * preprod indexer, the log confirmed `.env.local` overriding `.env`, and the emitted bundle was
 * byte-identical to the run before it, still carrying the mainnet URL. With the wrong indexer the app
 * cannot read its own identity row and skips registration entirely, so the symptom appears three
 * layers from the cause.
 *
 * Fingerprinting them into `cacheVersion` namespaces the cache per configuration: switching envs
 * gets a clean cache, switching back reuses the earlier one, and nothing has to be wiped by hand.
 */
const publicEnv = Object.keys(process.env)
  .filter((key) => key.startsWith('EXPO_PUBLIC_'))
  .sort()
  .map((key) => `${key}=${process.env[key]}`)
  .join('\n')
config.cacheVersion = `${config.cacheVersion ?? 'pnyx'}-${require('node:crypto')
  .createHash('sha256')
  .update(publicEnv)
  .digest('hex')
  .slice(0, 16)}`

module.exports = config
