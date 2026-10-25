/**
 * Maestro screenshot wrapper MCP server.
 *
 * Provides a safe screenshot tool that automatically resizes images to prevent
 * Claude API 400 errors (which occur when images exceed 2000px dimensions).
 *
 * The regular `mcp__maestro__take_screenshot` tool returns images >2000px which
 * crash Claude sessions. This wrapper provides `take_screenshot_resized` which
 * auto-resizes to max 1800px.
 *
 * Usage:
 *   bun app/scripts/maestro-mcp/server.ts
 *
 * @module
 */

import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'

const MAX_DIMENSION = 1200 // Aggressive to minimize context usage across multiple screenshots
const JPEG_QUALITY = 70 // Balance between size and readability

const log = (msg: string): void => {
  process.stderr.write(`[maestro-screenshot] ${msg}\n`)
}

/**
 * Execute a shell command and return stdout as a buffer.
 */
const execCommand = (cmd: string, args: string[]): Promise<{stdout: Buffer; stderr: string}> => {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    const stdout: Buffer[] = []
    let stderr = ''

    proc.stdout.on('data', (data) => stdout.push(data))
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({stdout: Buffer.concat(stdout), stderr})
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`))
      }
    })

    proc.on('error', reject)
  })
}

/**
 * Detect platform from device ID.
 * Android emulators: emulator-XXXX or device serial
 * iOS simulators: UUID format (XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX)
 */
const detectPlatform = (deviceId: string): 'android' | 'ios' => {
  // iOS simulator UUIDs are 36 chars with dashes in specific positions
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(deviceId)) {
    return 'ios'
  }
  return 'android'
}

/**
 * Take a screenshot using platform-native tools.
 * - Android: adb exec-out screencap
 * - iOS: xcrun simctl io screenshot
 */
const takeScreenshot = async (deviceId: string): Promise<string> => {
  const tmpDir = os.tmpdir()
  const timestamp = Date.now()
  const outputPath = path.join(tmpDir, `maestro-screenshot-${timestamp}.png`)
  const platform = detectPlatform(deviceId)

  log(`Detected platform: ${platform}`)

  if (platform === 'android') {
    // Use adb to capture screenshot
    const {stdout} = await execCommand('adb', ['-s', deviceId, 'exec-out', 'screencap', '-p'])
    fs.writeFileSync(outputPath, stdout)
  } else {
    // Use xcrun simctl for iOS
    await execCommand('xcrun', ['simctl', 'io', deviceId, 'screenshot', outputPath])
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('Screenshot file was not created')
  }

  return outputPath
}

/**
 * Resize and compress an image to minimize context usage.
 * - Resizes to fit within max dimensions (preserving aspect ratio)
 * - Converts to JPEG with compression for smaller file size
 * Uses sips (macOS built-in) for simplicity - no extra dependencies.
 */
const resizeAndCompress = async (inputPath: string, maxDim: number, quality: number): Promise<string> => {
  // Output as JPEG for better compression
  const outputPath = inputPath.replace('.png', '-compressed.jpg')

  // Get current dimensions using sips
  const {stdout: infoStdout} = await execCommand('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', inputPath])
  const infoText = infoStdout.toString()

  const widthStr = infoText.match(/pixelWidth:\s*(\d+)/)?.[1]
  const heightStr = infoText.match(/pixelHeight:\s*(\d+)/)?.[1]

  if (!widthStr || !heightStr) {
    throw new Error('Could not determine image dimensions')
  }

  const width = parseInt(widthStr, 10)
  const height = parseInt(heightStr, 10)

  log(`Original dimensions: ${width}x${height}`)

  // Calculate new dimensions preserving aspect ratio
  const scale = Math.min(maxDim / width, maxDim / height, 1) // Don't upscale
  const newWidth = Math.floor(width * scale)
  const newHeight = Math.floor(height * scale)

  log(`Target dimensions: ${newWidth}x${newHeight}`)

  // Copy, resize, and convert to JPEG with compression
  fs.copyFileSync(inputPath, outputPath.replace('.jpg', '.png'))

  // Resize
  await execCommand('sips', [
    '--resampleHeightWidth',
    newHeight.toString(),
    newWidth.toString(),
    outputPath.replace('.jpg', '.png'),
  ])

  // Convert to JPEG with quality setting
  await execCommand('sips', [
    '-s',
    'format',
    'jpeg',
    '-s',
    'formatOptions',
    quality.toString(),
    outputPath.replace('.jpg', '.png'),
    '--out',
    outputPath,
  ])

  // Clean up intermediate PNG
  try {
    fs.unlinkSync(outputPath.replace('.jpg', '.png'))
  } catch {}

  // Log final size
  const stats = fs.statSync(outputPath)
  log(`Compressed to: ${newWidth}x${newHeight}, ${Math.round(stats.size / 1024)}KB`)

  return outputPath
}

/**
 * Read image file and return as base64.
 */
const imageToBase64 = (imagePath: string): {base64: string; mimeType: string} => {
  const imageBuffer = fs.readFileSync(imagePath)
  const base64 = imageBuffer.toString('base64')
  const mimeType = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  return {base64, mimeType}
}

/**
 * Clean up temporary files.
 */
const cleanupTempFiles = (...paths: string[]): void => {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p)
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

const mcp = new McpServer({name: 'maestro-screenshot', version: '0.1.0'})

mcp.registerTool(
  'take_screenshot_resized',
  {
    description: `Take a screenshot from a device/emulator, resize to max ${MAX_DIMENSION}px, and compress as JPEG (quality ${JPEG_QUALITY}) to minimize context usage. Use this instead of mcp__maestro__take_screenshot to prevent context overflow during test flows.`,
    inputSchema: {
      device_id: z
        .string()
        .describe('The device identifier (e.g., "emulator-5554" for Android, or iOS simulator UUID). Required.'),
    },
  },
  async (input) => {
    const {device_id} = input
    let originalPath = ''
    let compressedPath = ''

    try {
      log(`Taking screenshot from device: ${device_id}`)

      // Take screenshot
      originalPath = await takeScreenshot(device_id)
      log(`Screenshot saved to: ${originalPath}`)

      // Resize and compress
      compressedPath = await resizeAndCompress(originalPath, MAX_DIMENSION, JPEG_QUALITY)

      // Convert to base64
      const {base64, mimeType} = imageToBase64(compressedPath)

      // Return as image content
      return {
        content: [
          {
            type: 'image',
            data: base64,
            mimeType,
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Error: ${errorMessage}`)
      return {
        content: [{type: 'text', text: `Failed to take screenshot: ${errorMessage}`}],
        isError: true,
      }
    } finally {
      // Clean up temp files
      cleanupTempFiles(originalPath, compressedPath)
    }
  },
)

const transport = new StdioServerTransport()
await mcp.connect(transport)
log('MCP stdio server connected')
