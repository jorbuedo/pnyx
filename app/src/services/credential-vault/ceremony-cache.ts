/**
 * In-memory cache of decrypted seed material, scoped to an open ceremony and
 * dropped the moment the last one closes.
 *
 * Without it, every call to `enclave.retrieve` fires a fresh OS biometric /
 * passcode prompt, because the keychain item is gated by
 * `BIOMETRY_ANY_OR_DEVICE_PASSCODE`. A single operation that needs the seed more
 * than once (sign, then derive a second witness) would authenticate the user
 * twice for one intent, when the first prompt already proved presence.
 *
 * So the cache exists to make **one user intent cost one authentication** — and
 * nothing more than that.
 *
 * ### Lifetime model
 *
 * The lifetime is **bounded by ceremony close, not by a clock.** When the last
 * token for a group is released the entry is deleted immediately: no material
 * survives the operation the user authenticated for.
 *
 * This replaced a 5-minute survives-close TTL (removed 2026-07-26, dev-lead
 * decision). That TTL let a *later, separate* flow read the cached seed with no
 * biometric, and its stated justification was a card-onboarding funnel of three
 * separately-authenticated taps — a feature that no longer exists, so the doc was
 * justifying the behaviour with a deleted consumer.
 *
 * The threat it removes is not extraction. An in-realm attacker can open a
 * ceremony either way, which the old note correctly observed. It is **consent
 * fatigue**: with a rolling window, a user could be walked through several
 * signatures on taps alone, with no re-authentication anywhere to make them
 * pause. Removing it does not make consent safe on its own — a biometric proves
 * presence, never approval of specific bytes, so approval has to come from the
 * review (Phase 16 item 41). It removes the window in which no prompt appears
 * at all.
 *
 * State machine for a single `groupId`:
 *
 *   no entry ──beginCeremony──> tokens=1
 *                                │
 *                  setCachedMaterial (within ceremony)
 *                                │
 *                                ▼
 *                          tokens=1, values populated
 *                                │
 *                    close() (last token)
 *                                │
 *                                ▼
 *                          entry deleted (no value, no entry)
 *
 * Nested / concurrent ceremonies on the same group share the entry, so the
 * material lives exactly as long as the outermost one.
 *
 * ### Boundaries
 *
 * - **Writes** are gated on `isCeremonyActive(groupId)`. Code paths that don't
 *   `beginCeremony(...)` first can't populate the cache — the keychain prompt
 *   fires as before.
 * - **Reads** are gated the same way, and now no value outlives its ceremony, so
 *   there is no between-ceremonies state to read.
 * - The cache is keyed by `(groupId, kind)`. `kind` matches the keychain
 *   namespace (`'mnemonic'` vs `'xpriv'`) so an xpriv retrieve never returns a
 *   value populated by a sibling `retrieve` on the same group.
 * - The handle returned by `beginCeremony` MUST be closed in a `finally` block.
 *   A leaked open token keeps the material alive until `clearAllCeremonies()`
 *   fires (AppState→background, logout) — bounded by app lifecycle. That is now
 *   the *only* way material outlives an operation, which makes the `finally`
 *   discipline load-bearing rather than tidy.
 *
 * ### Security stance
 *
 * The mnemonic lives in the JS heap as a string while the cache holds it, and JS
 * string immutability prevents zeroing — so the bound is the entry's lifetime,
 * which is now the operation itself. Derived-object slots (e.g. a session signer
 * holding derived private keys) share the profile: the whole entry is evicted
 * together, so derived keys never outlive the seed they came from.
 *
 * @module
 */

/**
 * Identifies which keychain namespace a cached value belongs to. Must
 * match 1-to-1 with the service-prefix split in {@link ./enclave-vault.ts}
 * (`@pnyx/mnemonic/...` vs `@pnyx/xpriv/...`) so a misnamed kind
 * can never alias a real keychain item.
 */
export type MaterialKind = 'mnemonic' | 'xpriv'

type CachedValue = {
  readonly value: string
  /**
   * Optional credential binding: a read only hits when the guards
   * match. Enclave callers (OS biometric — nothing to re-verify) omit
   * it; the parameter survives for future rails that gate a cached
   * value on a caller-supplied secret.
   */
  readonly guard: string | undefined
}

type CacheEntry = {
  /**
   * Set of active ceremony tokens. The entry lives exactly as long as this
   * set is non-empty — emptying it deletes the entry and its material.
   */
  readonly tokens: Set<symbol>
  /**
   * Per-material slot. `mnemonic` and `xpriv` are stored independently
   * so an xpriv retrieve never returns a value populated
   * by a sibling `retrieve` (or vice-versa). Both slots share the
   * entry's lifetime — they belong to the same biometric grant.
   */
  readonly values: Map<MaterialKind, CachedValue>
  /**
   * Derived-object slots (e.g. a session EVM signer holding its derived
   * wallet). Same read/write gating, guard semantics, and lifetime as
   * `values` — the whole entry is dropped together on close / clear.
   */
  readonly objects: Map<string, {readonly value: unknown; readonly guard: string | undefined}>
}

const cache = new Map<string, CacheEntry>()

/**
 * Handle returned by {@link beginCeremony}. Call `close()` to release
 * this ceremony's write grant. When the last ceremony for a group
 * closes the cached material is dropped immediately, so a follow-up
 * flow authenticates again.
 */
export type CeremonyHandle = {
  /** Stable opaque id for this ceremony. Used as the pending-mount registry key. */
  readonly ceremonyId: string
  readonly groupId: string
  /** Release this token. Safe to call multiple times. */
  readonly close: () => void
}

let nextCeremonySeq = 1
const newCeremonyId = (groupId: string): string => {
  const seq = nextCeremonySeq++
  return `${groupId}#${seq}`
}

/**
 * Open a ceremony for `groupId`. The vault is now permitted to cache
 * and read decrypted seed material under this group, for as long as
 * this ceremony (or a concurrently-open sibling) stays open.
 *
 * Nesting is still adopted: a ceremony opened while another is already
 * open shares the entry, which is what lets one authentication cover
 * several retrieves inside a single user-intended operation.
 */
export const beginCeremony = (groupId: string): CeremonyHandle => {
  const token = Symbol(`ceremony:${groupId}`)
  const existing = cache.get(groupId)
  if (existing) {
    existing.tokens.add(token)
  } else {
    cache.set(groupId, {
      tokens: new Set([token]),
      values: new Map(),
      objects: new Map(),
    })
  }

  let closed = false
  const ceremonyId = newCeremonyId(groupId)
  return {
    ceremonyId,
    groupId,
    close: () => {
      if (closed) return
      closed = true
      const entry = cache.get(groupId)
      if (!entry) return
      entry.tokens.delete(token)
      // Last ceremony closing → drop the material now. Nothing survives
      // the operation the user authenticated for.
      if (entry.tokens.size === 0) cache.delete(groupId)
    },
  }
}

/**
 * `true` when at least one ceremony is open for `groupId`. The vault
 * uses this to decide whether it's allowed to populate / consume the
 * cache.
 */
export const isCeremonyActive = (groupId: string): boolean => {
  const entry = cache.get(groupId)
  return entry !== undefined && entry.tokens.size > 0
}

/**
 * Return the cached seed material for `(groupId, kind)`, or `null` if
 * missing / no ceremony is currently active.
 *
 * `kind` MUST match the keychain namespace the caller would otherwise
 * read from — passing `'mnemonic'` returns only values set under that
 * kind, never an xpriv stored under the same `groupId`.
 *
 * The read gate (`tokens.size > 0`) is preserved even when the value
 * is present from a prior ceremony — callers without an open ceremony
 * always see `null`.
 */
export const getCachedMaterial = (groupId: string, kind: MaterialKind, guard?: string): string | null => {
  const entry = cache.get(groupId)
  if (!entry || entry.tokens.size === 0) return null
  const slot = entry.values.get(kind)
  if (!slot || slot.guard !== guard) return null
  return slot.value
}

/**
 * Store seed material for `(groupId, kind)`. No-op if no ceremony is
 * active for the group — callers that haven't opened a ceremony don't
 * get caching.
 */
export const setCachedMaterial = (groupId: string, kind: MaterialKind, value: string, guard?: string): void => {
  const entry = cache.get(groupId)
  if (!entry || entry.tokens.size === 0) return
  entry.values.set(kind, {value, guard})
}

/**
 * Read a derived-object slot for `(groupId, key)`. Same contract as
 * {@link getCachedMaterial}: requires an active ceremony and a matching
 * guard, returns `null` otherwise.
 */
export const getCachedObject = (groupId: string, key: string, guard?: string): unknown => {
  const entry = cache.get(groupId)
  if (!entry || entry.tokens.size === 0) return null
  const slot = entry.objects.get(key)
  if (!slot || slot.guard !== guard) return null
  return slot.value
}

/**
 * Store a derived object for `(groupId, key)`. Same contract as
 * {@link setCachedMaterial}: no-op without an active ceremony.
 */
export const setCachedObject = (groupId: string, key: string, value: unknown, guard?: string): void => {
  const entry = cache.get(groupId)
  if (!entry || entry.tokens.size === 0) return
  entry.objects.set(key, {value, guard})
}

/**
 * Immediately drop the cached entry for a single `groupId` — values,
 * objects and tokens, even while a ceremony is still open — which is what
 * distinguishes it from `close()`, since close only evicts once the last
 * token is released.
 *
 * Use when a flow must re-authenticate on every user-initiated action even
 * within one open ceremony — e.g. recovery signing fires a fresh biometric
 * prompt on each "Sign" press.
 */
export const evictGroupCeremony = (groupId: string): void => {
  cache.delete(groupId)
}

/**
 * Drop every cached value and every ceremony entry. Called by app
 * lifecycle hooks (AppState→background, logout, etc.). Open ceremony
 * handles can still be `close()`d after this — the call becomes a no-op.
 */
export const clearAllCeremonies = (): void => {
  cache.clear()
}

/**
 * Test-only: inspect cache state without mutating it. Gated behind
 * `NODE_ENV !== 'production'` so the bundler can dead-code-eliminate
 * it in production builds — the cache's internal shape is not part of
 * the public API and shouldn't be discoverable from a shipped binary.
 *
 * Production callers receive `undefined`; tests receive the live view.
 */
export const __cacheInspectForTests:
  | (() => {
      readonly groups: ReadonlyMap<
        string,
        {
          readonly tokenCount: number
          readonly kinds: ReadonlyArray<MaterialKind>
          readonly objectKeys: ReadonlyArray<string>
        }
      >
    })
  | undefined =
  process.env.NODE_ENV === 'production'
    ? undefined
    : () => ({
        groups: new Map(
          Array.from(cache.entries()).map(([groupId, entry]) => [
            groupId,
            {
              tokenCount: entry.tokens.size,
              kinds: Array.from(entry.values.keys()).sort(),
              objectKeys: Array.from(entry.objects.keys()).sort(),
            },
          ]),
        ),
      })
