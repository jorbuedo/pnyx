/**
 * Wallet selection intent resolution.
 *
 * Pure utility — no React or platform dependencies.
 * Single source of truth for the three-way selection semantics
 * shared by WalletProvider (mobile/web) and ExtensionWalletProvider.
 *
 * @module
 */

/**
 * Discriminated union representing wallet selection intents.
 *
 * Global selection is group-only now. Chain is a per-screen filter — the chain
 * pill UI keeps local state and never writes back to the wallet manager.
 *
 * - `deselect` — clear selection entirely
 * - `select-group` — activate a wallet group
 */
export type WalletSelectionIntent =
  | {readonly type: 'deselect'}
  | {readonly type: 'select-group'; readonly groupId: string}

/**
 * Resolves a `selectWallet(groupId)` call into a typed intent. `null` means
 * deselect (back to the "All Blockchains" aggregated view); any string is a
 * group activation.
 */
export function resolveSelectionIntent(groupId: string | null): WalletSelectionIntent {
  if (groupId === null) return {type: 'deselect'}
  return {type: 'select-group', groupId}
}

/**
 * Platform-specific callbacks for wallet selection persistence.
 */
export type WalletSelectionHandlers = {
  /** Clear the UI selection state (set to null / "All Blockchains"). */
  readonly clearSelection: () => void
  /** Persist a group-level selection or deselect. Called with null for deselect, groupId for select-group. */
  readonly persistGroup: (groupId: string | null) => Promise<void>
}

/**
 * Dispatch a resolved intent to the platform handlers.
 *
 * Pure — exposed for testability. The React hook wraps this with its own
 * `updateLastGroupId` state setter; tests pass a plain spy.
 *
 * Invariants:
 * - deselect clears selection and persists null — does NOT touch lastGroupId.
 * - select-group updates lastGroupId BEFORE persisting (so lastGroupId reflects
 *   the target immediately, even if persistGroup rejects).
 */
export async function dispatchSelectionIntent(
  intent: WalletSelectionIntent,
  handlers: WalletSelectionHandlers,
  updateLastGroupId: (groupId: string | null) => void,
): Promise<void> {
  switch (intent.type) {
    case 'deselect': {
      handlers.clearSelection()
      await handlers.persistGroup(null)
      return
    }
    case 'select-group': {
      updateLastGroupId(intent.groupId)
      await handlers.persistGroup(intent.groupId)
      return
    }
  }
}
