#!/usr/bin/env bun
/**
 * Build a standalone PREVIEW APK for testing on physical devices.
 *
 * Unlike the dev build (`build-dev.ts`), this is a release build with the JS
 * bundle embedded — it runs on its own with NO metro server. Mirrors the
 * `--env=preview` path of `build.ts` (prod app identity + `preview` telemetry
 * tag) and drops the finished APK in `dist/` so `bun run preview:serve` can
 * hand it to your phone.
 *
 * Usage:
 *   bun scripts/build-preview.ts android
 *
 * After building:
 *   bun run preview:serve   # QR download to the phone (standalone, no metro)
 *
 * @module
 */

import {execSync} from 'node:child_process'
import {cpSync, existsSync, mkdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {appEnvFileVars, buildEnvFor, ensureEnv, lanServiceUrl} from './ensure-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/**
 * Preview = prod app identity + `preview` runtime tag (matches build.ts --env=preview), built
 * against the backend `env/.env.preview` names. Without those values the release APK falls back to
 * `serviceUrl()`'s dev loopback and cannot reach Pnyx at all from a phone.
 */
const PREVIEW_ENV = {
  ...buildEnvFor({...appEnvFileVars('preview'), ...lanServiceUrl()}),
  PNYX_BUILD_VARIANT: 'prod',
  PNYX_APP_ENV: 'preview',
}

async function buildAndroid(): Promise<void> {
  console.log('\n📦 Building Android PREVIEW APK (standalone, no metro)...\n')

  console.log('Step 1/3: Running expo prebuild...')
  execSync('npx expo prebuild --platform android --clean', {cwd: ROOT, stdio: 'inherit', env: PREVIEW_ENV})

  console.log('\nStep 2/3: Building release APK with Gradle (embeds the JS bundle)...')
  execSync('./gradlew assembleRelease', {cwd: join(ROOT, 'android'), stdio: 'inherit', env: PREVIEW_ENV})

  console.log('\nStep 3/3: Copying APK...')
  const apkSource = join(ROOT, 'android/app/build/outputs/apk/release/app-release.apk')
  const outputDir = join(ROOT, 'dist')
  const apkDest = join(outputDir, 'pnyx-preview.apk')

  if (!existsSync(outputDir)) mkdirSync(outputDir, {recursive: true})
  if (!existsSync(apkSource)) throw new Error(`APK not found at ${apkSource}`)

  cpSync(apkSource, apkDest)
  console.log('\n✅ Preview APK built successfully!')
  console.log(`   Location: ${apkDest}`)
  console.log('\n📋 Next steps:')
  console.log('   1. Serve it to your phone (scan the QR):  bun run preview:serve')
  console.log(`   2. Or install via USB:                    adb install ${apkDest}`)
  console.log('   No metro server needed — the JS is embedded in the APK.\n')
}

async function main(): Promise<void> {
  const platform = process.argv[2]
  if (platform !== 'android') {
    console.log('Usage: bun scripts/build-preview.ts android')
    console.log('')
    console.log('Builds a standalone release APK (JS embedded, no metro).')
    console.log('iOS preview archives go through `bun scripts/build.ts ios --env=preview`.')
    process.exit(1)
  }

  ensureEnv()
  await buildAndroid()
}

main().catch((err) => {
  console.error('\n❌ Preview build failed:', err.message)
  process.exit(1)
})
