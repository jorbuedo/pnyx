# @pnyx/migrations

Forward-only, versioned-envelope migrations for persisted data in `@pnyx/storage`.

See the project-level docs for everything else:

- [`docs/STORAGE_MIGRATIONS.md`](../../docs/STORAGE_MIGRATIONS.md) — playbook for adding a migration.
- [`docs/MIGRATIONS_ARCHITECTURE.md`](../../docs/MIGRATIONS_ARCHITECTURE.md) — narrative walk-through of the framework internals.
- [`docs/STORAGE_KEYS.md`](../../docs/STORAGE_KEYS.md) — inventory of every persisted key in the app.

## Running the tests

Some tests import `@pnyx/storage/memory`, which resolves through the workspace's built `dist/`. A clean clone needs one `bun install` + `bunx tsc -b packages/storage/tsconfig.build.json` before `bunx vitest run packages/migrations/` will pass.

## Public API

```ts
import {
  loadVersioned,
  saveVersioned,
  type Migration,
  type MigrationConfig,
  type LoadOutcome,
  MigrationChainError,
  InvalidValueError,
} from '@pnyx/migrations'
```

Everything else (`envelope`, `chain`, `quarantine`) is exported for advanced cases and tests; typical consumers only need the two top-level functions and the types.

## Logging

The framework has two independent channels:

1. **Per-consumer `onOutcome` hook** on `MigrationConfig`. Wire it to your app logger — that's how you see `migrated` / `quarantined` events for *your* blob. See `docs/STORAGE_MIGRATIONS.md` for the standard pattern.

2. **Framework-internal logger** — `logger` exported from the package. Silent by default (no transports). Fires today only when a consumer's `onOutcome` hook throws. Keeping this separate from the consumer's hook means a broken hook doesn't silence the framework's ability to report that fact. Wire it at app init exactly like `portfolioLogger`:

   ```ts
   import {logger as migrationsLogger} from '@pnyx/migrations'
   migrationsLogger.addTransport(consoleTransport)
   migrationsLogger.addTransport(createSentryTransport(Sentry))
   ```

   Without wiring, the logger drops events on the floor — safe for tests, invisible in production. Wire it once, near where `portfolioLogger` is wired, and you'll get both console output in dev and Sentry events in prod for the "broken hook" diagnostic.

### Per-realm wiring (browser extension)

The exported `logger` is a module-level singleton. In the browser extension, each realm (background service worker, content script, popup) instantiates the module independently, so they get *separate* logger instances. Any transport wiring must happen **in every realm** that ends up calling `loadVersioned` / `saveVersioned`. A transport added in the background won't observe events from the popup.

Same trap applies to `portfolioLogger` and every other package-level logger in the codebase — the fix is just to mirror the wiring call in each realm's init.

### Verifying wire-up in tests

Because the default is silent, it's easy to ship code whose logger was never wired. A quick transport-capture test pins the diagnostic without touching Sentry:

```ts
import {logger as migrationsLogger} from '@pnyx/migrations'

const entries: Array<{level: string; message: unknown}> = []
const remove = migrationsLogger.addTransport(({level, message}) => {
  entries.push({level, message})
})
// ...exercise the code path...
expect(entries.some((e) => e.level === 'warn')).toBe(true)
remove()
```

See `load.test.ts` in this package for a full example.
