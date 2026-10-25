#!/usr/bin/env bun
/**
 * Serve the development APK over HTTP with a QR code for easy download.
 *
 * Starts a local HTTP server and displays a QR code that can be scanned
 * with a phone to download and install the APK.
 *
 * Usage:
 *   bun scripts/serve-apk.ts
 *
 * @module
 */

import {existsSync, readdirSync, statSync} from 'node:fs'
import {networkInterfaces} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import QRCode from 'qrcode'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST_DIR = join(ROOT, 'dist')
const PORT = 8888

/**
 * Get the local network IP address.
 */
function getLocalIP(): string {
  const interfaces = networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    const addresses = interfaces[name]
    if (!addresses) continue

    for (const addr of addresses) {
      // Skip internal and non-IPv4 addresses
      if (addr.internal || addr.family !== 'IPv4') continue
      // Prefer common local network ranges
      if (
        addr.address.startsWith('192.168.') ||
        addr.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)
      ) {
        return addr.address
      }
    }
  }

  // Fallback to localhost
  return '127.0.0.1'
}

type FindApkResult =
  | {kind: 'found'; path: string; name: string}
  | {kind: 'missing'}
  | {kind: 'ambiguous'; candidates: string[]}

/**
 * Find the APK to serve. An optional CLI arg names an exact file (e.g.
 * `pnyx-preview.apk`). Without one, dist/ must contain exactly one `.apk` —
 * devclient and preview builds share the directory, so guessing between them
 * (e.g. "first alphabetically") risks silently serving the wrong variant.
 */
function findApk(preferred?: string): FindApkResult {
  if (!existsSync(DIST_DIR)) {
    return {kind: 'missing'}
  }

  if (preferred !== undefined) {
    const preferredPath = join(DIST_DIR, preferred)
    return existsSync(preferredPath) ? {kind: 'found', path: preferredPath, name: preferred} : {kind: 'missing'}
  }

  const apks = readdirSync(DIST_DIR).filter((f) => f.endsWith('.apk'))

  if (apks.length > 1) {
    return {kind: 'ambiguous', candidates: apks}
  }

  // Destructured rather than indexed: under `noUncheckedIndexedAccess` a length check does not
  // narrow `apks[0]`, so this doubles as the empty case.
  const [only] = apks
  if (only === undefined) {
    return {kind: 'missing'}
  }

  return {
    kind: 'found',
    path: join(DIST_DIR, only),
    name: only,
  }
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
 * Format file size for display.
 */
function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const preferred = process.argv[2]
  const result = findApk(preferred)

  if (result.kind === 'ambiguous') {
    console.error('❌ Multiple APKs found in dist/ — pass one explicitly to avoid serving the wrong build:')
    for (const candidate of result.candidates) {
      console.error(`   bun scripts/serve-apk.ts ${candidate}`)
    }
    process.exit(1)
  }

  if (result.kind === 'missing') {
    if (preferred !== undefined) {
      console.error(`❌ ${preferred} not found in dist/ directory.`)
      console.error('   Run `bun run preview:build:android` first.')
    } else {
      console.error('❌ No APK found in dist/ directory.')
      console.error('   Run `bun run dev:build:android` first.')
    }
    process.exit(1)
  }

  const apk = result

  const localIP = getLocalIP()
  const downloadUrl = `http://${localIP}:${PORT}/${apk.name}`
  const fileSize = statSync(apk.path).size

  console.log('\n📱 APK Download Server\n')
  console.log(`   File: ${apk.name}`)
  console.log(`   Size: ${formatSize(fileSize)}`)
  console.log(`   URL:  ${downloadUrl}`)
  console.log(`\n${'─'.repeat(50)}\n`)

  // Generate and display QR code
  const qrString = await generateQRString(downloadUrl)
  console.log(qrString)

  console.log('─'.repeat(50))
  console.log('\n📋 Instructions:')
  console.log('   1. Make sure your phone is on the same WiFi network')
  console.log('   2. Scan the QR code with your phone camera')
  console.log('   3. Download and install the APK')
  console.log('   4. You may need to allow "Install from unknown sources"')
  console.log('\n   Press Ctrl+C to stop the server\n')

  // Start HTTP server
  Bun.serve({
    port: PORT,
    async fetch(req: Request) {
      const url = new URL(req.url)

      // Serve the APK file
      if (url.pathname === `/${apk.name}` || url.pathname === '/') {
        const file = Bun.file(apk.path)
        console.log(`📥 Download started from ${req.headers.get('user-agent')?.slice(0, 50) ?? 'unknown'}`)

        return new Response(file, {
          headers: {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': `attachment; filename="${apk.name}"`,
            'Content-Length': String(fileSize),
          },
        })
      }

      // Simple HTML page with download link
      if (url.pathname === '/index.html' || url.pathname === '/download') {
        return new Response(
          `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Download ${apk.name}</title>
  <style>
    body { font-family: system-ui; padding: 20px; text-align: center; background: #1a1a1a; color: #fff; }
    a { display: inline-block; margin-top: 20px; padding: 15px 30px; background: #3154CB; color: #fff; text-decoration: none; border-radius: 8px; font-size: 18px; }
    a:hover { background: #4165dc; }
    .size { color: #888; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>📱 ${apk.name}</h1>
  <p class="size">${formatSize(fileSize)}</p>
  <a href="/${apk.name}">Download APK</a>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    After downloading, open the file to install.<br>
    You may need to enable "Install from unknown sources".
  </p>
</body>
</html>`,
          {
            headers: {'Content-Type': 'text/html'},
          },
        )
      }

      return new Response('Not found', {status: 404})
    },
  })

  console.log(`🌐 Server running at http://${localIP}:${PORT}\n`)
}

main().catch((err) => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
