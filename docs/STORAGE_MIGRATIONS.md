# Storage Migrations

How we handle schema changes to persisted data.

> **TL;DR** — Anything going through `@pnyx/migrations` gets a forward-only, versioned envelope + automatic quarantine on failure. Binary snapshots (`@pnyx/store`) and encrypted secrets (mnemonics, xprivs) are out of scope and handled with their own mechanisms. Adopt the framework the **first** time a blob's schema needs to change, not proactively.

## When to use the framework

Use `@pnyx/migrations` when:

- The data lives in `@pnyx/storage` (MMKV / AsyncStorage / chrome.storage / localStorage).
- You're about to change the on-disk shape — adding, renaming, removing, or reshaping a field on a blob that already has users (or dev installs with existing data).

Do **not** use the framework for:

- **Binary snapshots in `@pnyx/store`** (e.g. wallet balances / UTXOs / tx history). These are re-derivable from the chain, so the existing `invalidate-on-version-mismatch` strategy (`WALLET_SNAPSHOT_VERSION`) is cheaper and safer than transforming bytes in place.
- **Encrypted secrets** (mnemonics, xprivs, held in the credential vault / enclave path). Migrating these would require the user's derived key at boot time, which isn't available before authentication. Any schema change here needs a bespoke post-auth migration flow — talk it through before writing one.
- **Transient platform writes** — session keys, 10-minute TTLs, social-login-internal state. No versioning needed.
- **One-shot user-facing migrations** (e.g. a legacy wallet import). Those have their own UX flow and aren't silent-on-load transforms — a different pattern that stays outside this framework.

## How the framework works

### The envelope

Every value managed by the framework is persisted as:

```json
{"version": 3, "data": {...}}
```

Reads pass through `loadVersioned`, which:

1. Parses the envelope (or detects pre-framework raw data and treats it as v0).
2. Runs the forward migration chain from the stored version up to `currentVersion`.
3. Calls `validate()` on the final value.
4. Returns `Option.some(value)` on success, `Option.none()` on missing-or-quarantined.

On any failure (parse error, unknown version, migration throw, validation reject) the blob is **quarantined** — moved to a sibling `{key}:quarantined:{iso-timestamp}` key and removed from the original, so the caller sees "no data" and proceeds with a fresh state. Nothing is deleted outright; the quarantine copy survives for post-mortem inspection.

### The migration chain

A chain is a list of forward steps:

```ts
const v0ToV1: Migration = {from: 0, to: 1, migrate: (prev) => prev /* identity */}
const v1ToV2: Migration = {from: 1, to: 2, migrate: (prev) => rename(prev)}
const v2ToV3: Migration = {from: 2, to: 3, migrate: (prev) => reshape(prev)}
```

Chain constraints, enforced at config construction:

- `to === from + 1` — no skipping versions.
- Contiguous — no gaps between adjacent steps.
- Ends at `currentVersion`.
- `from: 0` is reserved for legacy-detection (unversioned pre-framework data). Include it only when you know pre-framework writes exist.

At **load time** there's one additional guard that can't be enforced at config construction: the earliest step's `from` must be ≤ the stored data's version. Otherwise the framework can't migrate (e.g. chain `[{from: 2, to: 3}]` encountering stored v1 data). Such cases quarantine with `reason: 'unreachable-version'`. In practice this only fires when a consumer intentionally omits a legacy/lower-version step — document such choices so stored data below the chain's floor is understood as "recovery required, not silently migrated."

## Worked examples

### Pattern A — "new blob, first writes"

Nothing on disk, new key, no legacy concern.

```ts
const config: MigrationConfig<Settings> = {
  key: '@pnyx/settings',
  currentVersion: 1,
  migrations: [], // empty is valid when currentVersion === 1
  validate: isSettings,
}
```

### Pattern B — "existing blob, first schema change"

Before the change, the data lived at the raw key without an envelope (e.g. a raw `Contact[]` JSON). Now the shape is evolving from v1 to v2. The chain detects legacy data, stamps it as v1, and runs the shape transform.

```ts
// v2 adds a `labels: string[]` field, defaulted to empty.
const v1ToV2: Migration<Contact[], ContactV2[]> = {
  from: 1,
  to: 2,
  migrate: (prev) => prev.map((c) => ({...c, labels: []})),
}

const config: MigrationConfig<readonly ContactV2[]> = {
  key: '@pnyx/address-book-contacts',
  currentVersion: 2,
  migrations: [v1ToV2],
  validate: isContactV2Array,
}
```

Pre-framework raw `Contact[]` writes match the v1 shape, so they skip straight into the v1→v2 step. No `v0→v1` entry needed — legacy-detection enters at v0, `stepsFrom(0)` yields the v1→v2 step, and the shape happens to line up.

### Pattern C — "legacy shape differs from v1"

When pre-framework data needs transforming before it's even valid at v1, add an explicit `v0→v1` step.

```ts
const v0ToV1: Migration<unknown, ContactV1[]> = {
  from: 0,
  to: 1,
  migrate: (prev) => {
    // Pre-framework writes were `Record<string, Contact>`, keyed by address.
    if (typeof prev !== 'object' || prev === null) throw new Error('v0: not an object')
    return Object.values(prev as Record<string, ContactV1>)
  },
}
```

### Pattern D — "counterfactual: CAIP-2 chain-id rollout"

What the CAIP-2 chain-id rollout (`d0262a5b7`, April 2026) **would have looked like** if we'd had the framework. Kept as an illustration — we deliberately forgone this migration pre-release and asked devs to wipe.

```ts
// Pre-rollout: `WalletGroup.chains` was a `Record<ChainSlug, ChainConfig>`
// where slug was `'cardano'`, `'ethereum'`, etc.
// Post-rollout: keyed by CAIP-2 ids (`cip34:1-764824073`, `eip155:1`, …).
const v1ToV2: Migration<SerializedWalletGroup_V1, SerializedWalletGroup_V2> = {
  from: 1,
  to: 2,
  migrate: (prev) => ({
    ...prev,
    chains: mapKeys(prev.chains, slugToCaip2),
  }),
}
```

With this in place, existing users would have upgraded silently on next load — no wipe, no crash in `getChainInfo('cardano')`, no Sentry noise. This is the shape the framework exists to enable.

## Bespoke repairs that need the seed

Some data cannot use the framework *or* the invalidate-and-resync strategy: it is
derived from the mnemonic, so it is neither re-derivable from the chain nor
transformable at boot, when no seed is available. The rule from the section above
("any schema change here needs a bespoke post-auth migration flow") applies, and
this is what one looks like.

**Midnight receive addresses** (`persistMidnightReceiveAddresses`,
`ensureMidnightReceiveAddresses`). Written once at wallet creation while the
mnemonic is in memory, into the network-independent address table, one set per
network — night / dust / shielded per `(group, account, networkId)`. They used to be
written for the active network only, into the per-network table, which the wallet
service reopens on a network change: switching network therefore lost them
permanently, and the Receive screen failed with *"not stored for &lt;network&gt;"* for a
wallet whose addresses were perfectly derivable.

The repair is **re-derivation, never a row copy** — an address's HRP is fixed when
it is derived (`mn_addr1…` mainnet, `mn_addr_preprod1…` preprod), so a copied row
is an address of the wrong network that the indexer rejects outright.

Shape worth reusing:

- **Idempotent per unit**, so it can run on every pass without a "has it run?" flag —
  `ensureMidnightReceiveAddresses` skips any network whose canonical row exists and
  returns only what it wrote.
- **Triggered where a secret is already in hand**, never by prompting. It hangs off
  the shielded sync's existing vault read (`useMidnightSync`), so the repair costs
  the user nothing.
- **Failure is non-fatal and logged.** A repair that cannot run must not take the
  caller down with it, and must not be silent either — a skipped backfill and one
  that never ran are otherwise indistinguishable.

## Adding a migration — playbook

1. **Bump `currentVersion`** on the blob's `MigrationConfig`.
2. **Add the migration step** as a pure function:
   - File location: colocated with the owning package. E.g. `app/src/services/address-book-migrations/v1-to-v2.ts`.
   - No Effect, no I/O, no async — just `(prev: PrevShape) => NextShape`.
   - Throw (or return an invalid shape) if the input doesn't match what you expect. The framework will quarantine.
3. **Update the `validate` guard** to match the new shape (drop checks for removed fields, add them for new ones).
4. **Fixtures + test.** Add `fixtures/blob-v{N}.json` and `fixtures/blob-v{N+1}.json`. Write a round-trip test: `migrate(vN_fixture)` deep-equals `v{N+1}_fixture`.
5. **Ship.** The first load after deploy runs the migration silently per user. Sentry will report `migrated` / `quarantined` outcomes through the `onOutcome` hook — watch for unexpected `quarantined` spikes.

## Observability

Every `loadVersioned` call fires one of four outcomes through the optional `config.onOutcome` hook:

- `missing` — key not in storage. Normal for first launch.
- `no-op` — already at `currentVersion`. The common path.
- `migrated` — data was on an older version; chain ran successfully. Includes `from`, `to`, `durationMs`.
- `quarantined` — something failed. Includes a `reason` discriminator (`parse-failed` / `unknown-version` / `migration-failed` / `validation-failed`) and `durationMs`.

Wire the hook to `logger`. Because the wallet app's logger forwards to Sentry via transport, this gives you Sentry breadcrumbs + structured logs in one step. See `address-book-service.ts` for the pattern.

**Silence `missing` and `no-op`** — they're the common paths and would drown the signal. Only log `migrated` (info) and `quarantined` (warn).

## Precedents (what inspired these rules)

- **Legacy wallet import migration** (removed in the Pnyx fork) — a one-shot, UI-driven migration across apps, deliberately **outside** this framework. A useful reference for "what NOT to model as a framework migration."
- **CAIP-2 chain-id rollout** (`d0262a5b7`) — schema change we forgone pre-release. Use as a reference for "what a framework-driven migration looks like." See Pattern D above.
- **`WALLET_SNAPSHOT_VERSION`** — invalidate-on-mismatch pattern for re-derivable state. Appropriate when the data can be regenerated; inappropriate when it can't.

## Questions?

If you're unsure whether a change needs a migration — or whether the change is better handled ad hoc — open a thread before implementing. Migrations are load-bearing code on user devices forever; small decisions now compound.
