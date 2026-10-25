# @pnyx/config

Runtime configuration for the wallet. Three concerns, no more:

1. **CAIP-2 chain identifiers** — the `ChainId` union and its named constants, shared by `@pnyx/wallet`, `@pnyx/hardware`, and the app.
2. **Feature flags** — a 5-layer evaluation system with percentage rollouts and build-number targeting.
3. **Remote config** — the `{env}.json` file the app fetches at boot.

There is no white-label / branding / theming config here. The app is single-brand and its theme lives in `app/src/theme/`.

## Chain identifiers

```typescript
import {CARDANO_MAINNET, type ChainId, getChainNamespace} from '@pnyx/config'

const chain: ChainId = CARDANO_MAINNET
getChainNamespace('eip155:8453') // 'eip155'
```

`ChainId` is a plain string-literal union (CAIP-2 `namespace:reference`). Prefer the named constants at call sites — the hex-encoded `bip122:` references are unmemorable. To add a chain, add the literal to the union in `types.ts` and export a constant next to it; never repurpose an existing entry for a testnet.

`getChainNamespace` exists because chains sharing a namespace share an HD derivation subtree, so `xpub-store` keys on namespace rather than on the full chain id.

### Cardano chain ids

`cardano-chain-id.ts` handles the Cardano-specific conversions, including the CIP-34 aliases (`cip34:1-764824073`) a x402 facilitator must treat as equivalent:

| Function | Description |
|---|---|
| `cardanoChainId(network)` | `'mainnet'` → `'cardano:mainnet'` |
| `cardanoNetworkOf(chainId)` | the inverse |
| `normalizeCardanoChainId(value)` | accepts either form, returns the canonical `cardano:*` or `null` |
| `chainIdFromCip34(value)` / `cip34Of(chainId)` | CIP-34 alias conversion |
| `isCardanoChainId(value)` | type guard |
| `CARDANO_PROTOCOL_MAGIC` | per-network protocol magic |

## Feature flags

### Flag ids

Every flag must have a real gate in the app. A flag with no consumer is dead config — delete it rather than leaving it toggleable.

| Flag | Code default | Gates |
|---|---|---|
| `addWallet` | `true` | Add-wallet entry points (Wallets screen, wallet selection) |
| `createWallet` | `true` | Create-wallet onboarding path |
| `restoreWallet` | `true` | Restore-wallet onboarding path |
| `dappConnector` | `true` | dApp connector availability |
| `discover` | `true` | Browser discover grid |
| `pushNotifications` | `false` (mobile: `true`) | Push init, permission notice, Menu row |
| `portfolioChart` | `false` | Portfolio + token-detail charts and sparklines. Real data: balances from the local tx store anchored to current on-chain balances, ADA→fiat from Kraken, token→ADA from SteelSwap OHLCV (`useCardanoPortfolioHistory`) |
| `devTools` | `false` | Settings → Dev Tools (5-tap unlock) |
| `encryptedBackupExport` | `false` | "Encrypted backup" affordance on the recovery-phrase screen (the deeplink consumer side is always on) |

### Flag values

```typescript
type FeatureFlagValue =
  | boolean
  | {
      enabled: boolean
      rolloutPercentage?: number // 0-100, needs an installation id
      minBuildNumber?: number    // inclusive, iOS CFBundleVersion / Android versionCode
      maxBuildNumber?: number    // inclusive
    }
```

When the running build number falls outside `[minBuildNumber, maxBuildNumber]`, that layer is treated as undefined and evaluation falls through to the next lower layer. So a remote `{enabled: true, minBuildNumber: 42}` over a `false` code default means "on for build 42+, off for older builds" — a rollback without a rebuild. `buildNumber <= 0` (Expo Go / dev) fails open: the gate does not suppress the layer.

### 5-layer precedence

Highest priority first:

| Layer | Source | Description |
|---|---|---|
| 1 | `runtime` | Dev Tools overrides (persisted to storage, optional expiry) |
| 2 | `remote` | `features` block from remote config |
| 3 | `environment` | `development` vs `production` |
| 4 | `platform` | `mobile` / `web` / `extension` |
| 5 | `code` | `CODE_DEFAULTS` — the app's shipped feature set |

```typescript
import {evaluateFeatureFlag} from '@pnyx/config'

evaluateFeatureFlag('discover', {
  platform: 'mobile',
  environment: 'production',
  installationId: 'device-uuid',
  buildNumber: 42,
  runtimeOverrides: [],
  remoteConfig: undefined,
})
// { flagId: 'discover', enabled: true, source: 'code', evaluatedAt: 1706000000000 }
```

`preview` maps to `environment: 'production'` in the app — using `development` there would blanket-enable everything and defeat the point of that build.

### Percentage rollouts

`rolloutPercentage` buckets users 0-99 via a deterministic DJB2 hash of `flagId:installationId`. The same user always gets the same answer for a given flag, and different flags get independent populations.

```jsonc
// remote config, week 1 → 10% of users
{"features": {"portfolioChart": {"enabled": true, "rolloutPercentage": 10}}}
// full rollout
{"features": {"portfolioChart": true}}
```

### Service (Effect)

```typescript
const service = yield* createFeatureFlagsService({
  platform: 'mobile',
  environment: 'production',
  installationId: 'device-uuid',
  buildNumber: 42,
  storage,
})

yield* service.isEnabled('discover')
yield* service.evaluate('discover')          // { flagId, enabled, source, evaluatedAt }
yield* service.setRuntimeOverride('devTools', true)
yield* service.clearRuntimeOverride('devTools')
yield* service.updateRemoteConfig(remoteFeatureFlags)
yield* service.getAuditTrail()               // last 100 evaluations
const unsub = yield* service.subscribe('discover', (flagId, enabled) => {})
```

| Export | Description |
|---|---|
| `evaluateFeatureFlag(flagId, context)` | Evaluate through all 5 layers |
| `resolveFeatureFlagValue(value, installationId, flagId)` | Resolve one value to a boolean (handles rollout) |
| `valueAppliesToBuildNumber(value, buildNumber)` | Build-number gate for one layer's value |
| `cleanExpiredOverrides(overrides)` | Drop expired runtime overrides |
| `createFeatureFlagsService(options)` / `createFeatureFlagsServiceLayer(options)` | Effect service / Layer |
| `CODE_DEFAULTS`, `PLATFORM_OVERRIDES`, `ENVIRONMENT_OVERRIDES` | The static layers |

The app consumes flags through `useFeatureFlag(flagId)` / `useFeatureFlagEvaluation(flagId)` (`app/src/hooks/useFeatureFlag.ts`), and the Dev Tools flag board derives its list from `FLAG_SECTIONS` in `app/app/settings/dev/feature-flags.tsx` — a `Record<FeatureFlagId, string>`, so adding a flag id without a section is a type error.

## Remote config

One JSON file per build environment, served straight from an R2 bucket. Operational detail (bucket, publishing playbook, the mandatory `--remote` wrangler flag) is in [`docs/remote-config.md`](../../docs/remote-config.md).

```typescript
import {fetchRemoteConfig, getRemoteConfigUrl} from '@pnyx/config'

const url = getRemoteConfigUrl({env: 'prod'})       // "<EXPO_PUBLIC_REMOTE_CONFIG_URL>/prod.json"
const config = await Effect.runPromise(fetchRemoteConfig(url))
```

The base URL comes from `EXPO_PUBLIC_REMOTE_CONFIG_URL`, falling back to `http://localhost:8790` for local development. `getRemoteConfigUrl()` with no arguments defaults to `prod` — a misconfigured caller must not silently point a production build at dev data.

### Schema

Every field is optional and `fetchRemoteConfig` is a plain JSON cast, not a validated decode. Unknown fields are ignored; missing fields fall back to the app's code defaults; `{}` is a valid file.

```typescript
type RemoteConfig = {
  banners?: RemoteBanner[]
  dapps?: {
    banned?: string[]
    recommended?: Array<{
      id: string; name: string; description: string; category: string
      logo: string; uri: string; origins: string[]; isSingleAddress?: boolean
    }>
    filters?: Record<string, string[]>
  }
  features?: Partial<Record<FeatureFlagId, FeatureFlagValue>>
  maintenance?: Partial<Record<string, boolean>>   // feature name or chain id → in maintenance
  allowedLinks?: Partial<Record<string, string>>   // push-notification deep-link allowlist
}
```

| Field | Getter | Consumed by |
|---|---|---|
| `dapps` | `getRemoteDapps` | `BrowserStartPage` discover grid, dApp connector gating |
| `features` | `getRemoteFeatureFlags` | the `remote` flag layer, via `service.updateRemoteConfig` |
| `maintenance` | `getMaintenanceFlags` | `MaintenanceTakeover` (`maintenance.app`) |
| `allowedLinks` | `getAllowedLinks` | `services/allowed-links.ts` → notification navigation |
| `banners` | `getBanners(config, platform)` | date-filtered, priority-sorted, platform-overridden banner list |

`getRemoteConfigAssetUrl(path)` builds URLs for assets stored alongside the JSON (banner markdown lives at `banners/content/<id>/<locale>.md`).

Adding a field takes an app release: the fetch is a cast, so the app only uses fields it has a getter and a consumer for. Add both, ship, *then* publish the value.

`ConfigLoadError` is the only error type — a failed fetch or a non-2xx response. The app tolerates it and falls back to its cached copy or code defaults.

## File structure

```
packages/config/
  index.ts                        # Public exports
  types.ts                        # ChainId union, named constants, ChainNamespace
  cardano-chain-id.ts             # Cardano CAIP-2 / CIP-34 conversions
  remote-config.ts                # RemoteConfig shape, fetching, getters, ConfigLoadError
  feature-flags.ts                # Flag ids, values, evaluation and audit types
  feature-flags-defaults.ts       # Code, platform, and environment layers
  feature-flags-evaluation.ts     # 5-layer evaluation + rollout hashing
  feature-flag-build-number.ts    # Build-number gate for a layer's value
  feature-flags-service.ts        # Effect service for reactive flag management
```

## Testing

```bash
bun run vitest run packages/config/
```
