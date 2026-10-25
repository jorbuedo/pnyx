#!/usr/bin/env bun
/**
 * E2E Test Runner Script
 *
 * Runs Maestro E2E tests for the wallet app.
 *
 * Usage:
 *   bun scripts/e2e.ts <platform> [options]
 *
 * Platforms:
 *   ios      - Run on iOS simulator
 *   android  - Run on Android emulator
 *
 * Options:
 *   --flow <path>         - Run specific flow file
 *   --tag <tag>           - Run flows with specific tag (smoke, regression, onboarding, etc.)
 *   --device <name>       - Specific device/simulator name
 *   --install             - Install app before running tests
 *   --standalone          - Standalone mode: uses production app ID (uk.pxkq.pnyx), skips Metro
 *   --eas-profile <name>  - Download and install latest EAS build for profile, then run tests
 *   --ci                  - CI mode (no interactive prompts, generates reports)
 *
 * Build Modes:
 *   Default (no flag)     - Devclient: uk.pxkq.pnyx.dev, requires Metro
 *   --standalone          - Standalone: uk.pxkq.pnyx, no Metro needed
 *
 * Examples:
 *   bun scripts/e2e.ts ios --flow flows/onboarding/create-wallet-24.yaml
 *   bun scripts/e2e.ts ios --tag smoke
 *   bun scripts/e2e.ts ios --standalone --flow flows/smoke/app-launch.yaml
 *   bun scripts/e2e.ts ios --eas-profile e2e --tag smoke
 */

import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {$} from 'bun'

const MAESTRO_DIR = join(import.meta.dir, '..', 'e2e', 'maestro')
const ENV_FILE = join(MAESTRO_DIR, '.env')
const FLOWS_DIR = join(MAESTRO_DIR, 'flows')

/** Get all subdirectories under flows/ that contain test flows */
function getFlowDirectories(): string[] {
  return readdirSync(FLOWS_DIR, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(FLOWS_DIR, entry.name))
}

interface Options {
  platform: 'ios' | 'android'
  flow?: string
  tag?: string
  device?: string
  install: boolean
  standalone: boolean
  ci: boolean
  easProfile?: string
}

function loadEnvFile(): Record<string, string> {
  const env: Record<string, string> = {}
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=')
        if (key) {
          env[key] = valueParts.join('=')
        }
      }
    }
  }
  return env
}

function getAppId(standalone: boolean): string {
  // Standalone = uk.pxkq.pnyx, Devclient = uk.pxkq.pnyx.dev
  const baseId = 'uk.pxkq.pnyx'
  return standalone ? baseId : `${baseId}.dev`
}

function parseArgs(): Options {
  const args = process.argv.slice(2)
  const platform = args[0] as 'ios' | 'android'

  if (!platform || !['ios', 'android'].includes(platform)) {
    console.error('Usage: bun scripts/e2e.ts <ios|android> [options]')
    console.error('')
    console.error('Options:')
    console.error('  --flow <path>         Run specific flow file')
    console.error('  --tag <tag>           Run flows with specific tag')
    console.error('  --device <name>       Specific device/simulator name')
    console.error('  --install             Install app before tests')
    console.error('  --standalone          Standalone mode: production app (uk.pxkq.pnyx), no Metro')
    console.error('  --eas-profile <name>  Download and install latest EAS build, then run tests')
    console.error('  --ci                  CI mode')
    console.error('')
    console.error('Build modes:')
    console.error('  Default               Devclient (uk.pxkq.pnyx.dev), requires Metro')
    console.error('  --standalone          Standalone (uk.pxkq.pnyx), no Metro needed')
    process.exit(1)
  }

  const options: Options = {
    platform,
    install: false,
    standalone: false,
    ci: false,
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--flow':
        options.flow = args[++i] ?? ''
        break
      case '--tag':
        options.tag = args[++i] ?? ''
        break
      case '--device':
        options.device = args[++i] ?? ''
        break
      case '--install':
        options.install = true
        break
      case '--standalone':
        options.standalone = true
        break
      case '--eas-profile':
        options.easProfile = args[++i] ?? ''
        break
      case '--ci':
        options.ci = true
        break
    }
  }

  return options
}

function getMaestroPath(): string {
  const homeDir = process.env.HOME || ''
  const maestroPath = join(homeDir, '.maestro', 'bin', 'maestro')
  if (existsSync(maestroPath)) {
    return maestroPath
  }
  return 'maestro' // fallback to PATH
}

async function checkMaestro(): Promise<boolean> {
  try {
    const maestro = getMaestroPath()
    await $`${maestro} --version`.quiet()
    return true
  } catch {
    return false
  }
}

async function getBootedIOSSimulator(): Promise<string | null> {
  try {
    const result = await $`xcrun simctl list devices | grep "Booted"`.text()
    const match = result.match(/\(([A-F0-9-]+)\)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

async function getAvailableIOSSimulator(): Promise<{name: string; id: string} | null> {
  try {
    // Look for iPhone simulators (prefer iPhone 16, then any iPhone)
    const result = await $`xcrun simctl list devices available`.text()
    const lines = result.split('\n')

    // First try to find iPhone 16
    for (const line of lines) {
      if (line.includes('iPhone 16') && line.includes('Shutdown')) {
        const match = line.match(/(.+?)\s+\(([A-F0-9-]+)\)/)
        if (match?.[1] && match[2]) {
          return {name: match[1].trim(), id: match[2]}
        }
      }
    }

    // Fall back to any available iPhone
    for (const line of lines) {
      if (line.includes('iPhone') && line.includes('Shutdown')) {
        const match = line.match(/(.+?)\s+\(([A-F0-9-]+)\)/)
        if (match?.[1] && match[2]) {
          return {name: match[1].trim(), id: match[2]}
        }
      }
    }

    return null
  } catch {
    return null
  }
}

async function bootIOSSimulator(simulatorId: string): Promise<boolean> {
  try {
    console.log('Booting iOS simulator...')
    await $`xcrun simctl boot ${simulatorId}`.quiet()

    // Open Simulator app
    await $`open -a Simulator`.quiet()

    // Wait for simulator to be ready
    console.log('Waiting for simulator to be ready...')
    await new Promise((resolve) => setTimeout(resolve, 5000))

    return true
  } catch {
    return false
  }
}

async function installApp(platform: 'ios' | 'android'): Promise<boolean> {
  try {
    console.log(`\nBuilding and installing app for ${platform}...`)
    console.log('This may take a few minutes...\n')

    // Note: run.ts --device flag means "physical device", not simulator UUID.
    // For simulators, omit --device and expo will use the booted simulator.
    const runScript = join(import.meta.dir, 'run.ts')
    const args = [runScript, platform]

    const proc = Bun.spawn(['bun', ...args], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'inherit',
      stderr: 'inherit',
    })

    const exitCode = await proc.exited
    return exitCode === 0
  } catch (error) {
    console.error(`Failed to install app: ${error}`)
    return false
  }
}

async function isAppInstalled(platform: 'ios' | 'android', appId: string, device?: string): Promise<boolean> {
  try {
    if (platform === 'ios' && device) {
      const result = await $`xcrun simctl listapps ${device}`.text()
      // Use regex with word boundary to avoid substring false positives
      // e.g., uk.pxkq.pnyx should not match uk.pxkq.pnyx.dev
      const regex = new RegExp(`"${appId.replace(/\./g, '\\.')}"`)
      return regex.test(result)
    } else if (platform === 'android') {
      const result = await $`adb shell pm list packages`.text()
      // Android pm list packages format: "package:com.example.app"
      // Match exact package name (followed by newline or end)
      const regex = new RegExp(`^package:${appId.replace(/\./g, '\\.')}$`, 'm')
      return regex.test(result)
    }
    return false
  } catch {
    return false
  }
}

async function isMetroRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:8081/status')
    return response.ok
  } catch {
    return false
  }
}

async function downloadAndInstallEasBuild(platform: 'ios' | 'android', profile: string): Promise<boolean> {
  try {
    console.log(`\nDownloading and installing latest ${profile} build for ${platform}...`)
    console.log('This may take a few minutes...\n')

    const args = ['build:run', '--platform', platform, '--profile', profile, '--latest']
    console.log(`$ eas ${args.join(' ')}`)

    const proc = Bun.spawn(['eas', ...args], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'inherit',
      stderr: 'inherit',
    })

    const exitCode = await proc.exited
    return exitCode === 0
  } catch (error) {
    console.error(`Failed to download/install EAS build: ${error}`)
    return false
  }
}

async function startMetro(): Promise<boolean> {
  try {
    console.log('Starting Metro server...')

    // Start Metro in the background
    Bun.spawn(['bun', 'start'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'ignore',
      stderr: 'ignore',
    })

    // Wait for Metro to be ready (check every second, up to 60 seconds)
    console.log('Waiting for Metro to be ready...')
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (await isMetroRunning()) {
        console.log('Metro server is ready!')
        return true
      }
      if (i % 10 === 9) {
        console.log(`Still waiting for Metro... (${i + 1}s)`)
      }
    }

    console.error('Metro server failed to start within 60 seconds')
    return false
  } catch (error) {
    console.error(`Failed to start Metro: ${error}`)
    return false
  }
}

async function run() {
  const options = parseArgs()

  // Check if Maestro is installed
  const hasMaestro = await checkMaestro()
  if (!hasMaestro) {
    console.error('Maestro CLI not found. Install it with:')
    console.error('  curl -Ls "https://get.maestro.mobile.dev" | bash')
    process.exit(1)
  }

  // Auto-detect iOS simulator if not specified
  if (options.platform === 'ios' && !options.device) {
    let simulatorId = await getBootedIOSSimulator()

    if (!simulatorId) {
      // No simulator booted, try to boot one
      const available = await getAvailableIOSSimulator()
      if (available) {
        console.log(`No simulator running. Booting ${available.name}...`)
        const booted = await bootIOSSimulator(available.id)
        if (booted) {
          simulatorId = available.id
        }
      }
    }

    if (simulatorId) {
      options.device = simulatorId
    } else {
      console.error('No iOS simulator available.')
      console.error('')
      console.error('Please install a simulator or specify a device:')
      console.error('  --device <simulator-uuid>')
      console.error('')
      console.error('List available simulators: xcrun simctl list devices')
      process.exit(1)
    }
  }

  // Load .env file early to check BUILD_TYPE
  const dotEnv = loadEnvFile()

  // EAS profile mode: Download and install latest build from EAS, then run in standalone mode
  if (options.easProfile) {
    const success = await downloadAndInstallEasBuild(options.platform, options.easProfile)
    if (!success) {
      console.error('Failed to download/install EAS build')
      process.exit(1)
    }
    // EAS build installed, now run in standalone mode
    options.standalone = true
  }

  // Standalone mode: Skip Metro, use standalone app ID (uk.pxkq.pnyx)
  // Can be set via --standalone flag, --eas-profile flag, or BUILD_TYPE=standalone in .env
  const isStandalone = options.standalone || dotEnv.BUILD_TYPE === 'standalone'

  // App ID is determined by standalone mode:
  // - Standalone: uk.pxkq.pnyx
  // - Devclient: uk.pxkq.pnyx.dev
  const appId = getAppId(isStandalone)
  if (isStandalone) {
    console.log('Standalone mode: Skipping Metro server.')

    // Verify app is installed before proceeding (skip check if we just installed via EAS)
    if (!options.easProfile) {
      const appInstalled = await isAppInstalled(options.platform, appId, options.device)
      if (!appInstalled) {
        console.error(`Error: App ${appId} is not installed on the device.`)
        console.error('')
        console.error('Standalone mode requires a pre-installed EAS build.')
        console.error('Install the app first:')
        console.error('  iOS: xcrun simctl install booted /path/to/app.app')
        console.error('  Android: adb install /path/to/app.apk')
        process.exit(1)
      }
    }
    console.log(`App ${appId} is installed.`)
  } else {
    // Global setup: Ensure Metro server is running
    const metroRunning = await isMetroRunning()
    if (!metroRunning) {
      console.log('Metro server is not running.')
      const started = await startMetro()
      if (!started) {
        console.error('Failed to start Metro server')
        console.error('Please start it manually: bun start')
        process.exit(1)
      }
    } else {
      console.log('Metro server is already running.')
    }

    // Global setup: Check if app is installed, install if needed
    const appInstalled = await isAppInstalled(options.platform, appId, options.device)

    if (!appInstalled || options.install) {
      if (!appInstalled) {
        console.log(`App ${appId} is not installed on the device.`)
      }

      // Install the app
      const installed = await installApp(options.platform)
      if (!installed) {
        console.error('Failed to install app')
        process.exit(1)
      }

      console.log('\nApp installed successfully. Starting tests...\n')
    }
  }

  console.log(`Running E2E tests:`)
  console.log(`  Platform: ${options.platform}`)
  console.log(`  App ID: ${appId}`)
  console.log(`  Mode: ${isStandalone ? 'standalone (no Metro)' : 'devclient (requires Metro)'}`)
  if (options.flow) console.log(`  Flow: ${options.flow}`)
  if (options.tag) console.log(`  Tag: ${options.tag}`)
  if (options.device) console.log(`  Device: ${options.device}`)
  console.log('')

  // Build Maestro command
  // Global options (like --device) must come before the 'test' subcommand
  const maestroArgs: string[] = []

  // Add device as global option (must be before 'test' subcommand)
  if (options.device) {
    maestroArgs.push('--device', options.device)
  }

  // Add the test subcommand
  maestroArgs.push('test')

  // Pass .env variables to Maestro via -e flag
  const maestroEnvVars = {
    ...dotEnv,
    MAESTRO_APP_ID: appId,
    // Always set BUILD_TYPE (standalone flag > .env > default 'devclient')
    BUILD_TYPE: isStandalone ? 'standalone' : dotEnv.BUILD_TYPE || 'devclient',
  }

  // Add environment variables to Maestro args (each as a single argument)
  for (const [key, value] of Object.entries(maestroEnvVars)) {
    maestroArgs.push('-e', `${key}=${value}`)
  }

  // Add flow or directory
  if (options.flow) {
    maestroArgs.push(join(MAESTRO_DIR, options.flow))
  } else {
    // Discover all flow subdirectories automatically
    const flowDirs = getFlowDirectories()
    if (options.tag) {
      maestroArgs.push('--include-tags', options.tag)
    }
    maestroArgs.push(...flowDirs)
  }

  // CI mode options
  if (options.ci) {
    maestroArgs.push('--format', 'junit')
    maestroArgs.push('--output', join(MAESTRO_DIR, 'reports', `${options.platform}-report.xml`))
  }

  const maestro = getMaestroPath()
  console.log(`$ ${maestro} ${maestroArgs.join(' ')}`)
  console.log('')

  // Run Maestro
  const proc = Bun.spawn([maestro, ...maestroArgs], {
    cwd: MAESTRO_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  process.exit(exitCode)
}

run()
