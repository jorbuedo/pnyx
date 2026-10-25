/**
 * Ensure a local `.env` exists for dev/build.
 *
 * Copies the tracked `env/.env.development` to `.env` when no local `.env` is
 * present, so build/run scripts have an env file without manual setup. Build
 * variants override individual `EXPO_PUBLIC_*` values via the process env.
 *
 * @module
 */

import {cpSync, existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {type AppEnv, validateEnvVars} from '../src/config/env-manifest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Refuse to proceed when a variant does not declare everything the app requires.
 *
 * Lives here rather than in each build script because all five of them already funnel through
 * {@link ensureEnv} / {@link appEnvFileVars} — one chokepoint instead of five call sites that can
 * each be forgotten. `scripts/env-check.ts` runs the same validation on demand.
 *
 * Non-dev variants are judged on their **own file**, not the merged result: Bun auto-loads the
 * developer's `.env`, so a merged check would pass a release build because of what happens to be on
 * this laptop. See `env-check.ts` for the longer note.
 */
export function assertEnvComplete(appEnv: AppEnv, values: Record<string, string | undefined>): void {
  const failures = validateEnvVars(appEnv, values).filter((problem) => problem.reason !== 'unknown-variable')
  if (failures.length === 0) return
  for (const failure of failures) console.error(`\u274c ${appEnv}: ${failure.name} — ${failure.detail}`)
  console.error(`   Declared in app/src/config/env-manifest.ts. Run \`bun run env:check --env=${appEnv}\`.`)
  throw new Error(`environment incomplete for --env=${appEnv}: ${failures.map((f) => f.name).join(', ')}`)
}

export function ensureEnv(): void {
  const envFile = join(ROOT, '.env')
  if (existsSync(envFile)) return
  const src = join(ROOT, 'env', '.env.development')
  if (existsSync(src)) {
    cpSync(src, envFile)
    console.log('Copied default .env from env/.env.development')
  }
}

/**
 * Gate the `dev` variant against the local `.env`, which Bun has already loaded into `process.env`.
 * Called by the run/start scripts after {@link ensureEnv} so a developer whose `.env` predates a new
 * required variable is told once, up front, instead of hitting a throw inside a feature.
 */
export function assertDevEnvComplete(): void {
  const dotenv = join(ROOT, '.env')
  const fromFile = existsSync(dotenv) ? parseEnvFile(readFileSync(dotenv, 'utf8')) : {}
  const values: Record<string, string | undefined> = {...fromFile}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('EXPO_PUBLIC_')) values[key] = value
  }
  assertEnvComplete('dev', values)
}

/**
 * A LAN preview points at the dev machine's own service.
 *
 * Derived from the single `PNYX_LAN_HOST` knob so the cleartext exception (see
 * `plugins/with-lan-cleartext.js`) and the URL can never disagree — an exception for one host with
 * the app pointed at another is a build that fails for a reason nothing reports. An explicit
 * `EXPO_PUBLIC_SERVICE_URL` still wins.
 */
export function lanServiceUrl(): Record<string, string> {
  const value = process.env.PNYX_LAN_HOST?.trim()
  if (value === undefined || value === '') return {}
  // `host` or `host:port`. A port belongs here because reaching the machine at all depends on the
  // firewall already allowing that port, and the ports this project has open are the logger's (9876)
  // and the APK server's (8888) — not the service's default 3300.
  const url = `http://${value.includes(':') ? value : `${value}:3300`}`
  console.log(`LAN preview: EXPO_PUBLIC_SERVICE_URL=${url} (cleartext permitted for ${lanHostOnly(value)} only)`)
  return {EXPO_PUBLIC_SERVICE_URL: url}
}

/** The bare hostname from `PNYX_LAN_HOST`. Android's `domain-config` takes a host, never a port. */
export function lanHostOnly(value: string): string {
  return value.split(':')[0] ?? value
}

/**
 * The tracked env file describing each non-dev backend.
 *
 * `dev` is absent on purpose: its file is the *template* `ensureEnv` copies to `.env`, which the
 * developer then tunes (pointing at a local service, enabling the insecure vault). Feeding it back
 * in would overrule those edits with the hosted defaults.
 */
const APP_ENV_FILES: Readonly<Record<string, string>> = {
  preview: '.env.preview',
  prod: '.env.production',
}

/** `KEY=value` lines; `#` comments, blank lines and optional surrounding quotes. */
export function parseEnvFile(contents: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const raw = trimmed.slice(separator + 1).trim()
    // An empty assignment is meaningful (`EXPO_PUBLIC_SENTRY_DSN=` disables Sentry), so it is kept
    // rather than skipped.
    vars[key] = /^(".*"|'.*')$/s.test(raw) ? raw.slice(1, -1) : raw
  }
  return vars
}

/**
 * The `EXPO_PUBLIC_*` values a non-dev build must be built with, from `env/.env.<appEnv>`.
 *
 * Until this existed the files were decorative: `ensureEnv` only ever copied the *development*
 * template, and Expo's own dotenv reads the project-root `.env` — so a preview or production build
 * inherited whatever a developer happened to have in their gitignored `.env`. With
 * `EXPO_PUBLIC_SERVICE_URL` commented out there (correct for dev, where `serviceUrl()` resolves the
 * local service per platform) a preview APK shipped pointing at `http://10.0.2.2:3300`: an emulator
 * loopback alias that resolves to nothing on a device, over cleartext HTTP a release build blocks
 * anyway. Every call to the content service failed.
 *
 * ⚠️ Merge them through {@link buildEnvFor}, not with a bare `{...these, ...process.env}` — under Bun
 * that spread ranks the developer's `.env` above the variant file and silently mis-builds.
 *
 * Returns `{}` for an appEnv with no file (`dev`, or a variant whose file was never added) rather
 * than inventing values; the caller's other sources then apply unchanged.
 */
export function appEnvFileVars(appEnv: string): Record<string, string> {
  const vars = readAppEnvFileVars(appEnv)
  assertEnvComplete(appEnv as AppEnv, vars)
  return vars
}

/**
 * The variant file's values, **unvalidated**.
 *
 * Split from {@link appEnvFileVars} so `scripts/env-check.ts` can report every variant in one run: it
 * validates and prints each result itself, and going through the throwing path made `--all` die on
 * the first incomplete variant with a stack trace instead of a readable list.
 */
export function readAppEnvFileVars(appEnv: string): Record<string, string> {
  const file = APP_ENV_FILES[appEnv]
  if (file === undefined) return {}
  const path = join(ROOT, 'env', file)
  if (!existsSync(path)) {
    console.warn(`No env/${file} for --env=${appEnv}; leaving its EXPO_PUBLIC_* values unset.`)
    return {}
  }
  const vars = parseEnvFile(readFileSync(path, 'utf8'))
  console.log(`Loaded env/${file} (${Object.keys(vars).length} vars) for --env=${appEnv}`)
  return vars
}

/**
 * Build environment for a variant, with `.env`-derived values ranked BELOW the variant file.
 *
 * **The trap this exists for.** These scripts run under `bun`, and **Bun auto-loads `.env` into
 * `process.env`** (Node does not). So by the time the script runs, every variable the developer's
 * `.env` defines is already in `process.env` — indistinguishable, to a naive `{...variantVars,
 * ...process.env}`, from something they exported deliberately. The spread then promotes `.env` over
 * the tracked variant file, silently.
 *
 * It shipped a wrong preview APK: the build was told to use the preprod indexer and embedded the
 * **mainnet** one from `.env`, while `EXPO_PUBLIC_SERVICE_URL` — commented out in `.env`, so Bun
 * never set it — came through correctly. A partial, silent loss that looks like a working build. With
 * the wrong indexer the app cannot read its own identity row, so `ensureIdentityRegistered` skips
 * registration and the failure surfaces three layers from the cause.
 *
 * So a variant value wins when the current value is unset *or* is exactly what `.env` says; a value
 * that differs from `.env` was set deliberately and is left alone. Non-`EXPO_PUBLIC` variables
 * (`PATH`, `HOME`, …) pass through untouched.
 */
export function buildEnvFor(variantVars: Record<string, string>): NodeJS.ProcessEnv {
  const dotenvPath = join(ROOT, '.env')
  const fromDotenv = existsSync(dotenvPath) ? parseEnvFile(readFileSync(dotenvPath, 'utf8')) : {}
  const env: NodeJS.ProcessEnv = {...process.env}
  const promoted: string[] = []
  for (const [key, value] of Object.entries(variantVars)) {
    const current = process.env[key]
    if (current === undefined || current === fromDotenv[key]) {
      env[key] = value
      if (current !== undefined && current !== value) promoted.push(key)
    } else {
      console.log(`Keeping explicit override ${key} (differs from .env, so it was set on purpose)`)
    }
  }
  if (promoted.length > 0) {
    console.log(`Variant values override .env for: ${promoted.join(', ')}`)
  }
  return env
}

/**
 * Keep the Sentry source-map upload out of the build unless a token is configured.
 *
 * `@sentry/react-native` is a direct dependency, so its `sentry.gradle` is applied to
 * every Android build whether or not the Expo config plugin is present, and on a
 * release build it shells out to `sentry-cli`. With no org configured that fails the
 * whole build:
 *   "Process 'command '…/sentry-cli'' finished with non-zero exit value 1"
 *
 * `.env` already carries `SENTRY_DISABLE_AUTO_UPLOAD=true`, but nothing ever read it
 * into the environment — `ensureEnv` only copies the file — and `sentry.gradle` checks
 * `System.getenv`, not a Gradle property. So the flag has never actually reached a
 * build.
 *
 * Setting it here rather than in `.env` also means it holds for anyone invoking the
 * scripts, and it lifts automatically the moment a real `SENTRY_AUTH_TOKEN` exists.
 */
export function disableSentryUploadUnlessConfigured(): void {
  if (process.env.SENTRY_AUTH_TOKEN) return
  process.env.SENTRY_DISABLE_AUTO_UPLOAD = 'true'
  process.env.SENTRY_DISABLE_NATIVE_DEBUG_UPLOAD = 'true'
}
