#!/usr/bin/env bun
/**
 * Run the wallet app in development mode.
 *
 * Clears metro cache, runs expo prebuild --clean, and launches
 * the app on the target platform.
 *
 * Usage:
 *   bun scripts/run.ts android           # Run on Android emulator
 *   bun scripts/run.ts android --device   # Run on connected Android device
 *   bun scripts/run.ts ios               # Run on iOS simulator
 *   bun scripts/run.ts ios --device       # Run on connected iOS device
 *   bun scripts/run.ts web               # Run in web browser
 *
 * Options:
 *   --device, -d   Target a connected physical device instead of emulator/simulator
 *
 * @module
 */

import {execSync, spawn} from 'node:child_process'
import {existsSync, rmSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {assertDevEnvComplete, disableSentryUploadUnlessConfigured, ensureEnv} from './ensure-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MONOREPO_ROOT = join(ROOT, '..')

type Platform = 'ios' | 'android' | 'web'
const VALID_PLATFORMS: Platform[] = ['ios', 'android', 'web']

function clearCache(): void {
  console.log('Clearing metro cache...')
  const metroCacheDirs = ['/tmp/metro-cache', '/tmp/haste-map-metro']
  for (const dir of metroCacheDirs) {
    if (existsSync(dir)) {
      rmSync(dir, {recursive: true, force: true})
    }
  }
}

function runAndroid(device: boolean): void {
  // PNYX_BUILD_VARIANT is intentionally not set here — app.config.js defaults
  // to 'dev' when it is absent, which is the correct variant for local development.
  const env = {...process.env}

  console.log('Running expo prebuild for Android...')
  execSync('npx expo prebuild --platform android --clean', {cwd: ROOT, stdio: 'inherit', env})

  const target = device ? ' (physical device)' : ' (emulator)'
  const deviceFlag = device ? ' --device' : ''
  console.log(`Launching app on Android${target}...`)
  execSync(`npx expo run:android${deviceFlag}`, {cwd: ROOT, stdio: 'inherit', env})
}

function runIos(device: boolean): void {
  // PNYX_BUILD_VARIANT is intentionally not set here — app.config.js defaults
  // to 'dev' when it is absent, which is the correct variant for local development.
  const env = {...process.env}

  console.log('Running expo prebuild for iOS...')
  execSync('npx expo prebuild --platform ios --clean', {cwd: ROOT, stdio: 'inherit', env})

  const target = device ? ' (physical device)' : ' (simulator)'
  const deviceFlag = device ? ' --device' : ''
  console.log(`Launching app on iOS${target}...`)
  execSync(`npx expo run:ios${deviceFlag}`, {cwd: ROOT, stdio: 'inherit', env})
}

function runWeb(): void {
  // PNYX_BUILD_VARIANT is intentionally not set here — app.config.js defaults
  // to 'dev' when it is absent, which is the correct variant for local development.
  const env = {...process.env}

  // Start standalone proxy server (own event loop, not blocked by Metro bundling)
  console.log('Starting dev proxy server...')
  const proxy = spawn('bun', ['scripts/dev-proxy.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  })

  console.log('Starting web dev server...')
  const child = spawn('npx', ['expo', 'start', '--web', '-c'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  })

  const cleanup = () => {
    try {
      proxy.kill('SIGTERM')
    } catch {}
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  child.on('close', (code) => {
    cleanup()
    process.exit(code ?? 0)
  })

  proxy.on('close', () => {
    // Proxy exited — don't kill Metro, it may have been intentional
  })
}

// -- Main -------------------------------------------------------------------

const args = process.argv.slice(2)
const platform = args.find((arg) => !arg.startsWith('-')) as Platform | undefined
const device = args.includes('--device') || args.includes('-d')

if (!platform || !VALID_PLATFORMS.includes(platform)) {
  console.error('Usage: bun scripts/run.ts <platform> [options]')
  console.error('Platforms:', VALID_PLATFORMS.join(', '))
  console.error('Options:')
  console.error('  --device, -d   Run on a connected physical device')
  process.exit(1)
}

const target = device ? ' (device)' : ''
console.log(`\nRunning on ${platform}${target}...\n`)

// Build workspace packages on first run (packages resolve to dist/ which requires tsc)
if (!existsSync(join(MONOREPO_ROOT, 'packages/crypto/dist'))) {
  console.log('First run detected — building packages...')
  execSync('bun run build', {cwd: MONOREPO_ROOT, stdio: 'inherit'})
}

ensureEnv()

assertDevEnvComplete()
disableSentryUploadUnlessConfigured()
clearCache()

// Metro bundler needs extra heap for large monorepo (10k+ modules)
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--max-old-space-size=16384'].filter(Boolean).join(' ')

if (device && platform === 'web') {
  console.error('The --device flag is not applicable for web platform.')
  process.exit(1)
}

switch (platform) {
  case 'android':
    runAndroid(device)
    break
  case 'ios':
    runIos(device)
    break
  case 'web':
    runWeb()
    break
}
