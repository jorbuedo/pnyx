#!/usr/bin/env bun
/**
 * Chrome extension build.
 *
 * Packages the Expo web export as an MV3 browser extension: the app shell runs
 * in the side panel / a fullscreen tab, with a background service worker for
 * the display-surface handlers (and, as they land, hardware-wallet BLE routing
 * and the dApp CIP-30 flow). See `docs/EXTENSION.md`.
 *
 * Usage:
 *   bun extension/scripts/build.ts                    (dev: unminified, inline sourcemaps)
 *   bun extension/scripts/build.ts --env=prod         (minified)
 *   bun extension/scripts/build.ts --skip-packages    (skip the monorepo package build)
 *   bun extension/scripts/build.ts --zip              (also produce a zip)
 *
 * @module
 */

import {execSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {
  generateInjectionScript,
  MIDNIGHT_API_VERSION,
  MIDNIGHT_WALLET_RDNS,
  MIDNIGHT_WALLET_UUID,
} from '@pnyx/dapp-connector'
import * as esbuild from 'esbuild'
import {PNYX_WALLET_ICON_DATA_URI} from '../../src/services/dapp/wallet-icon'
import {BACKGROUND_SHIM_KEYS, BRIDGE_SHIM_KEYS, browserShimsPlugin} from './browser-shims'
import {parseChromeVersion} from './chrome-version'
import {generateChromeManifest, hostPermissionsFromEnv} from './manifest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..') // app
const MONOREPO_ROOT = join(ROOT, '..')
const DIST = join(ROOT, 'dist')
const EXT_OUT = join(ROOT, 'extension-dist')
const EXT_SRC = join(ROOT, 'extension')

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {version: string}
const VERSION = parseChromeVersion(packageJson.version)

const FLUID_LAYOUT_STYLES = `
    <style id="extension-styles">
      html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; min-width: 100% !important; min-height: 100% !important; }
      #root { width: 100% !important; height: 100% !important; min-width: 100% !important; min-height: 100% !important; max-width: 1200px; margin: 0 auto !important; padding: 0 !important; display: flex !important; flex-direction: column !important; }
      #root > div, #root > div > div { flex: 1 !important; width: 100% !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; }
    </style>
    <script src="popup-detector.js"></script>
  `

/** Recursively rename `_`-prefixed entries (Chrome rejects them) and record the renames. */
function fixUnderscoreNames(dir: string, renames: Array<{from: string; to: string}>): void {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const fullPath = join(dir, entry.name)
    if (entry.name.startsWith('_')) {
      const newName = entry.name.replace(/^_/, 'x-')
      const newPath = join(dir, newName)
      renameSync(fullPath, newPath)
      renames.push({from: entry.name, to: newName})
      if (entry.isDirectory()) fixUnderscoreNames(newPath, renames)
    } else if (entry.isDirectory()) {
      fixUnderscoreNames(fullPath, renames)
    }
  }
}

/** Rewrite `/from` → `/to` path references inside every .html / .js file under `dir`. */
function updateReferences(dir: string, renames: ReadonlyArray<{from: string; to: string}>): void {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      updateReferences(fullPath, renames)
    } else if (entry.name.endsWith('.html') || entry.name.endsWith('.js')) {
      let content = readFileSync(fullPath, 'utf-8')
      let modified = false
      for (const {from, to} of renames) {
        const pattern = `/${from}`
        if (content.includes(pattern)) {
          content = content.split(pattern).join(`/${to}`)
          modified = true
        }
      }
      if (modified) writeFileSync(fullPath, content)
    }
  }
}

/** Copy the app icon to the three manifest icon sizes (Chrome scales as needed). */
function copyIcons(): void {
  const src = join(ROOT, 'assets', 'icon.png')
  if (!existsSync(src)) throw new Error(`App icon missing at ${src}`)
  const assetsOut = join(EXT_OUT, 'assets')
  mkdirSync(assetsOut, {recursive: true})
  for (const size of [16, 48, 128]) {
    cpSync(src, join(assetsOut, `icon-${size}.png`))
  }
}

async function build(env: 'dev' | 'prod', skipPackages: boolean, createZip: boolean): Promise<void> {
  const devMode = env === 'dev'
  const displayName = devMode ? 'Pnyx Dev' : 'Pnyx'
  console.log(`Building ${displayName} extension${devMode ? ' (dev)' : ''}...`)

  // 1. Clean output
  if (existsSync(EXT_OUT)) rmSync(EXT_OUT, {recursive: true})
  mkdirSync(EXT_OUT, {recursive: true})

  // 2. Build workspace packages (so @pnyx/* dist artifacts are current)
  if (!skipPackages) {
    console.log('Building workspace packages...')
    execSync('bun run build', {cwd: MONOREPO_ROOT, stdio: 'inherit'})
  }

  // 3. Export the Expo web app (single-file output → dist/)
  console.log('Exporting Expo web...')
  const exportEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: devMode ? 'development' : 'production',
    PNYX_BUILD_VARIANT: devMode ? 'dev' : 'prod',
    PNYX_APP_ENV: env,
    INLINE_RUNTIME_CHUNK: 'false',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' '),
  }
  execSync('bunx expo export --platform web', {cwd: ROOT, stdio: 'inherit', env: exportEnv})

  // 4. Copy the web build into the extension output
  console.log('Copying web build...')
  cpSync(DIST, EXT_OUT, {recursive: true})

  // 5. Hash-route rewriter (external script to comply with CSP)
  cpSync(join(EXT_SRC, 'popup-detector.js'), join(EXT_OUT, 'popup-detector.js'))

  // 6. Inject fluid layout + the rewriter into index.html
  console.log('Injecting extension layout...')
  const indexPath = join(EXT_OUT, 'index.html')
  const indexHtml = readFileSync(indexPath, 'utf-8').replace('</head>', `${FLUID_LAYOUT_STYLES}</head>`)
  writeFileSync(indexPath, indexHtml)

  // 7. Fix `_`-prefixed filenames (e.g. Expo's `_expo/`) and their references
  console.log('Fixing reserved filenames...')
  const renames: Array<{from: string; to: string}> = []
  fixUnderscoreNames(EXT_OUT, renames)
  if (renames.length > 0) updateReferences(EXT_OUT, renames)

  // 8. Bundle the background service worker
  console.log('Building background service worker...')
  await esbuild.build({
    entryPoints: [join(EXT_SRC, 'background.ts')],
    bundle: true,
    outfile: join(EXT_OUT, 'background.js'),
    format: 'esm',
    target: 'chrome100',
    minify: !devMode,
    sourcemap: devMode ? 'inline' : false,
    inject: [join(EXT_SRC, 'process-shim.js')],
    define: {__DEV__: String(devMode)},
    plugins: [browserShimsPlugin(BACKGROUND_SHIM_KEYS)],
  })

  // 8b. BLE bridge tab scripts (run navigator.bluetooth in a regular tab) + host page
  console.log('Building BLE bridge scripts...')
  const bridgeTabBuild = (entry: string, outfile: string) =>
    esbuild.build({
      entryPoints: [join(EXT_SRC, entry)],
      bundle: true,
      outfile: join(EXT_OUT, outfile),
      format: 'esm',
      target: 'chrome100',
      minify: !devMode,
      sourcemap: devMode ? 'inline' : false,
      inject: [join(EXT_SRC, 'process-shim.js')],
      plugins: [browserShimsPlugin(BRIDGE_SHIM_KEYS)],
    })
  await Promise.all([
    bridgeTabBuild('ledger-ble-bridge/bridge-tab.ts', 'ledger-ble-bridge.js'),
    bridgeTabBuild('trezor-ble-bridge/bridge-tab.ts', 'trezor-ble-bridge.js'),
  ])
  cpSync(join(EXT_SRC, 'ble-bridge.html'), join(EXT_OUT, 'ble-bridge.html'))
  cpSync(join(EXT_SRC, 'ble-bridge-loader.js'), join(EXT_OUT, 'ble-bridge-loader.js'))

  // 8c. dApp CIP-30 provider (main world) + content-script relay (isolated world)
  console.log('Building dApp connector scripts...')
  const contentDir = join(EXT_OUT, 'content')
  mkdirSync(contentDir, {recursive: true})
  // The provider reuses the canonical CIP-30 generator with the extension transport.
  const providerSource = generateInjectionScript({
    midnightApiVersion: MIDNIGHT_API_VERSION,
    midnightRdns: MIDNIGHT_WALLET_RDNS,
    midnightUuid: MIDNIGHT_WALLET_UUID,
    walletName: 'Pnyx',
    walletIcon: PNYX_WALLET_ICON_DATA_URI,
    apiVersion: '1',
    sessionId: 'extension',
    providerNames: ['pnyx'],
    transport: 'extension',
  })
  writeFileSync(join(contentDir, 'cardano-provider.js'), providerSource)
  await esbuild.build({
    entryPoints: [join(EXT_SRC, 'content/content-script.ts')],
    bundle: true,
    outfile: join(contentDir, 'content-script.js'),
    format: 'iife',
    target: 'chrome100',
    minify: !devMode,
    sourcemap: devMode ? 'inline' : false,
  })

  // 9. Manifest + icons
  console.log('Generating manifest...')
  const manifest = generateChromeManifest({
    displayName,
    version: VERSION,
    hostPermissions: hostPermissionsFromEnv(exportEnv),
  })
  writeFileSync(join(EXT_OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  copyIcons()

  console.log(`\n${displayName} extension built at ${EXT_OUT}`)

  if (createZip) {
    const zipPath = join(ROOT, `extension-${env}.zip`)
    if (existsSync(zipPath)) rmSync(zipPath)
    execSync(`zip -r "${zipPath}" .`, {cwd: EXT_OUT, stdio: 'inherit'})
    console.log(`Zip: ${zipPath}`)
  } else {
    console.log('\nLoad it: chrome://extensions → Developer mode → Load unpacked →', EXT_OUT)
  }
}

const args = process.argv.slice(2)
const envArg = args.find((a) => a.startsWith('--env='))?.slice(6)
if (envArg !== undefined && envArg !== 'dev' && envArg !== 'prod') {
  console.error(`Invalid --env "${envArg}". Use dev or prod.`)
  process.exit(1)
}
// Default to dev — an unspecified build must never silently produce a prod artifact.
const env = (envArg as 'dev' | 'prod' | undefined) ?? 'dev'
build(env, args.includes('--skip-packages'), args.includes('--zip')).catch((err) => {
  console.error('Extension build failed:', err)
  process.exit(1)
})
