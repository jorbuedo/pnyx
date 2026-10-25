// Fixed-width byte helpers shared by every contract's client, simulator and fixtures.
//
// Lives apart from any one contract's witnesses because it outlives them: `bytes32` was exported
// from `witnesses.ts` (the `pnyx.compact` binding), which `docs/CONTRACT_MIGRATION.md` deletes.

/** A 32-byte array filled with one value. Deterministic fixture input for tests and preimage dumps. */
export const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)
