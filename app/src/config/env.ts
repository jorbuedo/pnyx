/**
 * The app's only reader of `process.env.EXPO_PUBLIC_*`.
 *
 * **Every read is written out literally, here, once.** Expo's bundler substitutes
 * `process.env.EXPO_PUBLIC_X` only for literal member expressions, so a parameterised lookup
 * (`process.env[name]`) compiles to `undefined` on device. That constraint is why this is a hand-
 * written table rather than a loop over {@link ENV_MANIFEST}, and why `no-raw-env.test.ts` guards it:
 * a second reader elsewhere is how the manifest drifts out of step with reality.
 *
 * **Required accessors throw; they do not default.** See `env-manifest.ts` for the four shipped bugs
 * that motivated it. The rule: if no single value is correct in every environment, there is no
 * default — the build declares it or the build is wrong. Throwing beats returning `null` here because
 * a missing *build-time* constant is not a runtime condition to degrade around; it cannot be fixed by
 * retrying, reconnecting, or asking the user.
 *
 * Accessors are functions, never module-level constants: a constant that throws would fail at import
 * time, taking down whatever imported it with a stack that names this module instead of the missing
 * variable. {@link assertEnvOrThrow} is the one deliberate early failure, called from the root layout
 * so a misconfigured build says so once, up front, instead of at the first feature that needs a URL.
 *
 * @module
 */

import {type AppEnv, ENV_MANIFEST, validateEnvVars} from './env-manifest'

/**
 * Raw values, keyed by name. The literal member expressions Expo needs.
 *
 * A **function**, not a captured constant: Expo substitutes each literal in place, so reading at call
 * time is equally inlined, and capturing once would freeze the values at import — which breaks tests
 * that set a variable before exercising a code path, and any tool that mutates the environment.
 *
 * Guarded with `typeof process` because this module is imported by tests and by the extension build,
 * where `process` may be absent; a throw here would be a crash at import.
 */
const rawEnv = (): Readonly<Record<string, string | undefined>> =>
  typeof process === 'undefined' || !process?.env
    ? {}
    : {
        EXPO_PUBLIC_SERVICE_URL: process.env.EXPO_PUBLIC_SERVICE_URL,
        EXPO_PUBLIC_PNYX_NETWORK: process.env.EXPO_PUBLIC_PNYX_NETWORK,
        EXPO_PUBLIC_ARTIFACTS_URL: process.env.EXPO_PUBLIC_ARTIFACTS_URL,
        EXPO_PUBLIC_REMOTE_CONFIG_URL: process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL,
        EXPO_PUBLIC_CARDANO_NETWORK: process.env.EXPO_PUBLIC_CARDANO_NETWORK,
        EXPO_PUBLIC_CARDANO_KOIOS_URL: process.env.EXPO_PUBLIC_CARDANO_KOIOS_URL,
        EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
        EXPO_PUBLIC_PNYX_INDEXER_URL: process.env.EXPO_PUBLIC_PNYX_INDEXER_URL,
        EXPO_PUBLIC_MIDNIGHT_DUST_DONATION_ADDRESS: process.env.EXPO_PUBLIC_MIDNIGHT_DUST_DONATION_ADDRESS,
        EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD: process.env.EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD,
        EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD_PROJECT_ID: process.env.EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD_PROJECT_ID,
        EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS: process.env.EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS,
        EXPO_PUBLIC_MIDNIGHT_PAYMENT_SHIELDED_TREASURY: process.env.EXPO_PUBLIC_MIDNIGHT_PAYMENT_SHIELDED_TREASURY,
        EXPO_PUBLIC_CARDANO_SCRIPT_VERIFICATION_URL: process.env.EXPO_PUBLIC_CARDANO_SCRIPT_VERIFICATION_URL,
        EXPO_PUBLIC_CARDANO_KOIOS_TOKEN: process.env.EXPO_PUBLIC_CARDANO_KOIOS_TOKEN,
        EXPO_PUBLIC_CARDANO_DATA_URL: process.env.EXPO_PUBLIC_CARDANO_DATA_URL,
        EXPO_PUBLIC_CARDANO_STEELSWAP_URL: process.env.EXPO_PUBLIC_CARDANO_STEELSWAP_URL,
        EXPO_PUBLIC_CARDANO_STEELSWAP_KEY: process.env.EXPO_PUBLIC_CARDANO_STEELSWAP_KEY,
        EXPO_PUBLIC_CARDANO_CEXPLORER_ICON_URL: process.env.EXPO_PUBLIC_CARDANO_CEXPLORER_ICON_URL,
        EXPO_PUBLIC_CARDANO_CEXPLORER_IMG_URL: process.env.EXPO_PUBLIC_CARDANO_CEXPLORER_IMG_URL,
        EXPO_PUBLIC_CARDANO_IPFS_GATEWAY: process.env.EXPO_PUBLIC_CARDANO_IPFS_GATEWAY,
        EXPO_PUBLIC_CARDANO_MEDIA_URL: process.env.EXPO_PUBLIC_CARDANO_MEDIA_URL,
        EXPO_PUBLIC_KRAKEN_URL: process.env.EXPO_PUBLIC_KRAKEN_URL,
        EXPO_PUBLIC_DEEP_ADA_HISTORY_URL: process.env.EXPO_PUBLIC_DEEP_ADA_HISTORY_URL,
        EXPO_PUBLIC_INSECURE_DEV_VAULT: process.env.EXPO_PUBLIC_INSECURE_DEV_VAULT,
        EXPO_PUBLIC_DEV_LOG_STREAM: process.env.EXPO_PUBLIC_DEV_LOG_STREAM,
        EXPO_PUBLIC_DEV_LOG_STREAM_HOST: process.env.EXPO_PUBLIC_DEV_LOG_STREAM_HOST,
        EXPO_PUBLIC_TREZOR_TRACE: process.env.EXPO_PUBLIC_TREZOR_TRACE,
        EXPO_PUBLIC_E2E_AUTO_RESTORE: process.env.EXPO_PUBLIC_E2E_AUTO_RESTORE,
        EXPO_PUBLIC_E2E_MNEMONIC: process.env.EXPO_PUBLIC_E2E_MNEMONIC,
        EXPO_PUBLIC_E2E_WALLET_NAME: process.env.EXPO_PUBLIC_E2E_WALLET_NAME,
      }

/** The names this module reads, for the drift guard to compare against the manifest. */
export const READ_ENV_NAMES: readonly string[] = Object.keys(rawEnv())

export class MissingEnvError extends Error {
  constructor(readonly name: string) {
    super(
      `${name} is not set. It is required in every build variant — set it in env/.env.<variant> ` +
        `(and your local .env for dev). Run \`bun run env:check\` to see everything that is missing. ` +
        `There is deliberately no default: no single value is correct in every environment.`,
    )
    this.name = 'MissingEnvError'
  }
}

/** A required value, or a throw naming the variable. Trailing slashes trimmed — URLs are joined. */
const required = (name: string): string => {
  const value = rawEnv()[name]?.trim()
  if (value === undefined || value === '') throw new MissingEnvError(name)
  return value.replace(/\/+$/, '')
}

/** An optional value, or `undefined`. Never a substituted default — the caller owns that decision. */
const optional = (name: string): string | undefined => {
  const value = rawEnv()[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

// --- Required ---

export const serviceUrl = (): string => required('EXPO_PUBLIC_SERVICE_URL')
export const pnyxNetwork = (): string => required('EXPO_PUBLIC_PNYX_NETWORK')
export const artifactsUrl = (): string => required('EXPO_PUBLIC_ARTIFACTS_URL')

// --- Optional: absence is a handled state, documented per entry in the manifest. ---

/**
 * Overrides for things the **user** controls at runtime, so neither can be required: the app is
 * mainnet-capable and the network is a Settings choice, and one endpoint value cannot serve a network
 * the user switches. Their in-code defaults are product decisions, not inferred configuration.
 */
export const cardanoNetworkOverride = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_NETWORK')
export const cardanoKoiosUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_KOIOS_URL')

/**
 * The deployed PaymentContract, 64 hex — the only issuer of the permit a handle costs.
 *
 * Absent means **handles are unavailable on this build**, which is a real composition: a deployment can
 * have identities and no namespace. The storefront says so rather than offering a claim that cannot
 * land.
 *
 * ⚠️ It also seals every handle contract, so a handle claimed against one payment address is
 * unreachable from a build configured with another. Changing this abandons every name claimed under
 * the old one.
 */
export const midnightPaymentAddress = (): string | undefined => optional('EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS')

/**
 * The payment contract's shielded treasury, as a whole `mn_shield-addr`.
 *
 * ⚠️ **The contract cannot carry this and that is the point.** Its sealed `shieldedTreasury` field is
 * a `ZswapCoinPublicKey`, which is the *spending* half of a shielded address. The encryption half —
 * the other 32 bytes — is what a payer needs to attach a coin ciphertext, and without it the coin
 * forwarded to the treasury can never be found by scanning. It is public key material, so publishing
 * it in an env file costs nothing.
 */
export const midnightPaymentShieldedTreasury = (): string | undefined =>
  optional('EXPO_PUBLIC_MIDNIGHT_PAYMENT_SHIELDED_TREASURY')

export const sentryDsn = (): string | undefined => optional('EXPO_PUBLIC_SENTRY_DSN')
export const pnyxIndexerUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_PNYX_INDEXER_URL')
/**
 * The preprod indexer URL.
 *
 * ⚠️ Separate from {@link pnyxIndexerUrlOverride}, which applies only to the *declared identity
 * network*: this one names preprod specifically, because preprod is the network whose public indexer
 * is gone and whose replacement needs a key. See `services/midnight/networks.ts`.
 *
 * The credential belongs in {@link preprodIndexerProjectId}, not in here. A key left in this URL's
 * query string is still accepted and split off (`services/midnight/indexer-auth.ts`) so no local env
 * file has to be migrated.
 */
export const preprodIndexerOverride = (): string | undefined => optional('EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD')
/**
 * Blockfrost's `project_id` for {@link preprodIndexerOverride}, sent as a header.
 *
 * ⚠️ Still bundled into any build that reads it, so a key here is public to that build's users — the
 * durable answer is a proxy holding the token server-side. What this variable buys is that the key
 * stops travelling *inside a URL*, which is what reached logs and connected dApps.
 */
export const preprodIndexerProjectId = (): string | undefined =>
  optional('EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD_PROJECT_ID')
export const dustDonationAddress = (): string | undefined => optional('EXPO_PUBLIC_MIDNIGHT_DUST_DONATION_ADDRESS')
export const cardanoKoiosToken = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_KOIOS_TOKEN')

/**
 * The CIP-171 verification registry the review screen asks about a contract's provenance.
 *
 * Absent means the feature is **off**, and off is not the same as "unverified": with no registry
 * configured the review makes no provenance claim at all. Saying "unverified" for a question
 * nobody asked would read as a finding about the contract.
 */
export const cardanoScriptVerificationUrl = (): string | undefined =>
  optional('EXPO_PUBLIC_CARDANO_SCRIPT_VERIFICATION_URL')
export const cardanoDataUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_DATA_URL')
export const steelswapUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_STEELSWAP_URL')
/**
 * The Pnyx **partner** API key, which is what attributes a swap's fee to us.
 *
 * SteelSwap derives the fee channel from the authenticated principal and never from a request
 * field, so without this the per-install CIP-8 key makes every user their own `self_serve` partner
 * and the swap earns Pnyx nothing. Absent means exactly that fallback, which is the correct state
 * for a build that has no key rather than a reason to refuse the feature.
 *
 * ⚠️ Inlined into the bundle like every `EXPO_PUBLIC_*`, i.e. extractable. That is the accepted
 * trade of the embed-now decision, and the reason the base URL is steerable from the control plane:
 * pointing it at a proxy that holds the key server-side retires this variable without an app
 * release. Never commit a value — the tracked `env/.env.*` files must not carry it.
 */
export const steelswapPartnerKey = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_STEELSWAP_KEY')
export const cexplorerIconUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_CEXPLORER_ICON_URL')
export const cexplorerImgUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_CARDANO_CEXPLORER_IMG_URL')
/**
 * First-party asset-media host override (`https://…/{fingerprint}/256.webp`).
 *
 * Falls back to the in-code constant, like the other icon CDNs — this is a redirect for a different
 * deployment, not a feature switch. Trailing slashes stripped: the path is joined as
 * `${host}/${fingerprint}/256.webp`, so one would yield `//`.
 */
export const cardanoMediaUrlOverride = (): string | undefined =>
  optional('EXPO_PUBLIC_CARDANO_MEDIA_URL')?.replace(/\/+$/, '')
/** Trailing slashes stripped: this is joined as `${gateway}/${cid}`, so one would yield `//`. */
export const ipfsGatewayOverride = (): string | undefined =>
  optional('EXPO_PUBLIC_CARDANO_IPFS_GATEWAY')?.replace(/\/+$/, '')
export const krakenUrlOverride = (): string | undefined => optional('EXPO_PUBLIC_KRAKEN_URL')
/** Kept raw: the literal `"off"` is a meaningful value here, not an absence. */
export const deepAdaHistoryRaw = (): string | undefined => rawEnv().EXPO_PUBLIC_DEEP_ADA_HISTORY_URL
export const insecureDevVaultRequested = (): boolean => optional('EXPO_PUBLIC_INSECURE_DEV_VAULT') === '1'
export const devLogStreamRequested = (): boolean => optional('EXPO_PUBLIC_DEV_LOG_STREAM') === '1'
export const devLogStreamHost = (): string | undefined => optional('EXPO_PUBLIC_DEV_LOG_STREAM_HOST')
export const e2eAutoRestore = (): string | undefined => optional('EXPO_PUBLIC_E2E_AUTO_RESTORE')
export const e2eMnemonic = (): string | undefined => optional('EXPO_PUBLIC_E2E_MNEMONIC')
export const e2eWalletName = (): string | undefined => optional('EXPO_PUBLIC_E2E_WALLET_NAME')

/**
 * Validate the whole embedded environment at once, for the root layout.
 *
 * `appEnv` comes from the running build's own config rather than from an `EXPO_PUBLIC_*` variable, so
 * a build cannot claim to be a variant it was not built as.
 *
 * Throws with every problem listed. This is the deliberate early failure: a build missing a required
 * URL is broken in ways that are much harder to read once features start failing individually —
 * `bun run env:check` should have caught it, and if it did not, this says so on the first screen.
 */
export const assertEnvOrThrow = (appEnv: AppEnv): void => {
  const problems = validateEnvVars(appEnv, rawEnv())
  // `unknown-variable` cannot occur here — RAW's keys are exactly the manifest's — but filtering
  // rather than asserting keeps this honest if the two ever diverge.
  const real = problems.filter((problem) => problem.reason !== 'unknown-variable')
  if (real.length === 0) return
  throw new Error(
    `This build's environment is incomplete (--env=${appEnv}):\n` +
      real.map((problem) => `  ${problem.name}: ${problem.detail}`).join('\n') +
      `\n\nDeclared in src/config/env-manifest.ts (${ENV_MANIFEST.length} variables). ` +
      `Fix env/.env.<variant> and rebuild; \`bun run env:check\` reports the same list.`,
  )
}
