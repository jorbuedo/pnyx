/**
 * Which address belongs to which wallet — the rule, without the hook around it.
 *
 * Its own module because `useMidnightUnshieldedAddress` reaches `../providers`, which pulls in
 * `expo-router` and cannot be imported under vitest. The rule below is the part with a defect history,
 * so it is the part that has to be testable.
 *
 * @module
 */

/** An address, and the group it was read for. */
export type ResolvedAddress = {readonly groupId: string; readonly address: string | undefined}

/**
 * The address, but only if it belongs to the group being asked about.
 *
 * ⚠️ **A mismatched pair must answer `undefined`, never the other wallet's address.** The hook used to
 * hold a bare address and clear it only on *deselect*, so through a wallet *switch* it reported the
 * previous wallet's address while `groupId` had already moved. Consumers pair the two, and the
 * unshielded one-shot writes its cache by `groupId` — so on device, switching Abandon 12 → Pnyx
 * sponsor, Abandon 12's 8 UTxOs and 38 activity rows were written under the sponsor's key.
 *
 * `undefined` during the gap is not a regression: every caller already treats it as "not known yet",
 * which is the truth.
 */
export const addressForGroup = (
  resolved: ResolvedAddress | undefined,
  groupId: string | undefined,
): string | undefined => (resolved !== undefined && resolved.groupId === groupId ? resolved.address : undefined)
