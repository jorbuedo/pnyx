# Pnyx Wallet App

Mobile app (iOS + Android via Expo/React Native) for Pnyx — a privacy-preserving governance forum on Midnight. A Midnight-only wallet shell dedicated to identity, not funds.

## Configuration

The app is a single product (Pnyx); there is no multi-brand selection. Native
identity (app IDs, scheme, name, colors) lives inline in `app.config.js`, and
`eas.json` is committed directly.

Environment variants live in `env/.env.<variant>` (tracked), and are consumed two
different ways:

- **`dev`** — `ensureEnv()` copies `env/.env.development` to a local, gitignored
  `.env` the first time you build, and never touches it again. That file is yours
  to tune (local service, insecure dev vault); Expo's own dotenv loads it.
- **`preview` / `prod`** — `appEnvFileVars()` loads `env/.env.<variant>` into the
  build's process env (`build.ts`, `build-preview.ts`), *below* an explicit shell
  override and *above* your `.env`. Without this a release artifact inherited
  whatever a developer's `.env` happened to say, which is how a preview APK
  shipped pointing at the `10.0.2.2` dev loopback.
- **EAS** — never reads `env/`; `.env` is gitignored, so anything a build needs
  is duplicated in that profile's `env` block in `eas.json`. Keep the two in sync.

The build-variant axis (`PNYX_BUILD_VARIANT`: `dev`/`devclient`/`prod`)
controls app-ID suffixing and app name so variants coexist on a device.

### LAN preview — a release build against the service on your machine

A preview APK is a *release* build, so Android blocks plain `http://` outright:
`usesCleartextTraffic` exists only in the `debug`/`debugOptimized` manifests. Pointing one at
`http://192.168.x.x:3300` therefore fails inside the app before any packet leaves the phone, which
reads as "the service is down".

One knob handles both halves:

```bash
PNYX_LAN_HOST=<your-lan-ip> bun scripts/build-preview.ts android
```

It derives `EXPO_PUBLIC_SERVICE_URL=http://<your-lan-ip>:3300` and adds a network-security config
permitting cleartext **for that host only** — the base policy still forbids it, so nothing else in
the app gains plaintext permission (`plugins/with-lan-cleartext.js`). Unset, neither happens and the
platform default applies, so production can never inherit it.

Phone and machine must be on the same LAN, and the service must bind beyond loopback.
⚠️ Android only — iOS ATS needs `NSAllowsLocalNetworking`, which is not implemented.

## Development

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Expo CLI](https://docs.expo.dev/get-started/installation/)
- For iOS: macOS with Xcode
- For Android: Android Studio with SDK

### USB Development

```bash
bun run android   # Android via USB
bun run ios       # iOS via USB (Mac only)
```

These run `npx expo run:android/ios` which builds and launches on your connected device.

### Physical Device Development (QR Code Workflow)

For testing on physical devices over WiFi with hot reload:

**One-time setup:**

1. Build the development APK: `bun run dev:build:android`
2. Serve the APK for download: `bun run dev:serve`
3. Scan the QR code with your Android phone's camera, download, install

**Daily development:**

1. Start the metro dev server: `bun run dev`
2. Open the development app on your phone and scan the connection QR code
3. Code changes hot reload automatically

**Important notes:**
- DevClient builds use the `.devclient` app ID suffix (base app ID: `uk.pxkq.pnyx`)
- Can coexist with production, standalone dev (`.dev`), and preview builds
- Requires the metro server running — this is a thin client that connects to your dev machine
- Your phone and dev machine must be on the same WiFi network
- Rebuild the APK only when dependencies change (native modules, expo config)

Notes for agents:
- `bun run dev` lives in `app/package.json`, not root — run it from `app`.
- `ensureEnv` only writes `.env` when it is **missing**, so `bun run dev` will not clobber an env you just set.
- One-time only: if no DevClient is installed, build it first (`bun run dev:build:ios` / `dev:build:android`).

### Preview build (standalone APK, no Metro)

A **release** APK with the JS bundle embedded — runs on its own, no dev server. Use it for sharing a build to test on a device without a Metro connection (no Expo/EAS setup required).

1. Build it: `bun run preview:build:android` → `dist/pnyx-preview.apk` (prod app identity, `preview` runtime tag; runs `expo prebuild` + `gradle assembleRelease`).
2. Serve it to the phone: `bun run preview:serve` (QR download over LAN, like `dev:serve` but targets `pnyx-preview.apk`).
3. Scan, install (allow "unknown sources"), open — no Metro needed.

Notes:
- Since the JS is embedded, the APK does **not** hot-reload and does **not** stream logs to the perf MCP — rebuild to pick up code changes.
- iOS preview archives go through `bun scripts/build.ts ios --env=preview`.

### Web Development

```bash
bun run web
```

Opens the app in your browser at `http://localhost:8081` (dev convenience only — web is not a shipping target).

## Building

### Build Variants

The project uses an explicit `--env` flag (or `PNYX_BUILD_VARIANT` env var) to select the build environment. The default is always `dev` — an unspecified build never silently produces a production artifact.

| Variant | `--env` value | App ID suffix | App name suffix | Metro required |
|---------|---------------|---------------|-----------------|----------------|
| Development | `dev` *(default)* | `.dev` | ` Dev` | No |
| Dev Client | `devclient` | `.devclient` | ` DevClient` | Yes |
| Preview | `preview` *(QA prod-shaped)* | *(none)* | *(none)* | No |
| Production | `prod` | *(none)* | *(none)* | No |

**What the variant controls:**
- **App ID / package name suffix** — variants install alongside production without conflicting
- **App display name suffix** — makes it easy to identify which variant is installed
- **Firebase config** — `dev`/`devclient` use the dev config; `preview`/`prod` use the production config (preview ships with `buildVariant='prod'` for prod-shaped IDs / icons / app name; only the runtime `appEnv` is `'preview'`)
- **Remote config** — fetches the `{env}.json` remote-config file (`dev.json`, `preview.json`, or `prod.json`)
- **Feature flags environment** — only `dev` and `devclient` enable development feature flags; `preview` and `prod` use production flag values

### Mobile Builds

```bash
# Android — defaults to env=dev
bun scripts/build.ts android
bun scripts/build.ts android --env=prod
bun scripts/build.ts android --env=preview
bun scripts/build.ts android --env=preview

# iOS — same options (Mac only)
bun scripts/build.ts ios
bun scripts/build.ts ios --env=prod
```

Or via npm scripts (these use the default `dev` env):

```bash
bun run build:android
bun run build:ios
```

Output: Android APK at `android/app/build/outputs/apk/release/`, iOS archive at `ios/build/{scheme}.xcarchive`.

## Environment Variables

| Variable | Values | Description |
|----------|--------|-------------|
| `PNYX_BUILD_VARIANT` | `dev`, `devclient`, `prod` | Build variant — prefer using `--env=` flag instead |
| `PNYX_APP_ENV` | `dev`, `preview`, `prod` | Runtime env tag override (decouples remote-config / Sentry env from `buildVariant`) — used by `.env.preview` to ship a prod-shaped artifact that still reports as `preview` |
| `EAS_BUILD_PROFILE` | `development`, `preview`, `production` | EAS Build profile (maps `production` → `prod`, `development` → `devclient`) |
| `EXPO_PUBLIC_SERVICE_URL` | a URL | Content service. Unset → `serviceUrl()`'s per-platform dev loopback (`10.0.2.2` on the Android emulator, `127.0.0.1` elsewhere), which is correct **only** for local dev: it resolves to nothing on a device, and release builds block its cleartext HTTP |
| `PNYX_LAN_HOST` | an IP on your LAN | LAN preview: derives `EXPO_PUBLIC_SERVICE_URL` **and** permits cleartext HTTP to that host only. Unset → no exception, platform default (release builds block plaintext) |
| `EXPO_PUBLIC_PNYX_NETWORK` | e.g. `preprod`, `undeployed` | The Midnight network that service puts identities on. Declaring it lets onboarding derive an `pnyx_id` (and its avatar) with no network call; it is verified against `/auth/config` at sign-in, and a mismatch fails as `misconfigured`. Unset → the network is fetched instead (the local-dev shape, where it depends on what is deployed) |

**`PNYX_BUILD_VARIANT` is set automatically** by the build scripts when you pass `--env=`. Set it manually only when integrating with tools that invoke Expo directly (e.g., EAS Build custom workflows).

## E2E Tests

```bash
bun run e2e:android          # Maestro flows, devclient app
bun run e2e:ios
bun run e2e:smoke:android    # smoke-tagged flows only
```

See `e2e/maestro/README.md` for details.

## Clean Rebuild

If you encounter build issues:

```bash
# Android: remove android folder and rebuild
rm -rf android && bun run android

# iOS: remove ios folder and rebuild
rm -rf ios && bun run ios
```

## Quality Checks

```bash
bun run lint    # Lint with Biome
bun run check   # TypeScript type check
bun run test    # Run tests with Vitest
```

## Project Structure

```
app/
├── android/          # Android native code (generated)
├── ios/              # iOS native code (generated)
├── app/              # Expo Router screens
├── e2e/              # E2E tests (Maestro)
├── maestro/          # Ad-hoc Maestro helper flows
├── src/              # Main source code
│   └── __tests__/    # Unit tests
├── brands/           # Brand-specific assets and config
├── plugins/          # Expo config plugins
├── scripts/          # Build scripts (TypeScript/Bun)
├── dist/             # Build output
└── assets/           # Copied brand assets (gitignored)
```
