# Contributor Guide

This file provides guidance to any AI coding agent (Claude Code, Cursor, Devin, Codex, …) and human contributors working on this repository. All agents — no matter the vendor — should read and follow it.

## Project Overview

Pnyx is a privacy-preserving governance forum on Midnight, shipped as a standalone mobile app (Expo/React Native, iOS + Android). The Midnight identity stays dedicated to the forum (identity, not funds). As of the 2026-07-12 pivot the app is expanding into a companion **multi-chain wallet**: full wallet treatment for **Cardano** (via the `evolution-sdk` fork, consumed as `@evolution-sdk/*`) and Midnight as it matures, **address-derivation + on-chain ownership proofs only** for BTC / EVM / SOL, and **hardware-wallet** support (Ledger/Trezor) for the non-Midnight wallets only. **Mobile only is the path** — no extension and no web product target. ⚠️ But do not read that as "there is no extension code": `app/extension/` is a **working Chrome MV3 extension** (created 2026-07-13, 23 commits, last feature work 2026-08-21) that is **kept deliberately, dormant, in case the extension is revived** (dev-lead call, restated 2026-10-12). It worked before and is kept so it can work again. So: **build nothing for it and do not treat it as a target — and equally, do not delete it, port it, or clean it up as dead code.** It keeps compiling through refactors on purpose. `bun run build:extension` in `app` packages an `expo export --platform web` bundle as its UI, so the web export exists to serve that dormant build and nothing else ships from it. Details: `docs/EXTENSION.md`. All chain and crypto layers are fresh Effect-native implementations. Phase plan and locked decisions: `docs/mobile-shell-plan.md`. **Effect-TS** is the foundation for all packages.

**Current status and phase plan: `docs/mobile-shell-plan.md`** (read it before structural work). See `README.md` for layout. All workspace packages use the `@pnyx/*` scope. Crypto primitives live in `@pnyx/crypto` — extend it per consumer need rather than adding new crypto SDK dependencies.

## Development Standards

**Production-First Policy** — This project does not accept:
- ❌ Stubs or placeholder implementations
- ❌ Simplified or "good enough" algorithms
- ❌ TODO/FIXME comments without immediate resolution
- ❌ Features marked as "MVP quality"
- ❌ Incomplete error handling

**Every feature must be:**
- ✅ Fully implemented with proper algorithms
- ✅ Complete error handling for all edge cases
- ✅ Comprehensive test coverage
- ✅ Documented public APIs
- ✅ Production-ready from the start

**Cross-Platform Library Policy** — The app targets React Native (iOS + Android); some tooling still runs in Node. When adding a dependency:
1. Prefer universal libraries that work on all platforms (React Native + Web)
2. If none exist, find libraries with identical APIs for each platform, or use a polyfill
3. Never add a platform-specific library without a counterpart for the other platform
4. Platform-specific code must be isolated in `platform/` directories with `.web.ts` / `.native.ts` suffixes

**Every Caught Error Logs** — ⚠️ **IMPORTANT, MUST-READ.** A `catch` that swallows silently is banned. Every error path logs: `catch (e) { logger.warn(..., {error: String(e)}) }`, `.catch((e) => {logger.warn(...); return undefined})`, `Effect.catchAll((e) => {logger.warn(...); return Effect.succeed(null)})`. This applies even when the *fallback is correct* — "no address stored" and "the read failed" are different facts, and a screen that renders the same nothing for both makes the second undiagnosable. This cost a whole debugging session: `ReceiveScreen` swallowed three `getReceiveAddress` rejections, so a wallet whose Midnight addresses were missing looked identical to a wallet that had none, and the real error (`getReceiveAddress requires groupId and chainId`) was invisible until a log was added. **A silent success is the same defect**: a sync that logs nothing on the happy path cannot be told apart from one that never ran, which cost time in the same session. Level by intent — `debug` for an expected absence, `warn` for a failure the app recovered from, `error` for one it did not — but never nothing. Enforced by `app/src/logger/silent-catch.test.ts`, which fails when a file gains a silent handler. Lower a count in `silent-catch-baseline.json` when you fix one, never raise it. The 2026-08-22 re-measurement put the baseline at 233 sites in 157 files, up from 1 — not new debt, but the first honest count: the guard's `catch` pattern had been `catch \{\s*\}` — *empty* catches only — so a paramless catch with a body (`catch { setItems([]) }`, which was reporting a failed read as "no pending reviews") or with only a comment slipped through uncounted. It now matches any paramless `catch {`. ⚠️ **Swept on 2026-09-12 to 37 sites in 27 files**, and what is left is deliberate rather than pending: 5 in `packages/links`, held on a dev-lead call; 6 in dependency-free packages (`crypto`, `tx-review`, `dapp-connector`, and the three `*-native` modules) where the catch is a parse or capability probe — `requireNativeModule` throwing IS how absence is detected — and logging would mean giving a zero-dependency package a logger; and `config/env-manifest.ts`, which cannot log without an import cycle (logger → config/env → env-manifest). Two files are **exempt in the guard itself**, not baselined: `packages/logger/logger.ts` and `packages/migrations/load.ts`, where the thing that failed *is* the logging. A promise with **no** rejection handler is still invisible to the guard — that wants a lint rule, not a grep. ⚠️ **The guard globs `*.ts`/`*.tsx` only**, so until 2026-10-08 it never saw the 1,377 lines of `packages/cardano-core/internal/evolution-*.mjs` at all — untyped JavaScript escaped this guard as well as the type checker. Converting them added one baselined entry: `coseVerifyData`'s parse guard, where malformed counterparty bytes mean "does not verify" and the package has no logger to reach for (the same call as `crypto` and `tx-review`). ⚠️ **That entry left the baseline the same day, and not because it was fixed**: the codec moved to `@evolution-sdk/wallet-codec` in the Evolution fork, where this guard does not reach — the catch is still there, now counted by nothing. The guard only ever covered this repo, so any byte-level code that moves to the fork leaves its coverage behind. Baseline as it stands: **15 sites in 12 files** — down from 42/29 on 2026-10-12, when `packages/cardano-effect` was deleted and its 17 baselined files (27 sites) left with it. ⚠️ That is a removal, not a fix: those catches still exist on the branch `retired-final-2026-10-09` of the retired repo, now counted by nothing — the same thing that happened to the codec entry when it moved to the fork.

**TypeScript Only Policy** — ⚠️ **IMPORTANT, MUST-READ.** The source tree is TypeScript. `.mjs` and `.cjs` are **banned outright**, with no exceptions and no "for now"; `.js`/`.jsx` live only where a tool loads the file itself (`metro.config.js`, `babel.config.js`, `app.config.js`, `index.js`, `plugins/*.js`, and the Metro resolver shims in `app/src/platform/`, which answer with CommonJS `module.exports` and are named in the guard). Never hand-write a `.d.mts`/`.d.cts` beside an untyped body: TypeScript **trusts** a declaration file without checking the implementation against it, so it reads as a checked boundary while being an unchecked assertion — strictly worse than no declaration at all. "A harness can import it without a build step" is not a reason: bun and vitest execute TypeScript directly and Metro transpiles it. Enforced by `app/src/no-untyped-js.test.ts` across `packages/`, `services/`, `harness/`, `app/src` and `app/app`; its `RESOLVER_SHIMS` list may shrink, never grow. This cost real bugs: `packages/cardano-core/internal/evolution-*.mjs` (since 2026-10-08 `@evolution-sdk/wallet-codec/internal/EvolutionCodec.ts`, and TypeScript there too) were ~1,380 lines of byte-level signing code kept as plain JavaScript so a now-retired differential harness could run them under `node`, and their hand-written `.d.mts` kept reporting the right shape while an upstream merge replaced `InlineDatum.raw` with the `OriginalBytes` side channel — the adapter went on passing `raw:`, which was silently ignored. Converting the two files to TypeScript on 2026-10-08 also surfaced unchecked parallel-array indexing, `undefined` reaching encoders, and an `auxiliary_data` assembled with no metadata.

**Fallback Value Policy** — Do not replace `null`, `undefined`, missing fields, or failed reads with arbitrary defaults such as `0`, `''`, `'unknown'`, a network name, or any other convenient placeholder, especially when reading from structured data, backend responses, routing responses, transaction payloads, or external APIs. Only introduce a fallback when it is domain-correct, explicitly justified by the surrounding code, and safe for downstream behavior. If the correct behavior cannot be established from local context, preserve the absence as `null`/`undefined`, return a typed error, or ask the user before choosing a default. Never use fallback values to hide malformed, incomplete, or unexpected data.

**Environment Variable Policy** — Required `EXPO_PUBLIC_*` have **no defaults in code**. Every one the app reads is declared in `app/src/config/env-manifest.ts` with its required-per-variant status and a stated purpose; `app/src/config/env.ts` is the only module allowed to read `process.env.EXPO_PUBLIC_*` (enforced by `no-raw-env.test.ts`), and required accessors throw rather than substituting a value. `bun run env:check` fails a build whose variant file is incomplete. Do not add a `??` default to a required variable to "make it work locally" — set it in `app/env/.env.development`. Optional variables are fine, but their absence must mean something precise and be declared as such. Full rules and the four bugs that motivated this: `docs/ENVIRONMENT.md`.

**Third-Party RPC / API Policy** — Do not use third-party or public RPC endpoints, indexer APIs, price feeds, metadata services, or any out-of-band data source unless explicitly approved for the call site. Route blockchain RPC and indexer access through the project's configured endpoints (env-driven rail config such as `EXPO_PUBLIC_CARDANO_KOIOS_URL` via `getCardanoRailConfig`, brand config in `@pnyx/config`). Never reach for viem's `chain.rpcUrls.default.http[0]`, `mainnet.base.org`, `eth.merkle.io`, public Infura/Alchemy/QuickNode URLs, or similar — these are rate-limited, shared across the public, and out of our operational control. The same applies to non-RPC services: use the project's configured indexer / price / explorer endpoints instead of public alternatives (Etherscan, CoinGecko, public subgraphs, etc.). If a chain or service isn't configured for the current environment, surface the absence as `null` / typed error / skipped feature — do not silently substitute a public endpoint. Adding a new third-party dependency requires explicit user / dev-lead approval before landing.

**Password — No-Trim / No-Sanitize Policy** — ⚠️ **IMPORTANT, MUST-READ.** Password values must never be trimmed, normalized, or sanitized anywhere in the wallet — not in state setters, derived inputs, validation gates, button-disable expressions, comparison checks, or before any crypto / cache call. Whitespace bytes (leading, trailing, all-whitespace) are valid password content; the live password-gated crypto is the CIP-0301 encrypted backup at `app/src/utils/encrypted-backup.ts`, which derives its key from raw UTF-8 bytes via Argon2id + XChaCha20-Poly1305 (`@pnyx/crypto`) — that derivation is the source of truth. Any `.trim()` / `.trimStart()` / `.trimEnd()` / `.normalize(...)` / case-fold / whitespace-strip applied upstream silently locks users out of correctly-typed passwords (a backup encrypted under `" myP@ss123  "` cannot be decrypted by deriving from the trimmed form). The rule covers the encrypted-backup-export password and every other password-shaped secret in the app. (Wallet unlock itself is enclave/biometric via `credential-vault/` — there is no app-level password or PIN.)

**No Local Identifiers Policy** — ⚠️ The repo must not carry anyone's machine, network or account. No LAN IPs (`192.168.x.y`, `10.x.y.z` host addresses), no usernames or home paths (`/home/<name>`, `/Users/<name>`), no machine or SSH host names, no personal email addresses, no cloud account ids. This covers docs and comments as much as code — a `192.168.1.130` in a README is still someone's home network, and "it was only an example" is how it got there. Write a placeholder instead (`<your-lan-ip>`, `/home/<user>`, "the project account") or a command that prints the real value (`bunx wrangler whoami`). Named exceptions: CIDR *ranges* in code that classifies addresses (`192.168.0.0/16`), the Android emulator's host alias `10.0.2.2`, `example.com` test fixtures, and repository URLs a checkout genuinely needs. Swept clean 2026-09-12 across five files after a media-rig doc committed the origin's home-connection detail.

## Test Hygiene

These rules are non-negotiable — they've each been regressed more than once and each regression costs review cycles.

**Tests must exercise production code.** Never duplicate a production function inside a test file as an inline "mirror" or "parallel implementation", even if the production module is awkward to import (React context chain, transitive RN imports via `@sentry/react-native`, etc.). A test that runs a hand-copy of the function is not a test of that function — it's a self-fulfilling prophecy that silently rots.

If you can't import the real function:
- ✅ Extract it into a sibling module with no React/RN deps and import from there. Most "I can't import this" problems dissolve once the pure logic is separated from the hook.
- ✅ Re-export from the original location so callers don't break.
- ✅ Use `import type { ... }` when you only need the types (erased at build time — doesn't pull the runtime module).
- ❌ Copy-paste the function into the test and claim the copy "must be re-audited when either side changes." It will not be. That is how silent regressions ship.

**Name test files by what they test, not by the ticket that triggered them.**
- ✅ `bitcoin-normalize.test.ts`, `extract-from-review.test.ts`, `build-reviewed-bitcoin-tx.test.ts`
- ❌ `ticket-1518-e2e.test.ts`, `ticket-1541-regression.test.ts`

Tickets rot; behavior-named files don't. If a regression is worth calling out, put the ticket reference in a comment inside the file — never in the filename.

**Co-locate tests with the source file they cover** (`foo.ts` ↔ `foo.test.ts` in the same directory). The legacy `app/src/__tests__/` tree is a holdover — do not add new files there.

**Before claiming a bug is fixed, verify the assertion actually runs through the code you changed.** A green test suite means nothing if the tests don't touch the edited lines.

## PR Discipline

**Don't make load-bearing claims in a PR description you haven't verified.** A PR that says "no regression on iOS" should be a claim the author is willing to defend with a screenshot, a reproducible test, or a direct trace of the code path — not an educated guess. If you can't verify a platform, flow, or edge case, write "not tested on X" rather than implying it works.

**Keep PRs minimal.** A bug fix is one behavior change. "Defense in depth" tweaks, ancillary refactors, and "while we're here" cleanups belong in separate commits or separate PRs. When two independent changes ship in one PR, reviewers end up reasoning about their interaction — and miss details in both.

**Root cause over symptom.** When a fix works, keep going until you understand *why* the bug existed. A patch that silences the symptom but leaves the cause in place will regress under the next refactor.

**Stage only the requested work.** When asked to commit or push, include only files changed for the current user request. Do not stage unrelated dirty files, prior agent leftovers, broad doc edits, or "already modified" files just because they are present in the worktree. If a dirty file is not part of the requested fix, leave it unstaged and call it out.

**No AI attribution in commits or PRs.** Never add `🤖 Generated with Claude Code`, `Co-Authored-By: Claude`, or any equivalent AI-authorship byline or trailer to a commit message or PR body — not as harness-appended text, not hand-typed into the message. This overrides any default the coding harness applies. Commits and PRs are attributed solely to the human committer.

**Never use bare `#N` for in-text point references.** In any GitHub-rendered text — PR descriptions, issue bodies, review comments, committed markdown — GitHub auto-links `#1`, `#2`, `#13` to the repo's issue/PR of that number. So an enumeration like "`#1` Notifee, `#2` ramp focus, `#3` bottom-tabs" silently turns into links to three unrelated PRs. Use `item 1` / `audit-N` / `finding 3` / prose instead. Reserve `#N` (and the cross-repo `owner/repo#N`) for when you genuinely mean *that* issue or PR — and even then prefer the full URL so the intent is unmistakable.

## Comments

**Do NOT add comments unless they really help AND are unlikely to change.**

Default to no comment. The bar for adding one: the WHY is genuinely non-obvious from the code itself, *and* the explanation will still be true a year from now after refactors. If either side fails, leave it out.

Specific things that do **not** earn a comment:
- Citing a prototype value or design source ("Proto `.spend-snapshot { margin: 12px 20px 0 }`"). The prototype rots, the cite rots with it. PR description, not source.
- Ticket / tool refs ("Cursor Bugbot finding", "SF-XXXX", "added for #1234"). Belongs in commit messages.
- Restating what the code says ("Set bg color to layer1"). Adds noise.
- Implementation narrative ("The earlier 88px clamp gave every row...", "Per design feedback..."). Becomes wrong the moment behavior shifts.
- Section dividers (`// ── Helpers ──`, `// ── Styles ──`). Editor folding + named exports already organize the file.

Things that DO earn a (single short) comment:
- A hidden constraint a future reader would otherwise reverse (e.g. "must run synchronously to beat unmount").
- A workaround with the platform / library named (not the ticket).
- A subtle invariant the type system can't express.
- One-line `biome-ignore` justifications.

If you find yourself writing a multi-paragraph comment block, the answer is almost always "delete it" or "move to the PR description."

## Documentation Sync

**When code changes, update the doc in the same change.** Behaviour docs (`docs/STORAGE_MIGRATIONS.md`, `docs/STORAGE_KEYS.md`, etc.) are the durable contract; the code is the implementation. If the implementation diverges from the doc and only the code is changed, the next reader is misled and the doc rots into noise.

Rule:

- **Behaviour change** (anything user-visible, anything documented in a behaviour doc) → update the matching doc in the same commit. If you cannot find a matching doc and the change is non-trivial, ask the user where to record it.
- **Structural / refactoring change** that preserves user-visible behaviour → no behaviour doc update needed, but if a structural doc tracks the work, mark the relevant phase as shipped.
- **API / contract change in a package** that has a `README.md` or top-of-file module doc → update that doc.
- **State-machine / decision-rule change** (any pure decision module like `cancel-fallback.ts`, `auth-failure-fallback.ts`, `route-auth-requirement.ts`, `card-screen-rendering.ts`, `auto-siwe-seeding.ts`) → update the matrix table in the matching behaviour doc and the rule's own JSDoc table.

When in doubt about which doc covers a change, run `grep -rl "<the function or rule name>" docs/` and update every hit. Doc drift is a silent failure mode — treat it like a silent test pass.

Per-screen mapping decisions, pending product questions, and explicitly-not-for-MVP items are tracked in `product/STATUS.md` — read it before touching a screen.

### Standardization rule

Anything that appears in more than one screen is a single component, not a copy per screen. Toasts, network picker, asset picker, amount input, confirm sheet, review-tx surface: one canonical implementation. Need a variation? Add a prop — don't fork the component.

### UI patterns to avoid

Design references (HTML mockups, exported comps) are often plain HTML/CSS with inline hex, hardcoded English, and `View + onClick` style interactivity. They're visual reference, not reference implementation — don't port those patterns into the React Native app.

#### Don't hardcode colors

The theme token system (`app/src/theme/tokens.ts`, `app/src/theme/presets/pnyx.ts`) exists so light/dark switching, brand swaps, and future token changes all work without touching components. Every new hex literal in a component is a bug waiting for one of those events.

- **Do**: `color: theme.colors.primaryDefault`, `color: theme.colors.successDefault`, `color: theme.colors.primaryInverse`.
- **Don't**: `color: '#1A6FFF'`, `const BRAND_CYAN = '#00C8E1'`. Inline `rgba(...)` only for true overlays without a token.
- **Gradients**: pull endpoints from `theme.colors` via `useUnistyles()` at render time, pass into `<LinearGradient colors={[...]}>`.
- **Data tables with per-item accents** (e.g. one color per product on a roadmap card): the hex is part of the data, not the style. Fine inline in that case — but the component's *style* tokens still come from the theme.

#### Don't hardcode English

Every user-facing string goes through `useI18n()` / `t('…')`. Titles, labels, sublabels, accessibility labels, placeholder text — all of it. The translation pipeline depends on every string being a key.

- **Do**: `<AppHeader title={t('tabs.earn')} />`.
- **Don't**: `<AppHeader title="Earn" />`, `accessibilityLabel="Go back"` as a string literal inside a leaf component — thread it from a caller that has `t`.

#### Don't use `View + onTouchEnd` for a button

`onTouchEnd` on a plain `View` fires during scroll, gives no press feedback, and doesn't register as a tap target for screen readers. Use `Pressable` with `onPress`, or `TouchableOpacity` for legacy call sites. Plain-HTML `onclick` patterns do not map to React Native.

#### Don't use `as never` to silence the route typer

Expo Router emits typed route constants. A `router.push('/foo' as never)` says "trust me" — fine as a narrow escape hatch, but if the cast is masking a real type drift (renamed route, missing param), it'll let a silent regression ship. Prefer fixing the type at the source; if you must cast, leave a one-line comment explaining why.

#### Don't lie to the user

If a button's copy says "Log out" and the handler only calls `router.replace(...)`, the user has been lied to. If a filter pill toggles to `ETHEREUM` but the data below doesn't filter, same thing. Either the UI promise is honoured, or the affordance doesn't ship. This is the bright-line distinction between "UI change" and "new feature pretending to be a UI change".

#### Don't add components that don't get used

A primitive built for a spec that nothing imports is dead code with maintenance cost. Either wire it into a consumer in the same PR, or don't land the file.

#### Don't rely on an SVG's baked-in fill for tinting

SVG asset files under `app/assets/icons/` carry their own `fill="#…"` from the design source. Without an explicit `color` prop, `UniIcon` passes `tintColor: null` to `expo-image` and the icon renders with whatever hex the file was exported with — typically a near-black that disappears in dark mode.

- **Do**: pass `color={theme.colors.textDefault}` (or the matching variant token) to every `UniIcon`. Inside `Button`, the variant's `textColor` is auto-applied — caller doesn't need to thread it unless overriding.
- **Don't**: drop a `UniIcon` (or `Button leftIcon=…`) into a dark-surface context and trust the SVG to look right. It won't.

When you add a new SVG to the registry, render it once in dark mode against the lightest expected surface before shipping. If it disappears, that's the tint-prop bug.

#### Always optimize new SVG assets with svgo

Every SVG added under `app/assets/` or `app/brands/*/assets/` must be optimized before it lands. When an agent (Claude, Cursor, Devin, Codex) adds or replaces an `.svg` file, run the optimizer in the same change — don't leave it for the human:

```bash
cd app && bun run svg:optimize   # optimizes in place; bun run svg:check for a dry-run report
```

The config (`app/scripts/optimize-svg.ts`) is tuned for this app's render path: it preserves `viewBox` (UniIcon sizing), keeps baked-in `fill`/`stroke`/`currentColor` (tinting), and strips `width`/`height`. Do not hand-write svgo flags that re-enable `removeViewBox`, `convertColors`, or `removeUselessStrokeAndFill` — they break sizing or tinting here. Files svgo's strict parser rejects (unquoted/camelCase attributes) are reported and skipped, not silently dropped; fix the source markup if you want them optimized.

### Performance guardrails

Known traps that take precedence over visual fidelity. If you hit another, capture it in `product/STATUS.md`.

- **Privacy mode (hide numbers) → use dots/stars, not blur.** Blur tanks performance on older Android devices when applied across many small numbers at once.
- **Don't render a full detail view inline in a bottom sheet** when that view has its own complex content (charts, long lists, tab-like sub-sections). Push it to a separate screen so the parent doesn't mount everything at once.
- **Don't reach for `const {theme} = useUnistyles()` to read static theme colors.** It opts the component **out** of Unistyles' native shadow-tree update, so it re-renders **in JS** on every `setTheme()` and every breakpoint/orientation change — the root cause of device-only theme-switch jank. For a new or edited component: put static colors in `StyleSheet.create((theme) => …)` and reference `styles.x`; model conditional/state colors (up/down, success/error, status pills) as Unistyles `variants` + `styles.useVariants({…})`; for a color that must land on a custom or RN-core component prop (`UniIcon` → `uniProps`, otherwise `withUnistyles(Component)` + `uniProps`). Only keep `useUnistyles()` when the value is genuinely dynamic at render (runtime-indexed token, chart/gradient endpoints). Full recipe + traps: [`docs/STYLING_UNISTYLES.md`](docs/STYLING_UNISTYLES.md).

## The evolution-sdk fork is built BY our build

`bun run build` runs `scripts/build-fork.ts` first. It is a no-op when the fork is healthy, and
otherwise builds it **packages-only** and repoints every `effect` copy under it at ours. Do not
reintroduce a manual "build the fork first" step, and do not run the fork's own `pnpm build`
expecting exit 0: its root `turbo build` includes `docs`, which fails on a clean clone (30
fumadocs/acorn MDX parse errors) and fails again, differently, once `effect` is repointed (Turbopack
will not follow the symlink out of the fork's tree). Neither failure touches anything we consume.
`bun run build:fork` runs it alone; `--check-only` is the read-only gate and `--force` rebuilds a
healthy tree. The package list is derived from `tsconfig.base.json`'s paths, so adding a fork
package there is enough.

## Troubleshooting

**"Cannot find module" / "Cannot find package" errors** — When build or tests fail with missing module/package errors, always run `bun install` first and check `package.json` for the dependency before making any workarounds (excluding from tsconfig, etc.). This is a monorepo — dependencies can go missing after branch switches, rebases, or new packages being added.

## Commands

```bash
# Build & Type Check
bun run build          # tsc -b tsconfig.build.json
bun run check          # type-check only, in three passes: the project graph, then
                       # tsconfig.typecheck.json (packages no project covers), then
                       # tsconfig.tests.json (every test under packages/ services/ harness/)
bun run check:tests    # just that third pass

# Testing
bun run test           # vitest
bun run test:watch     # vitest --watch
bun run coverage       # vitest --coverage — root `vitest.config.ts`: 60/50/60 lines/branches/functions
                       # (⚠️ `vitest.shared.ts`, used by per-package configs, is stricter: 80/75/70)

# Linting & Formatting
bun run lint           # biome check .
bun run lint-fix       # biome check --write .
bun run format         # biome format --write .

# E2E Testing
bun run test:e2e       # Cardano chain integration tests (requires E2E_TESTS=1)
bun run test:e2e:setup # Setup UTXOs for E2E tests

# Coverage UI
bun run coverage:ui    # Coverage report with interactive UI

# Cleanup
bun run clean          # Remove dist, node_modules, *.tsbuildinfo
```

## Midnight & contract skills

Task-scoped skills for the Midnight/ZK layer live under `.claude/skills/`. Load the relevant one before working in that area — each is grounded in this repo's real code, toolchain pins, and hard-won gotchas (not generic Midnight docs, which lag our toolchain).

| Skill | Use when working on |
|---|---|
| `compact` | Writing/debugging `contract/pnyx.compact` — Compact 0.23 syntax, ledger state, witnesses, circuits, `disclose()`, stdlib, compiling |
| `contract-security` | Auditing the contract for privacy/leaks — visibility rule, commitment/nullifier design, domain separation, front-running, guaranteed-vs-fallible semantics (read alongside `compact` when hardening the spike toward production) |
| `native-proving` | `packages/midnight-native` — the on-device Rust proving rail, porting a circuit's preimage, the JNI/Kotlin/TS/iOS bridge, artifact fetch/cache, the `deviceProving` cutover |
| `chain-deploy` | `packages/chain-client` / `harness/*` — the dust-free `balanceTx→submitTx→watchForTxData` rail, coin-race retries, local standalone stack, Preprod deploy + faucet, the `feesWithMargin` flake, cold-sync OOM |
| `pnyx-identity` | `packages/contract-client` identity, `services/content` auth, `pnyx-session.ts` — the `pnyx_id` (`C`) commitment, the on-chain identity row, `/register`, the login handshake that replaced SIWM, the ES256 JWT/JWKS, persona derivation |

These follow the same doc-sync rule as everything else: **when the code changes, update the matching skill in the same change.**

## Architecture

### Package Structure

```
packages/
├── blockstore-native/ # Google Block Store (Android) — syncs the passkey-wrapped recovery blob
├── chain-client/   # Headless Midnight wallet + on-chain mirror client (server-side)
├── config/         # CAIP-2 chain ids, feature flags, remote config
├── contract-client/ # Domain derivations, witnesses, contract simulator
├── crypto/         # @pnyx/crypto — Effect-TS crypto primitives + codecs (@noble/@scure)
├── dapp-connector/ # Mobile CIP-30 rail: injected provider, resolver, session manager
├── hardware/       # Ledger + Trezor for the non-Midnight wallets (BTC/EVM/SOL/ADA)
├── identicon/      # Identicon generation
├── links/          # Deep links for the app, CIP compliant and more
├── logger/         # Structured logging with transports
├── midnight-native/ # Native module bindings for Midnight proving/curve math
├── migrations/     # Storage migrations
├── model-native/   # On-device LLM rail — Apple Foundation Models / Gemini Nano
├── passkey-native/ # Platform passkeys + the WebAuthn PRF extension
├── signer/         # Software wallet signing
├── signing-service/ # Signing orchestration (ports & adapters) — dispatch, witnesses, broadcast
├── storage/        # Platform storage abstraction (MMKV on React Native)
├── store/          # Data persistence (SQLite, IndexedDB, LevelDB)
├── tx-review/      # Wallet-aware transaction-review IR, shared by review + activity
└── wallet/         # Wallet and account management

app/                # The mobile app (Expo + expo-router, Unistyles) — top level since 2026-10-15
├── app/            # Expo Router screens (the router's root is `app/` by convention, hence app/app)
├── scripts/        # Build tooling (run.ts, build.ts)
└── src/
    ├── __tests__/   # LEGACY location — do not add new tests here; co-locate with source
    ├── components/  # UI components (Button, Card, Input, Modal, Toast, …)
    ├── theme/       # Theme tokens, breakpoints, presets
    ├── providers/   # Config, I18n, Theme, Wallet providers
    ├── i18n/        # Internationalization — type-safe translations
    ├── platform/    # Platform-specific utilities (storage, notifications)
    └── hooks/       # Custom React hooks

services/
├── content/        # Content service: identity-row auth rail, content store, chain mirror worker
├── data-worker/    # Cloudflare Worker: slow-data (DRep/pool lists) projected onto R2
└── landing/        # Cloudflare Worker: the public page at www.pxkq.uk/pnyx + the build downloads

infra/              # Everything that runs off this box — see infra/README.md for the box index
├── cloudflare/     # Which hostname answers what, the three Workers, the three tunnels, the traps
├── releases/       # Publishing pre-release builds to R2, where the landing page offers them
├── sponsor-host/   # The sponsor VPS: bootstrap, push, units, env examples
├── midnight-public/ # The self-hosted Midnight indexer stack (on the Mac)
└── standalone/     # The local Midnight chain, for e2e:local
```

⚠️ **`infra/` is where off-box operations go** — Cloudflare, the VPS, the Pi, the Mac. Code that
*runs* on those boxes stays with what it belongs to (the Workers in `services/`, the sponsor server
in `services/content/src/`); what lives in `infra/` is provisioning, deployment and reachability.
`infra/**/*.ts` is type-checked and its tests run, so it is a real tree, not a drop box. No secret
belongs in it.

⛔ **`packages/cardano-effect` is gone (removed 2026-10-12), submodule and all.** The live Cardano rail
is the **`evolution-sdk` fork**, consumed as `@evolution-sdk/*`: `review`, `evolution`, `plan`, `cip113`,
`cips`, `cip30`, `cip139`, `canonical`, `dijkstra`, `hardware-cardano`, `backup-keys` — 11 packages.
⚠️ **`wallet-codec` and `x402` were removed on 2026-10-19** and neither is consumed any more:
`wallet-codec` had become test-only (the tier-differential oracle, deleted with it), and `x402` is the
retirement step the adoption plan always named (`docs/x402-handoff.md`), so `cardano_x402Fetch` is
gone from the catalogue.

⚠️ **`wallet-codec` and `aiken-uplc` have zero import sites in Pnyx and must STILL be listed in the
root `workspaces`.** Both are `workspace:*` devDependencies of fork packages we do consume
(`plan` and `cip113` respectively), and our workspaces list is an enumeration of the fork's packages
— so dropping either makes every `bun install` fail with `Workspace dependency "…" not found`. They
are correctly absent from Metro's `liftedForkPackages` and never reach a bundle. Do not "clean them
up": zero import sites is not the same as removable.

Do not reintroduce `@pnyx/cardano-effect` in code, config or docs. Its final state is preserved on
the branch `retired-final-2026-10-09` of its own private repo; nothing in Pnyx references it, and no
measurement of this repo needs to exclude it any more.

### Wallet App Architecture

The app uses a **single codebase** for all platforms:

| Platform | Build Command | Layout |
|----------|---------------|--------|
| iOS/Android Phone | `bun scripts/run.ts ios` / `bun scripts/run.ts android` | Narrow (mobile) |
| iOS/Android Tablet | `bun scripts/run.ts ios` / `bun scripts/run.ts android` | Wide (desktop) at 768px+ |
| Chrome MV3 extension — ⏸ **DORMANT, kept in case** | `bun run build:extension` (in `app`) | the web export, packaged — see `docs/EXTENSION.md` |

**Key Technologies:**
- **Expo Router** for navigation (mobile; the web export exists only for the dormant extension build)
- **Unistyles 3.0** for cross-platform styling with responsive breakpoints
- **Metro** bundler — required for Unistyles

**Note:** Apps consume packages. Packages connect to services (also powered by packages).

### Effect-TS Patterns

This codebase uses Effect-TS exclusively. Key patterns:

- **Effect.gen()** for composable async operations
- **Branded types** for type-safe domain primitives
- **Option<T>** for optional values (never use undefined in public APIs)
- **Pure functions** returning Effect
- **Service pattern** for dependency injection via Layers
- **No classes** — all functions

### Code Organization per Package

```
package/
├── index.ts              # Barrel exports (only at package root)
├── submodule.ts          # Module barrel (exports from submodule/)
├── submodule/
│   └── *.ts              # Implementation (no index.ts in subdirs)
├── *.test.ts             # Unit tests (co-located with source)
├── integration.test.ts   # Integration tests
└── package.json
```

**Convention:** Index files are only for package entrypoints. Subdirectory exports use barrel files at the package root (e.g., `submodule.ts` exports from `submodule/*.ts`). Use `type` aliases instead of `interface` when possible.

**Pure logic lives in its own module.** If a helper is pure (no React, no RN, no DOM), put it in its own file so tests can import it directly. Don't hide pure logic inside a React hook file and then claim it can't be tested.

## Configuration

- **TypeScript:** Strict mode, ES2022, NodeNext modules, composite projects
- **Biome:** 2-space indent, 120 line width, single quotes, trailing commas
- **Vitest:** Coverage thresholds: 60% lines, 50% branches, 60% functions

## Internationalization (i18n)

**Translation Policy** — English is the only language authored by hand:
- ✅ Only edit `app/src/i18n/translations.ts` (English source strings)
- ❌ Never hand-edit `translations_<locale>.ts` — those eleven files are generated from the English source
- There is **no hosted translation service and no CI job**. Regeneration is a deliberate local run: `chunk → translate → validate → emit`, documented in `docs/I18N_TRANSLATION.md`, with the scripts in `app/scripts/i18n/`.

When adding or modifying UI text, add/update the English string in `translations.ts`, then regenerate the affected locales before the change ships. `locale-parity.test.ts` fails when a locale drifts from the English key set, so a forgotten regeneration surfaces in the suite instead of silently falling back to English on a user's phone. Never emit a locale file that `scripts/i18n/validate.ts` rejects — `interpolate` degrades malformed ICU to **visible raw template text** rather than throwing.

**No Em Dashes In Copy** — ⚠️ Em dashes (`—`) are banned in every user-facing string, English and translated alike. Use a period, colon, comma or parentheses; CJK locales use their own full-width punctuation. The only exceptions are the two "no value" placeholder glyphs allowlisted in `app/src/i18n/em-dash.test.ts`, which fails when one comes back. This is a **copy rule only** — code, comments and this file are unaffected.

**ICU Pluralization Policy** — ⚠️ **IMPORTANT, MUST-READ.** Every pluralization-affected string in `app/src/i18n/translations.ts` must use ICU MessageFormat (`'{count, plural, one {# token} other {# tokens}}'`). Legacy patterns (`{plural}` placeholder, `(s)`/`(es)`/`(ns)` shorthand, plural-only forms next to a count variable, sibling-key conventions like `*One`/`*Other`/`*Many`/`*None`) are banned at the EN source. Callers must pass raw `number` to count selectors — never `String(n)`, `.toString()`, `formatCount(...)`, or `formatLocalizedNumber(...)` — and must not render a count as a JSX sibling adjacent to a label key. The runtime engine at `app/src/i18n/provider.ts` uses `intl-messageformat` with a defensive try/catch fallback that means malformed ICU degrades to **visible literal text in the UI** rather than crashing — silent regressions ship if you don't render-test plural keys in at least one non-EN locale.

### Number Formatting & Parsing

**Never roll custom number parsing or formatting.** All user-facing numeric I/O must route through the shared primitives in `app/src/i18n/number-format.ts` so decimal separators, grouping separators (incl. NBSP / narrow-NBSP), subscript compression, and Hermes-Android quirks stay consistent across send / swap / ramp / card / portfolio.

**Parsing user input** (TextInput → canonical value):
- `parseNumberFromText(text, {decimals, locale, precision})` — pure; returns `{inputValue, canonicalStr, canonical, isEmpty}`. Handles keyboard/locale mismatch, paste with grouping separators, leading-zero collapsing, precision truncation.
- `useNumberParser()` — React hook that binds the active locale automatically.
- Bind `TextInput.value = parsed.inputValue` (locale-correct display); use `parsed.canonicalStr` / `parsed.canonical` for math and storage.
- For integer-only input, pass `{decimals: 0, precision: 0}`.

**Formatting numbers for display** — the single entry point is `formatAmount` (in `app/src/utils/number-display.ts`):
- `formatAmount(value, {preset, currency?, locale?, decimals?})` — pick a preset; it owns the shaping rule AND currency placement. Presets: `fiatBalance | fiatPrice | fiatFee | fiatCompact | cryptoBalance | cryptoActivity | cryptoTxDetail | cryptoFee | percent`. `currency` is an ISO 4217 code for `fiat*` presets, a token ticker for `crypto*`; pass a `bigint` + `decimals` for lossless crypto.
- `useFormat()` (in `providers/NumberFormatProvider`) — the React hook; binds the active locale and wraps `formatAmount`. Prefer it in components over calling `formatAmount` with a hand-threaded locale.
- USD-denominated backend data: convert first with `toSettingsFiat(usd, {currency, prices, fxRates}) → {value, currency}` (in `hooks/price-conversion.ts`), then spread into `formatAmount`. It falls back to the USD figure under `'USD'` when no FX rate exists — never the target symbol over a USD number.
- `formatLocalizedNumber(n, {locale, minFrac?, maxFrac?})` — general locale grouping, for plain numbers with no currency/ticker shaping.
- `formatGroupedInteger(bigint|number, locale)` — integer grouping, Hermes-safe (never calls `Intl.NumberFormat.format(bigint)` directly).
- `formatFiat` / `formatCrypto` / `formatPercent` (in `i18n/number-format.ts`) are the **low-level engines** behind the presets. Reach for them only when a preset genuinely doesn't fit (e.g. staking's `rounding: 'truncate'` + custom `maxFractionDigits`); otherwise use `formatAmount`.
- `formatInvariantNumber` is reserved for logs / analytics / URLs — never for user-facing UI.

**Anti-patterns** (will regress DE/FR/RU/PT users):
- `/^\d+$/` or similar ASCII-digit regex validation.
- `Number.parseFloat(input) / Number.parseInt(input, 10)` on raw user input.
- `num.toFixed(n)` for display (always produces `.`-decimal).
- `num.toString()` for display without going through a locale formatter.
- `new Intl.NumberFormat(...).format(BigInt(x))` — crashes Hermes Android; use `formatGroupedInteger`.
- Manually replacing `'.'` with `locale.decimal` — use `parseNumberFromText`, which handles edge cases (trailing separator, empty, paste).

## Migration

When porting code from external projects:
replace classes → functions, RxJS → Effect Streams, Zustand → Effect Refs,
Promise → Effect, null/undefined → Option, thrown errors → Effect.fail.

## Cursor Cloud specific instructions

- The Cloud VM startup dependency refresh is `bun install`. Standard lint/test/build/run commands are documented in `README.md`, `package.json`, and `app/package.json`.
- ⚠️ **There is no root `dev:web` script** (checked 2026-10-12). Earlier text here told agents to run `bun run dev:web --skip-build` from the root; it never resolved — the root has `dev:ios` / `dev:android` only. Web dev lives in `app`: `bun run web` (→ `bun scripts/run.ts web`), `bun run build:web`, `bun run build:extension`.
- The local dev proxy runs on `http://localhost:3001`. Most wallet E2E flows use hosted backend/blockchain services from the selected brand env; local backend services under `services/` are optional unless you are specifically developing that service.
