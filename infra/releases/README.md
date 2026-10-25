# releases

How a pre-release build reaches a tester, now that there is no app store in the path.

| | |
|---|---|
| **the build** | R2 bucket `pnyx-releases`, under `builds/<file>` |
| **served by** | the bucket's own R2 custom domain, `https://downloads.pxkq.uk/builds/<file>` — no Worker in the path |
| **the manifest** | `services/landing/public/pnyx/releases.json` — a **static asset**, not an R2 object |
| **advertised on** | <https://www.pxkq.uk/pnyx#get>, which reads the manifest at page load |
| **publish with** | [`publish.ts`](publish.ts), which uploads, merges the manifest and deploys |

⚠️ **Nothing in this path runs a Worker.** The manifest is a static asset (free, never invokes a
Worker) and the build is served by the bucket's own custom domain, so neither a page view nor a
download is billed per request. The price of the manifest being an asset is that publishing
redeploys the site, which `publish.ts` does for you.

⚠️ **The build cannot be an asset.** A static asset is capped at **25 MiB** and the APK is ~225 MB,
so it has to be an R2 object. `downloads.pxkq.uk` was attached to the bucket on 2026-10-16 with an
account token carrying `Zone:DNS:Edit` — wrangler's own OAuth cannot do this (zone *read* only),
the same constraint `infra/cloudflare/README.md` records for tunnels.

⚠️ **`content-disposition` lives on the R2 object**, set by `publish.ts` at upload. The Worker used
to add it; without it a browser may render a build instead of saving it.

## Publishing

```sh
cd app && bun run preview:build:android          # → app/dist/pnyx-preview.apk
cd .. && bun infra/releases/publish.ts android app/dist/pnyx-preview.apk
```

Platforms: `android` (`.apk`), `ios` (`.ipa`, see below), `ios-sim` (`.zip`).

`publish.ts` does not build. It hashes the artifact, uploads it under a key that carries the
version and the short commit, **merges** the manifest so publishing Android cannot erase a
published iOS row, and then deploys the site so the new manifest is live. It prints the URL.

▶ Commit the updated `services/landing/public/pnyx/releases.json` — it is the repo's record of
what is published.

⚠️ **`--remote` is not optional on any `wrangler r2 object put`.** Without it the write lands in
the local miniflare store and still reports success. `publish.ts` always passes it; if you upload
by hand, remember.

### What `--env` means here

`preview` is the default and the only one that currently makes sense: **prod app identity, preprod
chain, pointed at `pnyx.pxkq.uk`** (`app/env/.env.preview`). The manifest records it and the page
shows it, so a tester can see what their build is talking to. Do not publish a `dev` build — it
falls back to a loopback service URL and cannot reach anything from a phone.

## ✅ Signing: the published build uses the real key, measured

Since 2026-10-18 `buildTypes.release` is wired to a real keystore by
`app/plugins/with-release-signing.js`, with the credentials in `~/.gradle/gradle.properties`. A
machine without those properties **fails** the release build rather than falling back. Full detail,
the fingerprint, and the backup imperative: [`docs/ANDROID_SIGNING.md`](../../docs/ANDROID_SIGNING.md).

✅ **The APK now on `downloads.pxkq.uk` is signed with that key**, and this is measured rather than
reasoned: the published artifact was downloaded on 2026-10-25, its SHA-256 matched the manifest
(`310bca46…`), and `apksigner verify --print-certs` reported package `uk.pxkq.pnyx`, signer
`CN=Pnyx, OU=Pnyx, O=Pnyx, C=GB`, fingerprint `89:28:62:99:…:05:3D:BE`. An earlier paragraph here
said the published build predated the real key; that was true of `39202c07` and stopped being true
when `398e0e40` replaced it the same day.

⚠️ **The debug-signed artifact that it replaced is still out there on any device that took it.**
Android refuses an update whose certificate differs, with no override, so anyone holding the
pre-2026-10-18 download must uninstall first, which **destroys the keystore-held seed** on that
device. Re-publishing replaces the download, never what is already installed.

**Preview deliberately *is* prod's app id.** The point of a preview build is to be almost identical
to a prod one, down to **sharing its storage** — same package, so the same Android Keystore material
and the same app data, and a wallet created under one is the wallet the other opens. `app.config.js`
suffixes app ids for every `buildVariant` except `prod`, and a preview build ships
`buildVariant='prod'` for exactly this reason, so the published APK is `uk.pxkq.pnyx` and never
`uk.pxkq.pnyx.preview`. Two consequences: one `assetlinks.json` statement covers both artifacts, and
prod and preview can never be installed side by side on one device.

## iOS, in two halves

### The Simulator build — free, and the only iOS artifact we can hand out today

```sh
cd app && bun scripts/build.ts ios --simulator --env=preview   # → app/dist/pnyx-simulator.zip  (needs a Mac)
cd .. && bun infra/releases/publish.ts ios-sim app/dist/pnyx-simulator.zip
```

⚠️ `--env=preview` is not optional. `build.ts` defaults to `dev` by design, and a `dev` build falls
back to a loopback service URL — the same build this file tells you never to publish. Android gets
this right because `preview:build:android` bakes it into the script name; the iOS path has no such
wrapper, so it has to be typed.

A Simulator build is **not code-signed at all**, so it needs no provisioning profile and no Apple
membership — which is exactly why it can be published. It is the real iOS app; it just runs on a
Mac rather than a phone. The page says so plainly, including that a simulator has no Secure
Enclave, no push and no passkeys, so key storage falls back to software.

#### What the first run actually cost (2026-10-17)

The Mac became reachable over ssh and the `--simulator` path was run. **No artifact was produced**
— the run was stopped once it was clear the Simulator zip is not worth the remaining time (only a
tester with Xcode can run one, and a simulator has no Secure Enclave, so the passkey recovery rail
is exactly what it cannot demonstrate). What the run bought instead is this list and one real fix.

**One genuine defect, fixed in code:** `app/plugins/with-pods-deployment-target.js`. Xcode 27
refuses any `IPHONEOS_DEPLOYMENT_TARGET` below 15.0, and CocoaPods gives each pod's generated
resource-bundle target the *pod's own* declared minimum — 9.0 for PromisesObjC and SDWebImage, 11.0
for Sentry, 12.0 for GoogleUtilities and nanopb — so eight targets failed the build outright.
`expo-build-properties`' `ios.deploymentTarget` does **not** cover this: it rewrites the app target
and the Podfile's `platform :ios` line and nothing else. This blocks *any* iOS build, device or
simulator, not just this one.

**What a Mac needs before it can build iOS at all**, none of which was written down:

| | |
|---|---|
| the repo **and** the `evolution-sdk` fork checkout | the fork supplies most of the Cardano workspace members; push both over ssh (`git push <mac-host>:<path-to-repo> HEAD:refs/heads/<branch>`) so the box needs no GitHub key |
| CocoaPods | `brew install cocoapods` — system ruby 2.6 is too old for the gem. Export `LANG=en_US.UTF-8` or it warns on every invocation |
| pnpm **9.0.0** | the fork is a pnpm repo with its own turbo; `bunx pnpm` is not enough, because turbo shells out to the `pnpm` binary named in `packageManager` and dies with `cannot find binary path` |
| the fork built | `pnpm build --filter` the 14 packages Pnyx consumes. ⚠️ Plain `pnpm build` fails on `@evolution-sdk/devnet`, which Pnyx does not consume, and turbo aborts the whole run on it |
| one `effect` | pnpm resolves the fork to effect 3.22.2 against Pnyx's 3.21.4. Repoint **every** `effect` under the fork at Pnyx's copy before building. ⚠️ `packages/*/node_modules/effect` alone leaves 14 errors: pnpm's store copy (`node_modules/.pnpm/effect@*/node_modules/effect`) is what the emitted `.d.ts` refer to. Verified 2026-10-19 |
| `bun run build` | `@pnyx/hardware` resolves through `node_modules` to `dist/`, so Metro cannot bundle without it. ⚠️ This fails *cold* until the fork is built — the implicit-`any` cascade in `packages/tx-review/cardano.ts` is missing fork types, not a defect |
| Rust + the xcframework | `packages/midnight-native/scripts/build-ios.sh`. **`MidnightNative.xcframework` is a build output that exists on no Linux box**, and the Swift bridge links its FFI symbols — without it the app fails at link with ~40 undefined `_midnight_*` symbols. 398 crates, three targets, **1m 35s** on this M-series |
| the Firebase configs | gitignored. `scripts/inject-firebase-configs.sh` writes `*.example` placeholders; copy the real `GoogleService-Info*.plist` if push delivery should work |

Verified as far as it went: `expo prebuild` and `pod install` succeed, the Podfile edit lands, pods
compile at `arm64-apple-ios16.4-simulator`, and Metro bundles **7,502 modules / 20.6 MB**. The box
keeps its toolchain, so the next attempt starts at `build.ts` rather than here.

⚠️ **`xcrun simctl` on this Mac cannot boot a runtime** — `CoreSimulator is out of date. Current
version (1171.7.0) is older than build version (1174.9.2)`, i.e. Xcode's first-launch packages were
never installed. Harmless for a `generic/platform=iOS Simulator` build, but it means this box cannot
smoke-test the artifact it produces. `sudo xcodebuild -runFirstLaunch` fixes it and needs a password.

### An iPhone build

⚠️ **The blocker is signing, not building** — but do not read that as "the build is ready".
This file used to claim the Mac builds iOS fine, "on-device proving included"; that was never
verified against this box and was false when tested on 2026-10-17, which is what the Simulator
section above now records. The archive path (`bun scripts/build.ts ios --env=preview`) has still
never been run at all. What *additionally* does not exist is a **signing identity**, and without one there is no artifact an iPhone will accept, however it is delivered.
`app/eas.json`'s `submit` block still carries placeholders (`placeholder@pnyx.pxkq.uk`,
`ascAppId: "0000000000"`, `appleTeamId: "PLACEHOLDER"`), which is the honest state of it.

A free Apple ID is not a way round it. A "Personal Team" profile dies after **7 days**, and it
cannot sign the entitlements `app/app.config.js` declares — `associatedDomains`
(`webcredentials:` **is** the passkey recovery rail, `applinks:` is deep linking) and
`aps-environment`. A build with those stripped is Pnyx with its recovery broken, which is worse
than shipping nothing.

So both real routes need an **Apple Developer Program** membership:

| route | what it gives | what it costs |
|---|---|---|
| **TestFlight** | up to 10,000 testers by email or a public link; builds expire after 90 days; each build goes through a review | the membership, an App Store Connect record, and a wait on first submission |
| **Ad-hoc, over the air** | a signed `.ipa` plus a `manifest.plist` served over HTTPS, installed from an `itms-services://` link — **this one could live next to the APK on the landing page** | the membership, plus every tester's device UDID registered in advance, capped at 100 devices a year |

Ad-hoc is the one that fits what this folder already does; TestFlight does not need R2 at all. The
choice is not made, because it is a decision about who the testers are, not about tooling.

`publish.ts` already accepts `ios` and an `.ipa`, so the manifest and the page need no change when
a signed build exists — but ad-hoc OTA additionally needs a `manifest.plist` served over HTTPS,
which nothing generates yet. Until one route is chosen, the iPhone card says "not yet" rather than
offering anything.

## Checking what is published

```sh
curl -s https://www.pxkq.uk/pnyx/releases.json | jq .       # what the page will show
curl -sI https://downloads.pxkq.uk/builds/<file> | head -5
bunx wrangler r2 object list pnyx-releases --remote         # what is actually stored
```

Old builds are never deleted by `publish.ts` — keys carry their commit, so they accumulate. Prune
by hand when the bucket gets silly, and only keys nothing links to.

## There is no CI

This repo has no `.github/workflows`, and this is a local script by the same choice as
[`../sponsor-host/push.sh`](../sponsor-host/push.sh): the build needs the Android SDK and NDK, the
publish needs a Cloudflare token, and both already sit on the machine that does the work. If CI
arrives, the split here is the part worth keeping — build and publish are separate commands, so a
runner can do the first and a human the second.
