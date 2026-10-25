#!/usr/bin/env bun
/**
 * Start metro dev server with proper LAN IP for device connections.
 *
 * Displays a QR code with the dev client deep link that includes the
 * correct LAN IP for connecting from physical devices.
 *
 * Usage:
 *   bun scripts/start-dev.ts
 *
 * @module
 */

import {spawn} from 'node:child_process'
import {networkInterfaces} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import QRCode from 'qrcode'
import {assertDevEnvComplete, ensureEnv} from './ensure-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/**
 * Get the local network IP address.
 */
function getLocalIP(): string {
  const interfaces = networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    const addresses = interfaces[name]
    if (!addresses) continue

    for (const addr of addresses) {
      if (addr.internal || addr.family !== 'IPv4') continue
      if (
        addr.address.startsWith('192.168.') ||
        addr.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)
      ) {
        return addr.address
      }
    }
  }

  return '127.0.0.1'
}

/**
 * Generate QR code as string for terminal display.
 */
async function generateQRString(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'terminal',
    small: true,
  })
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const localIP = getLocalIP()

  // Dev client deep link URL
  const devClientUrl = `exp+pnyx-wallet://expo-development-client/?url=http://${localIP}:8081`

  ensureEnv()

  assertDevEnvComplete()

  // Generate QR code
  const qr = await generateQRString(devClientUrl)

  // Display QR code prominently at the top
  console.log('\n'.repeat(2))
  console.log('═'.repeat(60))
  console.log('📱 Scan this QR code with your development app')
  console.log('═'.repeat(60))
  console.log('')
  console.log(qr)
  console.log('')
  console.log(`   Deep Link: ${devClientUrl}`)
  console.log(`   LAN IP:    ${localIP}:8081`)
  console.log('')
  console.log('═'.repeat(60))
  console.log('\n')

  // Start expo with dev client
  // Metro bundler needs extra heap for large monorepo (10k+ modules)
  const nodeOptions = [process.env.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' ')
  // Default-on the perf-MCP log stream in dev. The transport at
  // src/logger/local-stream-transport.ts gates on `=== '1'`, so opt out by
  // running `EXPO_PUBLIC_DEV_LOG_STREAM=0 bun run dev`.
  const devLogStream = process.env.EXPO_PUBLIC_DEV_LOG_STREAM ?? '1'
  const expo = spawn('npx', ['expo', 'start', '--dev-client', '-c'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      REACT_NATIVE_PACKAGER_HOSTNAME: localIP,
      EXPO_PUBLIC_DEV_LOG_STREAM: devLogStream,
    },
  })

  expo.on('error', (err) => {
    console.error(`Failed to start expo: ${err.message}`)
    process.exit(1)
  })

  expo.on('close', (code) => {
    process.exit(code ?? 0)
  })
}

main().catch((err) => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
