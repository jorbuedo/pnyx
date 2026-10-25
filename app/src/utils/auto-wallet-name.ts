/**
 * Auto-generate unique wallet group names.
 *
 * @module
 */

/** Maximum allowed length for a wallet name. */
export const MAX_WALLET_NAME_LENGTH = 40

/**
 * Generate a unique **funds-wallet group** name like "My Wallet", "My Wallet 2", etc.
 * Skips names that already exist in the provided list.
 *
 * ⚠️ Not an account name. Its one caller is the add-wallet run, and the identity is never named at
 * all — it is chosen by avatar and identified by its `pnyx_id`. The old "My Pnyx N" read as the
 * account, which is exactly what made naming a wallet look like naming the identity.
 */
export function generateAutoWalletName(existingGroupNames: readonly string[]): string {
  let n = existingGroupNames.length + 1
  const namesSet = new Set(existingGroupNames)
  let name = n === 1 ? 'My Wallet' : `My Wallet ${n}`
  while (namesSet.has(name)) {
    n++
    name = `My Wallet ${n}`
  }
  return name
}

/**
 * De-duplicate a proposed wallet name against existing names, ensuring the
 * result never exceeds {@link MAX_WALLET_NAME_LENGTH}. When a suffix like
 * " (2)" is needed the base is truncated to make room.
 */
export function dedupeWalletName(proposed: string, existing: readonly string[]): string {
  const taken = new Set(existing)
  const truncated = proposed.slice(0, MAX_WALLET_NAME_LENGTH)
  if (!taken.has(truncated)) return truncated
  let n = 2
  const candidate = (suffix: string) => {
    const base = truncated.slice(0, MAX_WALLET_NAME_LENGTH - suffix.length)
    return `${base}${suffix}`
  }
  while (taken.has(candidate(` (${n})`))) n++
  return candidate(` (${n})`)
}
