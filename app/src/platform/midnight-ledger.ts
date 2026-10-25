/**
 * Midnight ledger bootstrap — no-op everywhere except web. Native resolves the
 * curve backend to `@pnyx/midnight-native` (no ledger WASM to load); web uses
 * the `.web.ts` sibling to fetch + instantiate the WASM.
 *
 * @module
 */

export {}
