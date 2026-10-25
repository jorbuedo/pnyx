# Runtime Context Reference

How to query every runtime dimension from a component: environment, platform, network, chains, feature flags, and remote config.

---

## Quick reference

```ts
// ── Build-time ──────────────────────────────────────────────────
__DEV__                                          // true in Metro dev builds (all platforms)
Constants.expoConfig?.extra?.brandId             // 'pnyx'
Constants.expoConfig?.extra?.isDevelopment       // boolean → drives environment layer

// ── Platform ────────────────────────────────────────────────────
import {isNative, isExtension, isExtensionPopup,
        isExtensionFullscreen, isExtensionSidePanel,
        isExtensionDevIframe} from '../platform'
Platform.OS                                      // 'ios' | 'android' | 'web'

// ── Network + chains ────────────────────────────────────────────
const {network, isChainEnabled, enabledChains,
       allChains, evmNetwork} = useConfig()

// ── Feature flags (sync, reactive) ───────────────────────────────
const discoverEnabled = useFeatureFlag('discover')

// ── Remote config (sync, reactive) ───────────────────────────────
const {dapps, maintenance, banners, allowedLinks} = useRemoteConfig()

// ── Auth ────────────────────────────────────────────────────────
const {isPinEnabled, passwordAuth, isEnabled: isBiometricEnabled} = useAuth()
```

---

## Environments

Two values, determined at build time from `Constants.expoConfig?.extra?.isDevelopment`:

| ID | Condition | Remote config | `devTools` default |
|---|---|---|---|
| `development` | `isDevelopment === true` | `dev.json` — all flags on | ✅ always enabled |
| `production` | default | `prod.json` — selective | ❌ requires 5-tap |

The environment is not exposed as a string in `useConfig()`. Use `__DEV__` for build-time guards, or rely on feature flag behavior for runtime differences.

---

## Platforms

### Detection

All constants are module-level (not hooks) — safe to use anywhere:

```ts
import {
  isNative,             // iOS or Android
  isExtension,          // any extension context (prod or dev iframe)
  isExtensionPopup,     // extension + narrow (<768px) + not sidepanel
  isExtensionFullscreen,// extension + ?fullscreen=true
  isExtensionSidePanel, // extension + ?sidepanel=true
  isExtensionDevIframe, // dev mode iframe inside popup.html
} from '../platform'

import {Platform} from 'react-native'
// Platform.OS: 'ios' | 'android' | 'web'
```

### Platform matrix

| Constant | iOS | Android | Web browser | Ext popup | Ext fullscreen | Ext sidepanel |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `isNative` | ✅ | ✅ | | | | |
| `isExtension` | | | | ✅ | ✅ | ✅ |
| `isExtensionPopup` | | | | ✅ | | |
| `isExtensionFullscreen` | | | | | ✅ | |
| `isExtensionSidePanel` | | | | | | ✅ |
| `Platform.OS === 'web'` | | | ✅ | ✅ | ✅ | ✅ |
| `__DEV__` | dev | dev | dev | dev | dev | dev |

### Extension display modes (user-configurable)

```ts
import {getDisplayMode, setDisplayMode, type DisplayMode} from '../platform'
// DisplayMode: 'side-panel' | 'popup' | 'windowed'

const mode = await getDisplayMode()    // reads from background script
await setDisplayMode('windowed')       // persists + reconfigures Chrome APIs
```

### Platform ID used by feature flags layer

```ts
type PlatformId = 'mobile' | 'web' | 'extension'
// Determined once in ConfigProvider via detectPlatform():
//   iOS/Android → 'mobile'
//   web + isExtension → 'extension'
//   web → 'web'
```

---

## Networks

One global Cardano network for all wallets, plus a separate EVM network:

```ts
type Network = 'mainnet' | 'preprod' | 'preview'   // @pnyx/wallet

const {network, setNetwork, isNetworkLoading} = useConfig()
```

There is one global Cardano network and no separate EVM network knob. The build-time
default comes from `EXPO_PUBLIC_CARDANO_NETWORK` (`DEFAULT_NETWORK` in
`src/config/networks.ts`); the user's stored choice wins once loaded.

`setNetwork` persists to storage and triggers a full `WalletProvider` remount via `key={network}` in `_layout.tsx`.

**What that remount must not reach.** The key sits below `PnyxSessionProvider` / `RealtimeProvider`, so
the content-service session survives a switch: its network is the *identity* one from `/auth/config`
(`EXPO_PUBLIC_PNYX_NETWORK`), not the funds network, and the JWT is memory-only — remounting the
provider would have thrown away a valid token and re-read the identity seed to mint the same one.
`AuthProvider` is inside the key and does remount, so it seeds `isUnlocked` from the process-wide
mirror (`initialSessionUnlocked`) instead of `false`; a real lock clears that mirror, so a lock still
leaves the next mount locked. The DUST key book is read once per unlock, not once per mount
(`restoreDustKeyBook` returns early when `isSyncKeyBookRestored()`). Together these are why a funds-network
switch costs no biometric prompt — before them it cost one for the lock, one for the sign-in and one for
the key book.

⚠️ **The key book is keyed `(groupId, accountIndex, network)`, and one refresh fills every network.**
It used to be keyed by group and account alone, with the network only a field on the value — so a
wallet held one network's DUST key at a time, and since the book is written from that cache, deriving
a key on one network overwrote the other network's stored entry. The scheduler then correctly refused
the foreign-network key, nothing could re-derive one (that needs the seed, and a scheduled tick may
not raise a prompt), and the app rendered "no DUST" — indistinguishable from a wallet that has none,
until the user refreshed by hand. `rememberSyncKeys` now derives every network in
`knownMidnightNetworks()` plus the caller's own from the single prompt: the DUST role key has no
network in its derivation path, so they share one key and differ only in the `mn_dust…` address.

### Preprod faucet

For funding test addresses on **preprod**, use Midnight's official faucet:

```
https://faucet.preprod.midnight.network/
```

This replaced the Nethermind-hosted stand-in (`https://midnight-tmnight-preprod.nethermind.dev/`), which was used while the official faucet was broken and is now closed. Note it applies to **preprod**; preview has its own at `https://faucet.preview.midnight.network/`.

---

## Blockchains

### Chain IDs

CAIP-2 strings (`namespace:reference`) from `@pnyx/config`. Use the named constants,
not raw literals:

```ts
import {CARDANO_MAINNET, ETHEREUM_MAINNET, MIDNIGHT_MAINNET, type ChainId} from '@pnyx/config'
// 'cardano:mainnet' | 'cardano:preprod' | 'cardano:preview'
// 'bip122:…' (bitcoin, bitcoin cash, litecoin, dogecoin)
// 'eip155:<id>' (ethereum, polygon, arbitrum, optimism, avalanche, bnb, base, …)
// 'solana:…' | 'tron:mainnet' | 'xrpl:mainnet' | 'midnight:mainnet'
```

See `packages/config/README.md` for the full list and the Cardano CIP-34 conversions.

### Checking chains in components

The chain roster is **hardcoded** — there is no user-facing chain enable/disable, so no
`toggleChain` / chain-preference storage:

```ts
const {enabledChains} = useConfig()   // FUNDS_CHAINS from src/services/chains.ts
```

Today that is `[CARDANO_MAINNET]`. Midnight is the identity chain and is handled by the
identity vault slot, not by this roster.

---

## Feature Flags

### All 10 flags

Every flag has a real gate in the app; the source of truth is `FeatureFlagId` in
`packages/config/feature-flags.ts`.

```ts
type FeatureFlagId =
  | 'addWallet'             // add-wallet entry points
  | 'createWallet'          // create-wallet onboarding path
  | 'restoreWallet'         // restore-wallet onboarding path
  | 'dappConnector'         // DApp browser + CIP-30 provider injection
  | 'discover'              // browser discover grid
  | 'pushNotifications'     // native push (mobile-only)
  | 'portfolioChart'        // portfolio / token-detail charts + sparklines
  | 'devTools'              // dev tools visibility (logger, flags, playground)
  | 'encryptedBackupExport' // "Encrypted backup" affordance on recovery-phrase
  | 'deviceProving'         // Phase-B on-device proving for forum actions
```

### 5-layer precedence (highest wins)

```
5. Runtime override   ← dev mode 5-tap toggle, persisted to storage
4. Remote config      ← {env}.json `features` block from EXPO_PUBLIC_REMOTE_CONFIG_URL (5-min cache)
3. Environment        ← development vs production
2. Platform           ← mobile / web / extension
1. Code defaults      ← CODE_DEFAULTS
```

There is no brand layer — the brand system was removed and the app is single-brand.
`preview` builds evaluate as `production`.

### Code defaults

| Flag | production | development |
|---|:---:|:---:|
| `addWallet` | ✅ | ✅ |
| `createWallet` | ✅ | ✅ |
| `restoreWallet` | ✅ | ✅ |
| `dappConnector` | ✅ | ✅ |
| `discover` | ✅ | ✅ |
| `pushNotifications` | ✅ mobile / ❌ web | ✅ mobile / ❌ web |
| `portfolioChart` | ❌ | ✅ |
| `devTools` | ❌ (5-tap only) | ✅ |
| `encryptedBackupExport` | ❌ | ✅ |
| `deviceProving` | ❌ | ✅ |

The live remote-config files currently publish **no** `features` block, so these code and
platform/environment values are the effective state in every environment.

### Checking flags in components

Use the hook — don't hand-roll the Effect dance:

```ts
import {useFeatureFlag} from '../hooks/useFeatureFlag'

function DiscoverGrid() {
  const discoverEnabled = useFeatureFlag('discover')
  if (!discoverEnabled) return <ComingSoonScreen />
  return <DiscoverTiles />
}
```

It returns `false` while the service initializes, and re-renders on remote/runtime changes.

For the layer that decided the value (used by the Dev Tools flag board):

```ts
const {enabled, source, loading} = useFeatureFlagEvaluation('discover')
// source: 'runtime' | 'remote' | 'environment' | 'platform' | 'code'
```

### Runtime overrides (dev mode)

```ts
await Effect.runPromise(featureFlagsService.setRuntimeOverride('portfolioChart', true))
await Effect.runPromise(featureFlagsService.clearRuntimeOverride('portfolioChart'))
await Effect.runPromise(featureFlagsService.clearAllRuntimeOverrides())

// The DevModeToggle component (5-tap) calls setRuntimeOverride('devTools', ...)
```

Remote-config values can also be scoped to a build-number range
(`minBuildNumber` / `maxBuildNumber`) — see `packages/config/README.md`.

---

## Remote Config

Fetched on launch (stale-while-revalidate, 5-minute window, cached under
`@pnyx/remote-config-cache`). Provides the remote layer of feature flags plus the dApp
discovery list, maintenance flags, banners, and the push deep-link allowlist. Full
schema and publishing playbook: [`docs/remote-config.md`](remote-config.md).

```ts
const {
  remoteConfig,     // RemoteConfig | undefined (raw)
  isLoading,
  dapps,            // RemoteDappConfig — recommended/banned DApps
  maintenance,      // Partial<Record<string, boolean>> — feature/chain → in maintenance
  banners,          // RemoteBanner[] — date-filtered, priority-sorted
  allowedLinks,     // Partial<Record<string, string>> — push deep-link allowlist
} = useRemoteConfig()
```

### DApps

```ts
dapps?.recommended  // { id, name, description, category, logo, uri, origins, isSingleAddress? }[]
dapps?.banned       // string[] of banned origin domains
dapps?.filters      // Record<string, string[]>
```

`dapps.recommended` is the **only** source of discover tiles — there is no built-in
fallback list (`DEFAULT_DISCOVER_DAPPS` is empty by design, so a hardcoded tile can't
outlive what it pointed at). Before the remote list loads, or if it's unreachable,
`BrowserStartPage` renders the hint copy with no grid.

---

## Dev Tools

All guarded by the `devTools` flag. Auto-enabled in dev builds; 5-tap on Settings > About to unlock in production.

| Tool | How to access | Guard |
|---|---|---|
| **Logger screen** | Settings › Developer › System Logs (`settings/dev/logs`) | `devTools` flag |
| **Feature flags panel** | Settings › Developer › Feature Flags (`settings/dev/feature-flags`) | `devTools` flag |
| **Developer settings index** | Settings › Developer (`settings/dev/`) | `devTools` flag |
| **UI Playground** | `ui-playground` route | `devTools` flag |
| **DevModeToggle** | 5-tap on About section — toggles `devTools` runtime override | — |
| **DevLogsOverlay** | Floating "LOG" button, bottom-right of every screen | `__DEV__` only |
| **Skip auth button** | Top-right of PIN lock screen and extension login | `__DEV__` only |

### Enabling dev mode in a production build

1. Open Settings › About
2. Tap the about section **5 times within 2 seconds**
3. Alert confirms "Dev Mode Enabled"
4. Developer section appears in Settings

---

## Related documentation

- [`packages/config/README.md`](../packages/config/README.md) — `@pnyx/config` package API reference
