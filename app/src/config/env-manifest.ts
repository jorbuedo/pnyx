/**
 * The single declaration of what `EXPO_PUBLIC_*` this app needs, and where.
 *
 * **Why this exists.** The env *files* and their merge order were already careful (see
 * `scripts/ensure-env.ts`, which documents two shipped mis-builds). What was missing is that nothing
 * declared any variable as *required*, and every consumer defaulted when one was absent — so a
 * missing value never failed a build, it degraded into something plausible and wrong somewhere else:
 *
 * - `serviceUrl()` fell back to `http://10.0.2.2:3300`, an emulator-only loopback alias. Unset in
 *   `env/.env.production`, so a production build pointed the content service at nothing.
 * - `EXPO_PUBLIC_PNYX_NETWORK` unset meant "ask the service instead", which turned a misconfigured
 *   URL into an onboarding screen that hung on a TCP timeout doing work that is purely local.
 * - `EXPO_PUBLIC_ARTIFACTS_URL` unset meant "fetch circuit artifacts from the content service",
 *   which 503s against the hosted Worker and surfaced three layers away as "identity has not been
 *   registered".
 *
 * Each is the same shape: a convenient default that is right in one environment, silently wrong in
 * another, and diagnosed far from its cause. So required variables now have no default anywhere —
 * `env.ts` throws, and `scripts/env-check.ts` fails the build before a device ever sees it.
 *
 * **The required set is deliberately small: it is deployment *identity*.** Which backend, which
 * Midnight chain, where the circuit artifacts live, where remote config lives. Those four have no
 * universally-correct value and differ per variant, so a build must state them. Everything the *user*
 * controls at runtime is a different thing entirely — the Cardano network is chosen in Settings on a
 * mainnet-capable app, so its in-code default is a product decision, and its endpoint cannot even be
 * expressed as one build-time value. Those stay optional overrides, and calling them "fallbacks"
 * would confuse a real product default with an unexamined `??`.
 *
 * **Optional is not the same as defaulted.** Several variables are genuinely absent-able and their
 * absence already means something precise (`SENTRY_DSN` empty disables reporting; no
 * `MIDNIGHT_DUST_DONATION_ADDRESS` means the Donate option is not offered). Those stay optional and
 * are declared as such here, so "optional" is a recorded decision rather than an unexamined `??`.
 *
 * Pure data and pure functions on purpose: `scripts/env-check.ts` runs this in Node against the env
 * files, and it needs no React Native, no Expo and no bundler.
 *
 * @module
 */

/** Build variants that have a tracked env file and are therefore gated. */
export const APP_ENVS = ['dev', 'preview', 'prod'] as const
export type AppEnv = (typeof APP_ENVS)[number]

export type EnvKind =
  /** Absolute `http(s)://` origin. */
  | 'url'
  /** One of `allowed`. */
  | 'enum'
  /** Free text; only emptiness is checked. */
  | 'text'
  /**
   * A 32-byte value as 64 lowercase hex characters — a Midnight contract address.
   *
   * Checked rather than treated as text because a truncated or `0x`-prefixed address does not fail as
   * a malformed value: it fails as "nothing is deployed there", several layers away, which is the
   * exact class of bewildering failure this manifest exists to prevent.
   */
  | 'hex32'

export type EnvSpec = {
  readonly name: string
  readonly kind: EnvKind
  readonly allowed?: readonly string[]
  /**
   * Variants where this must be present and non-empty. Empty array = always optional.
   *
   * A variable required in *some* variants is the normal case: dev points at a local service, prod
   * at the hosted one, and neither may inherit the other's value by accident.
   */
  readonly requiredIn: readonly AppEnv[]
  /** One line, shown by `env-check` so a failure explains itself without opening this file. */
  readonly purpose: string
}

const ALL: readonly AppEnv[] = APP_ENVS
const NONE: readonly AppEnv[] = []

/**
 * Every `EXPO_PUBLIC_*` the app or its packages read.
 *
 * Adding a read without adding it here fails `no-raw-env.test.ts`. That guard is the only thing
 * keeping this list from rotting into a subset of reality.
 */
export const ENV_MANIFEST: readonly EnvSpec[] = [
  // --- Required: the app cannot function without these, and no default is correct everywhere. ---
  {
    name: 'EXPO_PUBLIC_SERVICE_URL',
    kind: 'url',
    requiredIn: ALL,
    purpose: 'Content service origin (auth, /register relay, DM delivery).',
  },
  {
    name: 'EXPO_PUBLIC_PNYX_NETWORK',
    kind: 'enum',
    allowed: ['mainnet', 'preprod', 'preview', 'undeployed'],
    requiredIn: ALL,
    purpose:
      'Midnight network this build talks to: which chain rows, contracts and DUST are read from, and what the login challenge commits to. NOT an identity input — `C` is the same on every network — so a wrong value misdirects lookups rather than changing who the user is. Checked against /auth/config at sign-in.',
  },
  {
    name: 'EXPO_PUBLIC_ARTIFACTS_URL',
    kind: 'url',
    requiredIn: ALL,
    purpose: 'ZK circuit artifacts origin, keyed by contract address. Required to prove a registration on device.',
  },
  {
    name: 'EXPO_PUBLIC_REMOTE_CONFIG_URL',
    kind: 'url',
    requiredIn: ALL,
    purpose:
      'Remote config JSON endpoint (per-appEnv env.json). Read directly by @pnyx/config — a package cannot import the app, so there is no accessor here; the gate is what enforces it.',
  },

  // --- Optional: absence is a meaningful, handled state. Declared, not defaulted. ---
  {
    name: 'EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS',
    kind: 'hex32',
    requiredIn: NONE,
    purpose:
      'The deployed PaymentContract, 64 hex. Handles cost a permit and this is the only issuer of one, so its absence means handles are unavailable on this build — a real composition, since a deployment can have identities without a namespace. ⚠️ It also seals every handle contract: a handle claimed against one payment address is unreachable from a build configured with another, which is how the `test` handle from 2026-08-24 was orphaned.',
  },
  {
    name: 'EXPO_PUBLIC_MIDNIGHT_PAYMENT_SHIELDED_TREASURY',
    kind: 'text',
    requiredIn: NONE,
    purpose:
      "The payment contract's shielded treasury as a full `mn_shield-addr`. ⚠️ **Not a duplicate of what is on chain.** The contract's sealed `shieldedTreasury` is a `ZswapCoinPublicKey` — half an address — and the other half, the encryption key, is what lets a payer attach the ciphertext that makes the forwarded coin findable by an ordinary scan. Nothing on chain carries it, so a shielded purchase built without it either strands the treasury's coin or is refused outright by the builder. Optional because only `buyPermitShielded` reads it; absent means the shielded purchase rail is off on this build, which is a real composition while the unshielded rail carries every priced tier.",
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_NETWORK',
    kind: 'enum',
    allowed: ['mainnet', 'preprod', 'preview'],
    requiredIn: NONE,
    purpose:
      'Overrides which Cardano network a *fresh install* starts on. Optional by design: the app is mainnet-capable and the user picks the network in Settings, so mainnet is a product default rather than an inferred one, and it does not track the build variant.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_KOIOS_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose:
      'Single-endpoint override for the Cardano rail. Cannot be required: the user switches network at runtime and one URL cannot serve them all, so the endpoint is resolved per network in code. (Those in-code defaults being public Koios hosts is docs/AUDIT-2026-07-14 §1.5 — a separate item, not something this gate can fix.)',
  },
  {
    name: 'EXPO_PUBLIC_SENTRY_DSN',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Empty disables runtime error reporting. No Sentry org is configured for this project.',
  },
  {
    name: 'EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD',
    kind: 'url',
    requiredIn: NONE,
    purpose:
      "The preprod indexer URL, because Midnight's own answers 410 and the replacement (Blockfrost) 403s without a key. ⚠️ The credential belongs in EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD_PROJECT_ID, not in this URL: a URL reaches logs, error strings and (through the connector's `configuration`) connected dApps. A key left in the query string here is still accepted and split off by `services/midnight/indexer-auth.ts`, so no local env file has to be migrated.",
  },
  {
    name: 'EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD_PROJECT_ID',
    kind: 'text',
    requiredIn: NONE,
    purpose:
      "Blockfrost's `project_id` for the preprod indexer, sent as a `project_id` header (its other accepted form; `Project-Id` is a different header and 403s). Absent is correct for an indexer that needs no key, like ours on mainnet. ⚠️ Still bundled into whatever build reads it, so treat any key here as public to that build's users; the durable answer is a proxy that holds the token server-side.",
  },
  {
    name: 'EXPO_PUBLIC_PNYX_INDEXER_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose:
      'Override for the identity-network indexer, for a device against a local standalone chain. Applies only to the declared network.',
  },
  {
    name: 'EXPO_PUBLIC_MIDNIGHT_DUST_DONATION_ADDRESS',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Unset → the Donate option is not offered at all.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_SCRIPT_VERIFICATION_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose:
      "CIP-171 script-verification registry (uplc.link's API, or any host serving `/api/v1/scripts/by-hash/{hash}`). Reviewing a transaction that runs a contract asks it whether that script hash is linked to published source. Optional and off by default: absent means the review says nothing about provenance rather than saying 'unverified', which is the honest distinction — an unanswered question is not a negative answer.",
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_KOIOS_TOKEN',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Authenticated Koios tier (higher rate limit). Unset → anonymous tier.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_DATA_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'Pool/DRep metadata endpoint override; falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_STEELSWAP_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'SteelSwap asset-data/swap endpoint override; falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_STEELSWAP_KEY',
    kind: 'text',
    requiredIn: NONE,
    purpose:
      'Pnyx partner API key — the principal SteelSwap attributes the swap fee to. Unset → the per-install CIP-8 key, which attributes the fee to the user. Never commit a value.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_CEXPLORER_ICON_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'Token icon CDN override; falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_CEXPLORER_IMG_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'Pool/DRep image CDN override; falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_MEDIA_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'First-party asset-media host override (NFT list icons); falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_CARDANO_IPFS_GATEWAY',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'IPFS gateway for NFT media; falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_KRAKEN_URL',
    kind: 'url',
    requiredIn: NONE,
    purpose: 'Price-history source override; falls back to the in-code constant.',
  },
  {
    name: 'EXPO_PUBLIC_DEEP_ADA_HISTORY_URL',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Deep ADA history dataset. The literal "off" disables it; unset uses the in-code default.',
  },
  {
    name: 'EXPO_PUBLIC_INSECURE_DEV_VAULT',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Dev-only: "1" bypasses the OS keychain gate. Also gated on __DEV__, so a release build ignores it.',
  },
  {
    name: 'EXPO_PUBLIC_DEV_LOG_STREAM',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Dev-only: "1" streams logs to the local collector.',
  },
  {
    name: 'EXPO_PUBLIC_DEV_LOG_STREAM_HOST',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Dev-only: host for the log stream; unset derives it from the Metro host.',
  },
  {
    name: 'EXPO_PUBLIC_TREZOR_TRACE',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'Debug-only: "true" enables Trezor protocol tracing.',
  },
  {
    name: 'EXPO_PUBLIC_E2E_AUTO_RESTORE',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'E2E-only: auto-restores a wallet on launch.',
  },
  {
    name: 'EXPO_PUBLIC_E2E_MNEMONIC',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'E2E-only: the phrase auto-restore uses.',
  },
  {
    name: 'EXPO_PUBLIC_E2E_WALLET_NAME',
    kind: 'text',
    requiredIn: NONE,
    purpose: 'E2E-only: the name auto-restore uses.',
  },
]

const BY_NAME: ReadonlyMap<string, EnvSpec> = new Map(ENV_MANIFEST.map((spec) => [spec.name, spec]))

export const envSpec = (name: string): EnvSpec | undefined => BY_NAME.get(name)

export const isRequiredIn = (spec: EnvSpec, appEnv: AppEnv): boolean => spec.requiredIn.includes(appEnv)

export type EnvProblem = {
  readonly name: string
  readonly reason: 'missing' | 'empty' | 'not-allowed' | 'not-a-url' | 'not-hex32' | 'unknown-variable'
  readonly detail: string
}

/** `http(s)` with a host. Rejects the bare-host and `file:` shapes an env file invites. */
const looksLikeUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * Every problem with `values` for `appEnv`.
 *
 * Returns all of them rather than the first: a fresh env file is usually missing several, and fixing
 * them one build at a time is the experience this is meant to replace.
 *
 * An **unset** required variable and an **empty** one are separate reasons because they are different
 * mistakes — `FOO=` is someone believing they disabled something that is not optional.
 *
 * `values` should be the *merged* environment a build will actually use, not one file — the whole
 * failure mode `scripts/ensure-env.ts` documents is files ranking unexpectedly against each other.
 */
export const validateEnvVars = (
  appEnv: AppEnv,
  values: Readonly<Record<string, string | undefined>>,
): readonly EnvProblem[] => {
  const problems: EnvProblem[] = []

  for (const spec of ENV_MANIFEST) {
    const raw = values[spec.name]
    const required = isRequiredIn(spec, appEnv)

    if (raw === undefined) {
      if (required) {
        problems.push({name: spec.name, reason: 'missing', detail: `not set for --env=${appEnv}. ${spec.purpose}`})
      }
      continue
    }

    const value = raw.trim()
    if (value === '') {
      if (required) {
        problems.push({name: spec.name, reason: 'empty', detail: `set but empty for --env=${appEnv}. ${spec.purpose}`})
      }
      continue
    }

    // Shape is checked whenever a value is present, required or not: a typo in an optional override
    // is still a typo, and it would otherwise surface as a failed fetch at runtime.
    if (spec.kind === 'enum' && spec.allowed !== undefined && !spec.allowed.includes(value)) {
      problems.push({
        name: spec.name,
        reason: 'not-allowed',
        detail: `${JSON.stringify(value)} is not one of ${spec.allowed.join(' | ')}`,
      })
    }
    if (spec.kind === 'hex32' && !/^[0-9a-f]{64}$/.test(value)) {
      problems.push({
        name: spec.name,
        reason: 'not-hex32',
        detail: `${JSON.stringify(value)} is not 64 lowercase hex characters`,
      })
    }
    if (spec.kind === 'url' && !looksLikeUrl(value)) {
      problems.push({
        name: spec.name,
        reason: 'not-a-url',
        detail: `${JSON.stringify(value)} is not an absolute http(s) URL`,
      })
    }
  }

  // An `EXPO_PUBLIC_*` nobody reads is usually a rename that lost its call site, or a typo that
  // leaves the real variable unset. Reported so it cannot sit there looking effective.
  for (const name of Object.keys(values)) {
    if (name.startsWith('EXPO_PUBLIC_') && !BY_NAME.has(name)) {
      problems.push({name, reason: 'unknown-variable', detail: 'not in ENV_MANIFEST — nothing reads it'})
    }
  }

  return problems
}
