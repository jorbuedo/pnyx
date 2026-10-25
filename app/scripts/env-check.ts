#!/usr/bin/env bun
/**
 * Fail a build whose environment is incomplete, before it reaches a device.
 *
 * This is the half that was missing. `ensure-env.ts` already got the env *files* and their merge
 * order right — including two documented mis-builds — but nothing checked that the merged result
 * actually contained what the app needs, and every consumer defaulted when it did not. So
 * `env/.env.production` shipped with no service URL, no Midnight network and no artifacts origin, and
 * no command anywhere said so.
 *
 * Usage:
 *   bun scripts/env-check.ts             # the local .env, as `dev`
 *   bun scripts/env-check.ts --env=prod  # env/.env.production on its own
 *   bun scripts/env-check.ts --all       # every gated variant; the pre-release check
 *
 * @module
 */

import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {APP_ENVS, type AppEnv, ENV_MANIFEST, validateEnvVars} from '../src/config/env-manifest'
import {parseEnvFile, readAppEnvFileVars} from './ensure-env'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const isAppEnv = (value: string): value is AppEnv => (APP_ENVS as readonly string[]).includes(value)

/**
 * The `EXPO_PUBLIC_*` a build for a non-dev `appEnv` declares **for itself**.
 *
 * The variant file alone, deliberately — *not* {@link buildEnvFor}'s merge. Bun auto-loads the
 * developer's `.env` into `process.env`, and that merge lets `.env`-only values through, so checking
 * the merged result would report a variant as complete because of whatever happens to be on this
 * laptop. It passed `--env=prod` on a production file that declares no service URL at all.
 *
 * A release artifact has to be self-describing: it will be built on a machine with no `.env`, so the
 * only honest question is whether `env/.env.<variant>` says everything. That also makes the check
 * reproducible, which a gate has to be.
 */
const variantEnvFor = (appEnv: AppEnv): Record<string, string | undefined> => readAppEnvFileVars(appEnv)

/**
 * `dev` has no variant file — its values come from the developer's `.env`, which Bun has already
 * loaded into `process.env` by the time this runs. Read the file directly anyway, so a check run in
 * an environment that does *not* auto-load dotenv reports the same thing.
 */
const devEnv = (): Record<string, string | undefined> => {
  const dotenv = join(ROOT, '.env')
  const fromFile = existsSync(dotenv) ? parseEnvFile(readFileSync(dotenv, 'utf8')) : {}
  const merged: Record<string, string | undefined> = {...fromFile}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('EXPO_PUBLIC_')) merged[key] = value
  }
  return merged
}

const checkOne = (appEnv: AppEnv): boolean => {
  const values = appEnv === 'dev' ? devEnv() : variantEnvFor(appEnv)
  const problems = validateEnvVars(appEnv, values)

  if (problems.length === 0) {
    console.log(`✅ ${appEnv}: all ${ENV_MANIFEST.length} declared variables OK`)
    return true
  }

  // Unknown variables are a warning, not a failure: a stale entry in someone's local `.env` should
  // not block a build, but it should not be invisible either.
  const failures = problems.filter((problem) => problem.reason !== 'unknown-variable')
  const warnings = problems.filter((problem) => problem.reason === 'unknown-variable')

  for (const warning of warnings) console.warn(`⚠️  ${appEnv}: ${warning.name} — ${warning.detail}`)
  for (const failure of failures) console.error(`❌ ${appEnv}: ${failure.name} — ${failure.detail}`)

  if (failures.length > 0) {
    const file =
      appEnv === 'dev' ? 'app/.env' : `app/env/.env.${appEnv === 'prod' ? 'production' : appEnv}`
    console.error(`   → set the above in ${file}. Declared in src/config/env-manifest.ts.`)
  }
  return failures.length === 0
}

const main = (): void => {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const flag = args.find((arg) => arg.startsWith('--env='))?.slice('--env='.length)

  if (flag !== undefined && !isAppEnv(flag)) {
    console.error(`❌ unknown --env=${flag}; expected one of ${APP_ENVS.join(' | ')}`)
    process.exit(1)
  }

  const targets: readonly AppEnv[] = all ? APP_ENVS : [flag ?? 'dev']
  const ok = targets.map(checkOne).every(Boolean)
  if (!ok) process.exit(1)
}

main()
